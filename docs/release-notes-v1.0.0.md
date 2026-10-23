# v1.0.0 — 让 DSH 从「只能本机用」变成「在哪都能用」

**一句话**：给 DeepSeek Harness 的 Web 控制台加一条「自有域名 + 认证 + Cloudflare 隧道」的安全公网通道——手机能开，登录自启，重启自愈。

DSH 默认只监听 `127.0.0.1:3080`，并且用 Host 信任围栏挡住所有非回环来源；官方没有提供远程访问方案。直接套隧道会连续撞上 7 个没有任何文档的坑，这个版本把它们全部填平了。

## 包含什么

| 能力 | 说明 |
|---|---|
| **认证反代** | Basic Auth 首次校验 → 会话 Cookie，之后不再反复弹窗（含 WebSocket） |
| **头改写** | 把隧道域名改写成回环 authority，通过 `/api` 信任围栏（DNS 重绑定防护） |
| **launch token 适配** | DSH 0.1.5+ 每次启动换 token，反代自动读取并重试，公网地址书签不用改 |
| **老浏览器兜底** | 注入 `crypto.randomUUID` polyfill，兼容老手机 WebView |
| **静态文件映射** | 可选 `/docs`：把本地生成物通过公网分享给已认证用户，带路径穿越防护 |
| **launchd 三服务** | DSH / 反代 / 隧道 登录自启 + 崩溃自愈 |
| **NAS 网关** | `nas-gateway-proxy.mjs`：纯转发场景（Range、WebSocket 原样透传） |

## 5 分钟验证

```bash
brew install node cloudflared
cloudflared tunnel login && cloudflared tunnel create dsh
cp cloudflared/config.example.yml ~/.cloudflared/config.yml   # 填 tunnel ID / 用户 / 域名
AUTH_USER=you AUTH_PASS='强密码' node proxy/dsh-gateway-proxy.mjs &
cloudflared tunnel route dns dsh dsh.example.com
cloudflared tunnel run dsh
```

```bash
curl -s -u you:'强密码' -o /dev/null -w '%{http_code}\n' https://dsh.example.com/   # 200
curl -s -o /dev/null -w '%{http_code}\n' https://dsh.example.com/                    # 401
```

## 升级 / 迁移提示

- 从「手动跑脚本」迁到 launchd：`bash scripts/switch-to-autostart.sh`（会先停掉手动进程再加载服务并自动验证）。
- DSH 升级到 0.1.5 及以上后如果页面停在 `dsh web authentication required`：确认 `DSH_WEB_LOG` 指向 `dsh web` 真实日志，重启反代即可。
- 隧道 `ingress` 必须指向反代的 **3099**，不是 DSH 的 3080——这是最常见的"页面能开但没数据"。

## 已知限制

- 单密码模式，没有多用户与权限隔离；多人共用请叠加 Cloudflare Access。
- 自启脚本仅 macOS；Linux/Windows 待社区补充。
- Cloudflare 免费档需要整域 NS 接入。

## 安全

这个 GUI 背后是等效 RCE 的 Agent 控制台。**认证层是唯一防线**，请用强密码并优先叠加 Cloudflare Access。安全问题请走私密渠道，见 [SECURITY.md](../SECURITY.md)。

---

**Full changelog**: [CHANGELOG.md](../CHANGELOG.md) · **License**: MIT
