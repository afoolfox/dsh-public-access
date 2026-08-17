#!/bin/bash
# 从"手动进程"切换到"launchd 开机自启"：停掉现有进程 → 加载三个服务 → 验证
# 用法: bash scripts/switch-to-autostart.sh
set -e
UID_NOW=$(id -u)
AGENTS=(
  "$HOME/Library/LaunchAgents/com.dsh.web.plist"
  "$HOME/Library/LaunchAgents/com.dsh.proxy.plist"
  "$HOME/Library/LaunchAgents/com.dsh.tunnel.plist"
)

echo "== [1/4] 停止现有手动进程 =="
pkill -f "dsh-gateway-proxy.mjs" 2>/dev/null && echo "  已停 反代" || echo "  反代未在跑"
pkill -f "cloudflared tunnel run" 2>/dev/null && echo "  已停 隧道" || echo "  隧道未在跑"
pkill -f "dsh web" 2>/dev/null && echo "  已停 DSH" || echo "  DSH未在跑"
sleep 2

echo "== [2/4] 卸载旧服务(如有) =="
for p in "${AGENTS[@]}"; do
  launchctl bootout "gui/$UID_NOW" "$p" 2>/dev/null || true
done

echo "== [3/4] 加载开机自启服务 =="
for p in "${AGENTS[@]}"; do
  echo "  加载 $(basename "$p")"
  launchctl bootstrap "gui/$UID_NOW" "$p"
done
sleep 10

echo "== [4/4] 验证 =="
echo "--- 端口 ---"
lsof -iTCP:3080 -sTCP:LISTEN -P 2>/dev/null | tail -1 || echo "  !! 3080 未监听"
lsof -iTCP:3099 -sTCP:LISTEN -P 2>/dev/null | tail -1 || echo "  !! 3099 未监听"
echo "--- 隧道 ---"
pgrep -fl "cloudflared tunnel run" || echo "  !! 隧道未运行"
echo "--- 公网 ---"
curl -s -o /dev/null -w "  https://你的域名 -> HTTP %{http_code}\n" --max-time 12 "https://你的域名/"
echo "完成。若某项异常，查看日志: /tmp/dsh-web.log /tmp/dsh-proxy.log /tmp/dsh-tunnel.log"
