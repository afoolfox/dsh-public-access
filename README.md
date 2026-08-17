# DSH Public Access — DeepSeek Harness 公网安全访问方案

让 **DeepSeek Harness Web GUI**（默认只监听 `127.0.0.1:3080` 的 Agent 控制台）可以通过你自己的域名，从**任意设备（含手机）安全地公网访问**，并支持开机自启。

> ⚠️ 安全第一：这个 GUI 背后是**能执行任意命令、读写任意文件的完整 Agent 控制台（等效 RCE）**。本方案默认**绝不裸奔端口**，公网入口必须套一层身份认证。

## 架构

```
你的浏览器（手机/电脑）
      │ HTTPS（Cloudflare 边缘签发证书）
      ▼
Cloudflare 边缘（dsh.your-domain.com，可选叠加 Cloudflare Access 身份认证）
      │ 出站 TLS 隧道（无需公网 IP、无需路由器开端口）
      ▼
cloudflared（本机）────────────────┐
      │                            │
      ▼                            │
认证反代 dsh-gateway-proxy.mjs (127.0.0.1:3099)
      │ ① 认证：Basic Auth 首次 → 会话 Cookie（避免反复弹登录框）
      │ ② 头改写：Host/Origin → 127.0.0.1:3080（绕过 DSH 的 /api 信任围栏）
      │ ③ 注入 crypto.randomUUID polyfill（兼容老浏览器）
      ▼
DeepSeek Harness Web (127.0.0.1:3080)
```

三条 macOS launchd 服务实现**登录自启 + 崩溃自愈**：`com.dsh.web` / `com.dsh.proxy` / `com.dsh.tunnel`。

## 为什么要这套东西（踩坑实录）

| # | 症状 | 根因 | 本方案的处理 |
|---|---|---|---|
| 1 | 页面能开，但历史对话/工作区空白 | DSH 每个 `/api` 请求和 WebSocket 有 **Host 信任围栏**（防 DNS 重绑定/跨站），只认回环 Host，隧道域名被 403 | 反代把 Host/Origin 改写为回环地址 |
| 2 | 白屏，JS 返回 200 但 0 字节 | 安装目录在 OneDrive 同步文件夹，文件被**云占位**，DSH 读取失败静默返回空包 | 把 DSH 移出同步目录；或强制文件落地 |
| 3 | 反复弹登录框"登录个没完" | 浏览器不会把 Basic Auth 凭据自动附加到所有子资源/WebSocket | 反代改为 **Cookie 会话认证** |
| 4 | 老手机浏览器报 `crypto.randomUUID is not a function` | API 版本过老（Chrome/Edge 92+ 才有） | 反代向 HTML 注入 polyfill |
| 5 | 远程无法"添加工作区" | macOS 上 DSH 固定用**原生目录弹窗**选择器，远程浏览器看不到 | 用 `SSH_CONNECTION=1` 启动 DSH，切换为网页浏览式选择器 |

## 快速开始

### 前置条件

- 一个域名，并已在 Cloudflare 免费账号接入（**整域 NS 接入**；Cloudflare 免费档不支持只委派子域）
- 本机 macOS + Homebrew；已安装 `node`、`cloudflared`
  ```bash
  brew install node cloudflared
  ```
- DSH 本体可正常运行（`dsh web` 监听 127.0.0.1:3080）

### 步骤

1. **登录 cloudflared 并建隧道**（会打开浏览器授权你的 Cloudflare 账号和域名）：
   ```bash
   cloudflared tunnel login
   cloudflared tunnel create dsh
   ```

2. **配置反代**（强密码，公网访问的唯一凭证）：
   ```bash
   # 试运行
   AUTH_USER=you AUTH_PASS='超强密码' node proxy/dsh-gateway-proxy.mjs
   ```

