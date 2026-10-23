## 这个 PR 做了什么 / What does this PR do

<!-- 一两句话。如果是修某个 issue，写上 Fixes #123 -->

## 类型 / Type

- [ ] 反代修复（`proxy/`）
- [ ] 脚本 / launchd（`scripts/`、`launchd/`）
- [ ] 文档（`README.md` + `README.en.md` 需同步）
- [ ] 新场景（例如新增某个平台的 systemd 单元）

## 验证 / Verification

<!-- 贴你实际跑过的命令与输出，别写"应该可以" -->

```bash
# 反代语法与启动
node --check proxy/dsh-gateway-proxy.mjs
AUTH_USER=t AUTH_PASS=t node proxy/dsh-gateway-proxy.mjs
```

- [ ] 带凭据访问返回 200
- [ ] 不带凭据访问返回 401
- [ ] 若是认证/头改写相关改动：确认 WebSocket 仍能升级（101）

## 检查清单 / Checklist

- [ ] 没有提交任何真实域名、密码、`?token=`、Cookie
- [ ] 中英文文档已同步
- [ ] 破坏性变更（环境变量改名、默认端口变化）已在 PR 描述里写明
