#!/usr/bin/env node
/**
 * nas-gateway-proxy —— 为"普通 Web 应用"（NAS 面板 / 媒体库 / 自建服务）提供带认证的公网入口
 *
 * 与 dsh-gateway-proxy 的区别：这里不做任何 DSH 专属处理。
 *   - 不改写 Host / Origin（保留公网域名，应用据此生成正确的绝对 URL）
 *   - 不注入 polyfill、不删除 Accept-Encoding
 *   - 不缓冲响应体：一律流式转发，Range / WebSocket 原样透传（大文件与视频拖动必需）
 *
 * 用法：
 *   AUTH_USER=<用户名> AUTH_PASS=<密码> TARGET=http://192.168.1.50:8000 \
 *   [COOKIE_NAME=dsh_auth] [COOKIE_DOMAIN=.example.com] \
 *   node nas-gateway-proxy.mjs [listenPort]
 *   默认监听 127.0.0.1:3098，转发到 TARGET
 *
 * 说明：
 *   - 认证与 dsh-gateway-proxy 同构：Basic Auth 首次 → 下发会话 Cookie
 *   - 与 DSH 共用登录：COOKIE_NAME 保持一致、凭据一致，并设置 COOKIE_DOMAIN=.your-domain
 *     （注意：Domain 设成父域后，该域下所有子域都会收到这枚 Cookie）
 *
 * 要求：Node.js >= 18
 */
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";

const AUTH_USER = process.env.AUTH_USER;
const AUTH_PASS = process.env.AUTH_PASS;
const TARGET = process.env.TARGET;
if (!AUTH_USER || !AUTH_PASS) {
  console.error("[nas-proxy] 必须设置 AUTH_USER 和 AUTH_PASS（公网访问的唯一凭证，请用强密码）");
  process.exit(1);
}
if (!TARGET) {
  console.error("[nas-proxy] 必须设置 TARGET，例如 TARGET=http://192.168.1.50:8000");
  process.exit(1);
}

const LISTEN_PORT = Number(process.argv[2] ?? process.env.LISTEN_PORT ?? 3098);
const AUTH_REALM = process.env.AUTH_REALM ?? "NAS";
const EXPECTED = `${AUTH_USER}:${AUTH_PASS}`;

// 与 dsh-gateway-proxy 同名同值即可实现"一次登录，两个入口通用"
const COOKIE_NAME = process.env.COOKIE_NAME ?? "dsh_auth";
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN; // 例：.cyberrt.cn；不设置则为 host-only
const COOKIE_TOKEN = crypto.createHash("sha256").update(EXPECTED).digest("hex");
const COOKIE_VALUE =
  `${COOKIE_NAME}=${COOKIE_TOKEN}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax` +
  (COOKIE_DOMAIN ? `; Domain=${COOKIE_DOMAIN}` : "");
const COOKIE_RE = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`);

// 目标地址解析（http 或 https）
const targetUrl = new URL(TARGET);
const upstream = targetUrl.protocol === "https:" ? https : http;
const TARGET_PORT = Number(targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80));
const TARGET_HOST = targetUrl.hostname;

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

/** 返回 'cookie' | 'basic' | null */
function authStatus(headers) {
  if (cookieOk(headers)) return "cookie";
  if (basicOk(headers)) return "basic";
  return null;
}

/** 转发头：保留原 Host（应用靠它生成绝对 URL），补 X-Forwarded-*，其余原样透传 */
function forwardHeaders(headers, clientIp) {
  const out = { ...headers };
  out["x-forwarded-proto"] = "https"; // 对外的公网入口始终是 HTTPS（Cloudflare 边缘）
  out["x-forwarded-host"] = headers.host ?? "";
  out["x-forwarded-for"] = headers["x-forwarded-for"] ?? clientIp ?? "";
  return out;
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
    headers: forwardHeaders(req.headers, req.socket.remoteAddress),
  };
  const proxy = upstream.request(options, (pRes) => {
    const headers = { ...pRes.headers };
    if (status === "basic") {
      const existing = headers["set-cookie"];
      headers["set-cookie"] = existing
        ? (Array.isArray(existing) ? existing : [existing]).concat(COOKIE_VALUE)
        : [COOKIE_VALUE];
    }
    // 一律流式转发：不缓冲、不改动响应体（Range/大文件必需）
    res.writeHead(pRes.statusCode, headers);
    pRes.pipe(res);
  });
  proxy.on("error", (err) => {
    console.error("[nas-proxy] upstream error:", err.message);
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`upstream error: ${err.message}`);
  });
  // 客户端断开时释放上游连接（媒体长连接场景很常见）
  res.on("close", () => proxy.destroy());
  req.pipe(proxy);
});

// WebSocket / 其它协议升级：原样转发
server.on("upgrade", (req, socket, head) => {
  if (!authStatus(req.headers)) {
    socket.write(
      "HTTP/1.1 401 Unauthorized\r\n" +
        `WWW-Authenticate: Basic realm="${AUTH_REALM}"\r\n` +
        "Content-Length: 0\r\n\r\n"
    );
    socket.destroy();
    return;
  }
  const options = {
    host: TARGET_HOST,
    port: TARGET_PORT,
    method: req.method,
    path: req.url,
    headers: forwardHeaders(req.headers, req.socket.remoteAddress),
  };
  const proxy = upstream.request(options);
  proxy.on("upgrade", (pRes, pSocket, pHead) => {
    socket.write(`HTTP/1.1 ${pRes.statusCode} ${pRes.statusMessage || ""}\r\n`);
    for (const [k, v] of Object.entries(pRes.headers)) {
      if (Array.isArray(v)) for (const item of v) socket.write(`${k}: ${item}\r\n`);
      else socket.write(`${k}: ${v}\r\n`);
    }
    socket.write("\r\n");
    if (head?.length) socket.unshift(head);
    if (pHead?.length) pSocket.unshift(pHead);
    pSocket.pipe(socket);
    socket.pipe(pSocket);
    socket.on("error", () => pSocket.destroy());
    pSocket.on("error", () => socket.destroy());
  });
  proxy.on("response", (pRes) => {
    let raw = `HTTP/1.1 ${pRes.statusCode} ${pRes.statusMessage || ""}\r\n`;
    for (const [k, v] of Object.entries(pRes.headers)) {
      if (Array.isArray(v)) for (const item of v) raw += `${k}: ${item}\r\n`;
      else raw += `${k}: ${v}\r\n`;
    }
    socket.write(raw + "\r\n");
    pRes.pipe(socket);
    pRes.on("end", () => socket.end());
  });
  proxy.on("error", (err) => {
    console.error("[nas-proxy] upgrade error:", err.message);
    try {
      socket.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    } catch {}
    socket.destroy();
  });
  proxy.end();
});

// 媒体长下载/长连接：不因服务端超时被中断
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 72_000;

server.listen(LISTEN_PORT, "127.0.0.1", () => {
  console.log(`[nas-proxy] listening http://127.0.0.1:${LISTEN_PORT} -> ${TARGET} (auth: ${AUTH_USER})`);
  console.log(`[nas-proxy] cookie: ${COOKIE_NAME}${COOKIE_DOMAIN ? ` (Domain=${COOKIE_DOMAIN})` : " (host-only)"}`);
});
