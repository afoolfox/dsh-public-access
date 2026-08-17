#!/usr/bin/env node
/**
 * dsh-gateway-proxy —— DeepSeek Harness 公网网关反代
 *
 * 作用（放在 Cloudflare Tunnel 与 DSH 之间）：
 *   1. 认证：HTTP Basic Auth（首次）→ 下发会话 Cookie → 之后 Cookie 认证，
 *      避免浏览器对子资源/WebSocket 反复弹登录框（Basic Auth 经典缺陷）。
 *   2. 头改写：把 Host / Origin 改写为 127.0.0.1:3080，绕过 DSH 内置的
 *      "/api 浏览器信任围栏"（DNS 重绑定/跨站防护，只认回环 Host）。
 *   3. Polyfill：向 HTML 注入 crypto.randomUUID polyfill，兼容老浏览器/WebView。
 *
 * 用法：
 *   AUTH_USER=<用户名> AUTH_PASS=<密码> node dsh-gateway-proxy.mjs [listenPort] [targetHost] [targetPort]
 *   默认: 127.0.0.1:3099 -> 127.0.0.1:3080
 *
 * 要求：Node.js >= 18
 */
import http from "node:http";
import crypto from "node:crypto";

const AUTH_USER = process.env.AUTH_USER;
const AUTH_PASS = process.env.AUTH_PASS;
if (!AUTH_USER || !AUTH_PASS) {
  console.error("[proxy] 必须设置环境变量 AUTH_USER 和 AUTH_PASS（公网访问的唯一凭证，请用强密码）");
  process.exit(1);
}

const LISTEN_PORT = Number(process.argv[2] ?? process.env.LISTEN_PORT ?? 3099);
const TARGET_HOST = process.argv[3] ?? "127.0.0.1";
const TARGET_PORT = Number(process.argv[4] ?? process.env.TARGET_PORT ?? 3080);
const TARGET_AUTHORITY = `${TARGET_HOST}:${TARGET_PORT}`;
const TARGET_ORIGIN = `http://${TARGET_AUTHORITY}`;
const AUTH_REALM = "DSH";
const EXPECTED = `${AUTH_USER}:${AUTH_PASS}`;

