# 参与贡献 / Contributing

这个仓库只有一份"业务代码"（`proxy/dsh-gateway-proxy.mjs`），其余是文档、模板和启动脚本。改动门槛很低，但有几条规矩值得先看。

## 最有价值的贡献是「新版本又坏了」

DSH 的 Web 端在快速迭代（0.1.1 → 0.1.5 的 launch token、WS 路径从 `/api/events.mux` 变成 `/api/remote.mux`）。**每次上游改动导致链路失效，都是一条真实的路标**：

1. 开 issue 报 DSH 版本 + 报错原文 + 你的定位过程；
2. 顺手把结论补进 README 的「踩坑实录」表（中英文各一行）。

这比任何 star 都有用。

## 提 issue

用 [模板](https://github.com/afoolfox/dsh-public-access/issues/new/choose)：

- **故障** → `bug_report.yml`（要版本、环境、现象、脱敏日志）
- **配置求助** → `config_help.yml`（要卡在哪一步、试过什么）

贴日志前删除：域名、`AUTH_USER`/`AUTH_PASS`、`?token=…`、Cookie。涉及认证绕过/凭据泄露的，见 [SECURITY.md](SECURITY.md)。

## 提 PR

```bash
git clone https://github.com/afoolfox/dsh-public-access.git
cd dsh-public-access
node --check proxy/dsh-gateway-proxy.mjs          # 语法
AUTH_USER=t AUTH_PASS=t node proxy/dsh-gateway-proxy.mjs   # 冒烟
```

PR 之前请确认：

- **中英文档同步改**：`README.md` ↔ `README.en.md`，只改一边会被要求补；
- **不提交密钥**：`AUTH_PASS` 只走环境变量 / launchd plist（`plist` 本身也不该带真实密码进仓库）；
- **破坏性变更写明**：环境变量改名、默认端口变化、`ingress` 目标变化，都要在 PR 描述里点出来；
- 提交信息建议 `type: subject`（`fix: retry launch token when log rotated`、`docs: add systemd unit`）。

## 想加新平台支持

目前的自启与运维脚本是 macOS launchd。Linux（systemd unit）、Windows（计划任务）都还没有，欢迎补：

- 新增文件放到 `launchd/` 之外的新目录（例如 `systemd/`），不要改 macOS 那三条服务；
- 在 README「快速开始 → 开机自启」里加一小节，并在 `文件说明` 表中登记。

## 本地验证清单

| 检查 | 命令 | 期望 |
|---|---|---|
| 反代语法 | `node --check proxy/dsh-gateway-proxy.mjs` | 无输出 |
| 认证生效 | `curl -o /dev/null -w '%{http_code}' http://127.0.0.1:3099/` | `401` |
| 带凭据放行 | `curl -u user:pass -o /dev/null -w '%{http_code}' http://127.0.0.1:3099/` | `200` |
| WebSocket 升级 | `curl --http1.1 -i -u user:pass -H 'Upgrade: websocket' -H 'Connection: Upgrade' http://127.0.0.1:3099/api/remote.mux` | `101` |

## License

提交即表示同意以 [MIT](LICENSE) 许可发布。

---

## English (short)

One file of real code (`proxy/dsh-gateway-proxy.mjs`); the rest is docs, templates and launch scripts.

- **Most valuable contribution**: a report that a new DSH version broke the chain — file it with the version, the exact error, and what you found; then add a row to the "Lessons learned" table in both READMEs.
- **Before a PR**: `node --check proxy/dsh-gateway-proxy.mjs`, a 200/401 smoke test, and a WebSocket upgrade check (101).
- **Rules**: keep `README.md` and `README.en.md` in sync; never commit domains, passwords, `?token=` values or cookies; spell out breaking changes (env var renames, port changes) in the PR body.
- **New platforms welcome**: systemd units / Windows scheduled tasks — put them in a new directory and link them from both READMEs.

Contributions are released under [MIT](LICENSE).
