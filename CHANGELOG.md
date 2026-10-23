# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Planned
- Linux `systemd` 单元与 Windows 计划任务（目前仅 macOS launchd）
- DSH 新版本兼容性回归清单（0.2.x 认证/WS 路径变化）
- 一键预检脚本（端口、日志、DNS、证书四类检查）

## [1.0.0] - 2026-10-22

首个公开版本。把一个只能跑在 `127.0.0.1:3080` 的 DSH Web GUI 变成可远程、可移动端访问的服务，且不牺牲认证。

### Added
- **认证反代** `proxy/dsh-gateway-proxy.mjs`：HTTP Basic Auth 首次校验 → 下发签名会话 Cookie → 后续全部走 Cookie，解决浏览器对子资源/WebSocket 反复弹登录框的问题
- **Host/Origin 改写**：将隧道域名的请求改写为回环 authority，通过 DSH 的 `/api` 信任围栏（防 DNS 重绑定）
- **`crypto.randomUUID` polyfill**：向 HTML 注入，兼容老版本手机 WebView / 微信内置浏览器
- **DSH 0.1.5+ launch token 自动重试**：收到 401 时从 `dsh web` 启动日志读取当前一次性 token，带 `?token=` 重试，对浏览器透明
- **静态文件映射 `/docs`**（可选）：目录列表 + 常见 MIME 内联预览，含路径穿越防护，同样受认证保护
- **macOS launchd 三服务**：`com.dsh.web` / `com.dsh.proxy` / `com.dsh.tunnel`，登录自启 + 崩溃自愈
- **一键脚本**：`scripts/start-public.sh`（起反代 + 隧道）、`scripts/switch-to-autostart.sh`（手动 → launchd 切换并自动验证）
- **通用应用网关** `proxy/nas-gateway-proxy.mjs`：NAS / 媒体库等纯转发场景（Range、WebSocket 原样透传）
- **中文 + 英文双语文档**、架构图 `docs/architecture.svg`、NAS 公网发布交接文档

### Security
- 反代默认只监听 `127.0.0.1`，公网唯一入口是 Cloudflare 边缘 + 认证
- `/docs` 内置路径穿越防护（解析后必须仍在 `DOCS_ROOT` 内，越界返回 403）
- `AUTH_USER` / `AUTH_PASS` 仅经环境变量或 launchd plist 注入，仓库不含任何真实凭据

### Known limitations
- 单密码模式，无多用户与权限隔离；多人共用请叠加 Cloudflare Access
- 认证脚本仅覆盖 macOS；Linux / Windows 自启尚未提供
- 依赖 Cloudflare 免费版「整域 NS 接入」，不支持仅委派子域
