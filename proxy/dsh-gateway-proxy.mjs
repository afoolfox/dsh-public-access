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
 *   4. （可选）静态文件映射：设置 DOCS_ROOT 后，把本地目录通过 /docs 暴露，
 *      同样受认证保护 —— 用于把"本地生成的文档/产物"映射到公网访问。
 *   5. DSH 0.1.5+ launch token：新版每次启动生成一次性登录 token，
 *      反代在收到 401 时自动读取当前 token 重试一次，公网地址无需手动带 ?token=。
 *
 * 用法：
 *   AUTH_USER=<用户名> AUTH_PASS=<密码> \
 *   [DOCS_ROOT=/本地/文档目录] [DOCS_PREFIX=/docs] [DOCS_TITLE=标题] \
 *   [DSH_WEB_LOG=/tmp/dsh-web.log] \
 *   node dsh-gateway-proxy.mjs [listenPort] [targetHost] [targetPort]
 *   默认: 127.0.0.1:3099 -> 127.0.0.1:3080
 *
 * 要求：Node.js >= 18
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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

// ===== DSH 0.1.5+ launch token 适配 =====
// 新版 dsh web 每次启动生成一次性 token，浏览器需先访问 /?token=<token> 换取会话 Cookie。
// 该 token 只出现在启动日志里，反代在此读取它，并在上游返回 401 时自动重试。
const DSH_WEB_LOG = process.env.DSH_WEB_LOG ?? "/tmp/dsh-web.log";
let tokenCache = { value: undefined, at: 0 };

/** 读取日志中最后一次出现的 launch token（仅读末尾 256KB，带 5 秒缓存）。 */
function readLaunchToken(fresh = false) {
  const now = Date.now();
  if (!fresh && tokenCache.value !== undefined && now - tokenCache.at < 5000) return tokenCache.value;
  try {
    const fd = fs.openSync(DSH_WEB_LOG, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 262144);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const matches = [...buf.toString("utf8").matchAll(/[?&]token=([A-Za-z0-9_-]{8,})/g)];
    const value = matches.length > 0 ? matches[matches.length - 1][1] : undefined;
    tokenCache = { value, at: now };
    return value;
  } catch {
    return undefined;
  }
}

// ===== 可选：静态文件映射（本地生成文件 → 公网） =====
const DOCS_ROOT = process.env.DOCS_ROOT; // 例：/Users/you/docs；不设置则关闭该功能
const DOCS_PREFIX = process.env.DOCS_PREFIX ?? "/docs";
const DOCS_TITLE = process.env.DOCS_TITLE ?? "Docs";
const DOCS_MIME = {
  ".md": "text/markdown; charset=utf-8",
  ".pdf": "application/pdf",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

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
  // 向上游索取未压缩内容：DSH 按 Accept-Encoding 压缩，而反代要往 HTML 里注入
  // polyfill，压缩流无法安全拼接。Cloudflare 边缘会按浏览器能力重新压缩。
  delete out["accept-encoding"];
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
  // 上游未接受升级（返回普通 HTTP 响应）时，把响应原样回给客户端后关闭
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
    console.error("[proxy] upgrade error:", err.message);
    // 上游挂断升级请求时回明确的 502，避免客户端收到空响应
    try {
      socket.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    } catch {}
    socket.destroy();
  });
  proxy.end();
}