// 会话 Cookie：由凭据派生的固定 token，登录后随响应下发（30 天有效）
const COOKIE_NAME = "dsh_auth";
const COOKIE_TOKEN = crypto.createHash("sha256").update(EXPECTED).digest("hex");
const COOKIE_VALUE = `${COOKIE_NAME}=${COOKIE_TOKEN}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`;
const COOKIE_RE = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`);

// crypto.randomUUID polyfill（Chrome/Edge 92+ 才有；老浏览器/WebView 缺它会导致 DSH 白屏）
const POLYFILL = `(function(){if(window.crypto&&!window.crypto.randomUUID){var r=function(b){return(b^(crypto.getRandomValues(new Uint8Array(1))[0]&15>>b/4)).toString(16)};window.crypto.randomUUID=function(){return([1e7]+-1e3+-4e3+-8e3+-1e7).replace(/[018]/g,r)}}})();`;

function basicOk(headers) {
  const auth = headers.authorization;
  if (!auth) return false;
  const [scheme, b64] = auth.split(" ");
  if (scheme?.toLowerCase() !== "basic" || !b64) return false;
  let decoded;
  try {
    decoded = Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return false;
  }
  return decoded === EXPECTED;
}

function cookieOk(headers) {
  const m = COOKIE_RE.exec(headers.cookie ?? "");
  return !!m && m[1] === COOKIE_TOKEN;
}

// 返回 'cookie' | 'basic' | null
function authStatus(headers) {
  if (cookieOk(headers)) return "cookie";
  if (basicOk(headers)) return "basic";
  return null;
}

function rewriteHeaders(headers) {
  const out = { ...headers };
  out.host = TARGET_AUTHORITY;
  if (out.origin !== undefined) out.origin = TARGET_ORIGIN;
  return out;
}

function deny(socket) {
  socket.write(
    "HTTP/1.1 401 Unauthorized\r\n" +
      `WWW-Authenticate: Basic realm="${AUTH_REALM}"\r\n` +
      "Content-Length: 0\r\n\r\n"
  );
  socket.destroy();
}

function forwardUpgrade(req, socket, head) {
  const status = authStatus(req.headers);
  if (!status) return deny(socket);
  const options = {
    host: TARGET_HOST,
    port: TARGET_PORT,
    method: req.method,
    path: req.url,
    headers: rewriteHeaders(req.headers),
  };
  const proxy = http.request(options);
  proxy.on("upgrade", (pRes, pSocket, pHead) => {
    socket.write(`HTTP/1.1 ${pRes.statusCode} ${pRes.statusMessage || ""}\r\n`);
    for (const [k, v] of Object.entries(pRes.headers)) {
      if (Array.isArray(v)) for (const item of v) socket.write(`${k}: ${item}\r\n`);
      else socket.write(`${k}: ${v}\r\n`);
    }
    if (status === "basic") socket.write(`Set-Cookie: ${COOKIE_VALUE}\r\n`);
    socket.write("\r\n");
    if (head?.length) socket.unshift(head);
    if (pHead?.length) pSocket.unshift(pHead);
    pSocket.pipe(socket);
    socket.pipe(pSocket);
    socket.on("error", () => pSocket.destroy());
    pSocket.on("error", () => socket.destroy());
  });
  proxy.on("error", (err) => {
    console.error("[proxy] upgrade error:", err.message);
    socket.destroy();
  });
  proxy.end();
}

const server = http.createServer((req, res) => {
  const status = authStatus(req.headers);
  if (!status) {
    res.writeHead(401, {
      "WWW-Authenticate": `Basic realm="${AUTH_REALM}"`,
      "Content-Type": "text/plain",
      "Cache-Control": "no-store",
    });
    res.end("unauthorized");
    return;
  }
  const options = {
    host: TARGET_HOST,
    port: TARGET_PORT,
    method: req.method,
    path: req.url,
    headers: rewriteHeaders(req.headers),
  };
  const proxy = http.request(options, async (pRes) => {
    const headers = { ...pRes.headers };
    // 首次用 Basic 认证成功 → 附带下发会话 Cookie
    if (status === "basic") {
      const existing = headers["set-cookie"];
      headers["set-cookie"] = existing
        ? (Array.isArray(existing) ? existing : [existing]).concat(COOKIE_VALUE)
        : [COOKIE_VALUE];
    }
    const ctype = (pRes.headers["content-type"] ?? "").toString();
    if (ctype.includes("text/html")) {
      // 收集 HTML 全文 → 注入 polyfill（老浏览器缺 crypto.randomUUID 会白屏）
      let body = "";
      for await (const chunk of pRes) body += chunk;
      const injected = `<script>${POLYFILL}</script>`;
      if (body.includes("</head>")) body = body.replace("</head>", `${injected}</head>`);
      else if (body.includes("<head>")) body = body.replace("<head>", `<head>${injected}`);
      else body = injected + body;
      delete headers["content-length"];
      delete headers["transfer-encoding"];
      res.writeHead(pRes.statusCode, headers);
      res.end(body);
      return;
    }
    res.writeHead(pRes.statusCode, headers);
    pRes.pipe(res);
  });
  proxy.on("error", (err) => {
    console.error("[proxy] request error:", err.message);
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`proxy error: ${err.message}`);
  });
  req.pipe(proxy);
});

server.on("upgrade", forwardUpgrade);

server.listen(LISTEN_PORT, "127.0.0.1", () => {
  console.log(`[proxy] listening http://127.0.0.1:${LISTEN_PORT} -> ${TARGET_AUTHORITY} (auth: ${AUTH_USER})`);
});