3. **配置隧道**：复制 `cloudflared/config.example.yml` 到 `~/.cloudflared/config.yml`，替换隧道 ID、用户名、域名；`ingress` 指向 `http://127.0.0.1:3099`（反代）。

4. **建 DNS 路由 + 启动**：
   ```bash
   cloudflared tunnel route dns dsh dsh.your-domain.com
   bash scripts/start-public.sh
   ```

5. **（强烈推荐）叠加 Cloudflare Access**：Zero Trust → Access → Applications，为 `dsh.your-domain.com` 加"仅我的邮箱"策略，在 Cloudflare 边缘再做一道身份认证。

6. **开机自启**：替换 `launchd/*.plist` 里的占位符后：
   ```bash
   bash scripts/switch-to-autostart.sh   # 停手动进程 → 加载三服务 → 自动验证
   ```

7. **验证**：
   ```bash
   curl -s -u you:密码 -o /dev/null -w '%{http_code}' https://dsh.your-domain.com/   # 200
   curl -s -o /dev/null -w '%{http_code}' https://dsh.your-domain.com/              # 401（无凭据被拒）
   ```

## 安全说明（务必读）

- **认证层是唯一防线**：本方案中 Basic Auth（或 Cloudflare Access）是访问 DSH 的全部门槛。密码必须强、不要外传；`AUTH_PASS` 只通过环境变量/launchd plist 注入，**不要写进 git**。
- 建议**双层**：Cloudflare Access（邮箱验证码）+ 反代密码。
- DSH 的 `/api` 信任围栏被反代改写绕过——这是有意的（反代承担了认证职责），但意味着**不要移除反代直接暴露端口**。
- 反代只监听 `127.0.0.1`；公网唯一入口是 Cloudflare 边缘 + 认证。

## 国内使用特别说明

- **Cloudflare 免费档只能整域接入**（改主域名 NS）；子域委派 / CNAME 接入是 Enterprise 付费功能。
- 主域名记录保持**灰云（DNS only）**，不经过 Cloudflare 代理，国内解析基本无感；有 ICP 备案的国内站点不受影响（备案绑的是域名+接入商，不是 DNS 商）。
- 改 NS 前如主域名开了 DNSSEC，需先关闭。
- 访问 Cloudflare 面板、下载 GitHub 资源较慢时，可参考：GitHub Release 下载加速镜像（`ghfast.top`、`gh-proxy.com` 前缀拼接原 URL）。
- 手机端建议用系统浏览器；微信等内置 WebView 版本较老（本项目已内置 randomUUID polyfill 兜底）。

## 文件说明

```
proxy/dsh-gateway-proxy.mjs  认证反代（Cookie 会话 + Host/Origin 改写 + polyfill），唯一"业务代码"
cloudflared/config.example.yml  Cloudflare 隧道配置模板
launchd/*.plist               三个 macOS 开机自启服务（DSH/反代/隧道）
scripts/start-public.sh       一键启动反代 + 隧道
scripts/switch-to-autostart.sh 手动 → launchd 自启切换 + 自动验证
```

## 故障排查

- **首页 401/登录框循环** → 检查反代是否在跑（`lsof -iTCP:3099`）；无痕窗口重试。
- **页面 200 但无数据** → 反代是否在链路中（隧道 ingress 必须指向 3099 而非 3080）。
- **白屏/资源 0 字节** → 检查 DSH 安装目录是否有云同步占位文件（`stat -f "%b" 文件` 为 0 即占位）；把 DSH 移出 OneDrive/iCloud 同步目录。
- **WebSocket 连不上** → `curl --http1.1 ... -H "Upgrade: websocket"` 应返回 101；若 401 说明认证层挡了升级请求。
- **隧道 530** → `cloudflared tunnel run dsh` 未运行或 config.yml 的 tunnel ID 不匹配。
- 日志：`/tmp/dsh-web.log` `/tmp/dsh-proxy.log` `/tmp/dsh-tunnel.log`。

## License

MIT