/** 转发 HTTP 请求；allowTokenRetry=true 时遇 401 会带上当前 launch token 重试一次。 */
function forwardHttp(req, res, authMode, reqPath, allowTokenRetry) {
  const options = {
    host: TARGET_HOST,
    port: TARGET_PORT,
    method: req.method,
    path: reqPath,
    headers: rewriteHeaders(req.headers),
  };
  const proxy = http.request(options, async (pRes) => {
    // 0.1.5+ launch token：无有效会话 Cookie 时 DSH 返回 401，
    // 自动读取当前 token 重试一次（对浏览器透明，DSH 重启后自动跟随新 token）
    if (
      allowTokenRetry &&
      pRes.statusCode === 401 &&
      (req.method === "GET" || req.method === "HEAD") &&
      !/[?&]token=/.test(reqPath)
    ) {
      const token = readLaunchToken(true);
      if (token !== undefined) {
        pRes.resume();
        const sep = reqPath.includes("?") ? "&" : "?";
        console.log(`[proxy] 401 → 自动携带 launch token 重试: ${reqPath}`);
        forwardHttp(req, res, authMode, `${reqPath}${sep}token=${encodeURIComponent(token)}`, false);
        return;
      }
    }
    const headers = { ...pRes.headers };
    // 首次用 Basic 认证成功 → 附带下发会话 Cookie
    if (authMode === "basic") {
      const existing = headers["set-cookie"];
      headers["set-cookie"] = existing
        ? (Array.isArray(existing) ? existing : [existing]).concat(COOKIE_VALUE)
        : [COOKIE_VALUE];
    }
    const ctype = (pRes.headers["content-type"] ?? "").toString();
    if (ctype.includes("text/html") && pRes.headers["content-encoding"] === undefined) {
      // 仅对未压缩的 HTML 注入 polyfill；万一上游仍返回压缩内容则原样透传，避免破坏页面
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
  if (req.method === "GET" || req.method === "HEAD") proxy.end();
  else req.pipe(proxy);
}

/** 静态文件映射：DOCS_PREFIX → DOCS_ROOT；返回 true 表示已处理。 */
function serveDocs(req, res) {
  if (!DOCS_ROOT) return false;
  const prefix = DOCS_PREFIX.endsWith("/") ? DOCS_PREFIX.slice(0, -1) : DOCS_PREFIX;
  if (req.url !== prefix && !req.url.startsWith(prefix + "/")) return false;

  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, "http://x").pathname.slice(prefix.length));
  } catch {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("bad request");
    return true;
  }

  // 目录列表
  if (rel === "" || rel === "/") {
    let items;
    try {
      items = fs.readdirSync(DOCS_ROOT).filter((f) => !f.startsWith("."));
    } catch {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("cannot read docs root");
      return true;
    }
    const links = items
      .map((f) => `<li><a href="${prefix}/${encodeURIComponent(f)}">${f}</a></li>`)
      .join("");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>${DOCS_TITLE}</title><h2>${DOCS_TITLE}</h2><ul>${links}</ul>`
    );
    return true;
  }

  // 路径穿越防护：解析后必须仍在 DOCS_ROOT 内
  const filePath = path.resolve(DOCS_ROOT, "." + rel);
  if (!filePath.startsWith(DOCS_ROOT + path.sep)) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("forbidden");
    return true;
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return true;
  }
  if (!stat.isFile()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return true;
  }

  const ext = path.extname(filePath).toLowerCase();
  const ctype = DOCS_MIME[ext] ?? "application/octet-stream";
  // PDF 内联预览，其余作为附件下载（UTF-8 文件名）
  const disposition =
    ext === ".pdf"
      ? "inline"
      : `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`;
  res.writeHead(200, {
    "content-type": ctype,
    "content-length": stat.size,
    "content-disposition": disposition,
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
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

  // 静态文件映射（同样走认证）
  if (serveDocs(req, res)) return;

  forwardHttp(req, res, status, req.url, true);
});

server.on("upgrade", forwardUpgrade);

server.listen(LISTEN_PORT, "127.0.0.1", () => {
  console.log(`[proxy] listening http://127.0.0.1:${LISTEN_PORT} -> ${TARGET_AUTHORITY} (auth: ${AUTH_USER})`);
  if (DOCS_ROOT) console.log(`[proxy] 静态文件映射: ${DOCS_PREFIX} -> ${DOCS_ROOT}`);
  console.log(`[proxy] launch token 日志: ${DSH_WEB_LOG}`);
});
