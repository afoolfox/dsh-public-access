# Handoff：把局域网 NAS（媒体库）安全发布到公网

> 这是一份**交接说明**，交给"能访问该 NAS 的那台机器上的 DSH"执行。
> 本机与 NAS 不在同一局域网，因此必须由你所在的那台机器完成部署。

## 背景

另一台机器已用同一套模式把 DeepSeek Harness 发布到了公网（Cloudflare Tunnel + 本地认证反代）。
现在需要在**你所在的这台机器**上，为**同一局域网内的 NAS**做同样的事。NAS 与该 DSH 无关，**独立部署、独立隧道、独立进程**。

## 环境事实（执行前先确认/替换）

| 项 | 值 |
|---|---|
| NAS 地址 | `http://<NAS_IP>:8000`（固定 IP，**HTTP**，无 TLS） |
| 可达性 | 你（本机）与 NAS 同局域网，应能直接 `curl -I http://<NAS_IP>:8000` |
| 公网域名 | `<NAS_HOST>`，例如 `media.example.com`（Cloudflare 账号已托管该域名的 NS） |
| 认证凭据 | 用户名 `<USER>` / 强密码 `<PASS>`（公网入口的唯一凭证） |
| Cookie 共享 | 若希望与已有入口共用登录：`COOKIE_NAME=dsh_auth` + `COOKIE_DOMAIN=.example.com`；否则省略 |

## 参照实现（公开仓库）

```
https://github.com/afoolfox/dsh-public-access
```

- `proxy/nas-gateway-proxy.mjs` —— **本次要用的反代**（纯流式转发，已剥离 DSH 专属逻辑）
- `cloudflared/config.example.yml` —— 隧道配置模板
- `launchd/*.plist` —— macOS 开机自启模板（如需自启）
- `README.md` —— 背景与踩坑记录（多数是 DSH 专属，NAS 场景不需要）

> **GitHub 不通时**：在原始 URL 前加加速前缀，例如
> `https://ghfast.top/https://raw.githubusercontent.com/afoolfox/dsh-public-access/main/proxy/nas-gateway-proxy.mjs`
> （`ghfast.top`、`gh-proxy.com` 可互换；也可直接让 DSH 按下方"反代行为要求"自行实现，代码不到 200 行）

## 执行步骤

```bash
# 1. 前置检查
node --version            # 需 >= 18
which cloudflared || brew install cloudflared
curl -sI --max-time 5 http://<NAS_IP>:8000 | head -1     # 确认 NAS 可达（期望 HTTP/1.x 200/302/401）

# 2. 创建隧道（浏览器会打开，授权你自己的 Cloudflare 账号并选择目标域名）
cloudflared tunnel login
cloudflared tunnel create nas

# 3. 写 ~/.cloudflared/nas.yml
#    tunnel: <上一步输出的 UUID>
#    credentials-file: /Users/<你>/.cloudflared/<UUID>.json
#    ingress:
#      - hostname: <NAS_HOST>
#        service: http://127.0.0.1:3098      # 指向反代，绝不直连 NAS
#      - service: http_status:404

# 4. 取反代脚本（或按"行为要求"自行实现）
curl -L -o nas-gateway-proxy.mjs "<仓库或加速地址>"

# 5. 试运行（前台，先验证再常驻）
AUTH_USER=<USER> AUTH_PASS='<PASS>' TARGET=http://<NAS_IP>:8000 \
  [COOKIE_NAME=dsh_auth] [COOKIE_DOMAIN=.example.com] \
  node nas-gateway-proxy.mjs          # 监听 127.0.0.1:3098

# 6. 建 DNS 路由
cloudflared tunnel route dns nas <NAS_HOST>

# 7. 起隧道（另一个终端）
cloudflared tunnel run nas
```

## 反代行为要求（若自行实现，必须满足）

1. **认证**：HTTP Basic Auth 首次 → 下发会话 Cookie；之后 Cookie 认证（避免浏览器对子资源反复弹框）。未认证一律 401 + `WWW-Authenticate`。
2. **流式转发**：响应体**不得缓冲**，一律 pipe；这决定大文件下载和视频拖动是否可用。
3. **保留原始 Host**（不要改写成 LAN 地址）：媒体应用常据此生成绝对 URL；同时补 `X-Forwarded-Proto: https`、`X-Forwarded-Host`、`X-Forwarded-For`。
4. **透传**：`Range` / `Content-Range` / `Accept-Ranges` / `ETag` / `Last-Modified`、WebSocket 升级、以及原始 `Accept-Encoding`（**不要**像 DSH 那套一样删掉它）。
5. 客户端断开时销毁上游连接；不要设置会中断长下载的服务端超时。

## 验证清单（必须逐项实测并回报原始输出）

```bash
U=https://<NAS_HOST>; P=<USER>:<PASS>

# a) 无凭据被拒（期望 401）
curl -s -o /dev/null -w '%{http_code}\n' "$U/"
# b) 带凭据、跟随跳转（期望最终 200，且页面标题/内容正常）
curl -sL -u $P -c /tmp/c -b /tmp/c -o /tmp/h.html -w '%{http_code} %{size_download}\n' "$U/"
# c) Range 支持（期望 206 + Content-Range；媒体拖动必需）
curl -s -u $P -o /dev/null -D - -H 'Range: bytes=0-1023' "$U/<某个可下载文件>" | grep -iE 'HTTP/|content-range|accept-ranges'
# d) WebSocket（若应用使用；期望 101）
curl --http1.1 -s -u $P -o /dev/null -w '%{http_code}\n' --max-time 8 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==' -H "Origin: $U" "$U/<应用的 ws 路径>"
# e) 大文件下载（>100MB，观察是否被截断/限速）
```

## 红线与已知限制

- ❌ **不要**给媒体路径在 Cloudflare 上加缓存规则：内容受反代认证保护，边缘缓存可能绕过认证被别人拉走。
- ⚠️ **Cloudflare 免费版请求体上限 100MB**：从外网**上传**超 100MB 会失败（下载不受限）。
- ⚠️ **流媒体大流量**可能触及 Cloudflare 免费版使用条款限制（非技术问题，必要时考虑 Tailscale/ZeroTier 等点对点方案）。
- ⚠️ **带宽瓶颈是本机所在网络的上行带宽**：视频码率过高会卡；可让 NAS 转码降码率。
- ⚠️ Cookie 若设 `Domain=.example.com`，该域下**所有子域都会收到**这枚令牌；确认没有第三方子域。
- 🔒 密码只走环境变量 / launchd plist，**不要写进任何提交的文件**。

## 开机自启（可选，macOS）

参照仓库 `launchd/` 下两个 plist 模板，建立：
- `com.nas.proxy` → `AUTH_USER/AUTH_PASS/TARGET/COOKIE_*` + `node …/nas-gateway-proxy.mjs`
- `com.nas.tunnel` → `cloudflared tunnel run nas`

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nas.proxy.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nas.tunnel.plist
```

## 回滚

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.nas.proxy.plist
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.nas.tunnel.plist
cloudflared tunnel delete nas          # 删除隧道
# 再到 Cloudflare DNS 面板删除 <NAS_HOST> 的 CNAME 记录
```

## 回报格式

1. 公网地址：`https://<NAS_HOST>`
2. 验证结果：a–e 各项的**原始命令输出**（尤其是 401/200/206/101 与 Range 头）
3. 部署方式：反代监听端口、隧道名、是否已配自启
4. 遇到的问题与最终处理
