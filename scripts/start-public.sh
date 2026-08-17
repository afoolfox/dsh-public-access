#!/bin/bash
# 一键启动 DSH 公网访问链路：认证反代 + Cloudflare 隧道
# 用法: bash scripts/start-public.sh
# 需要先设置环境变量（或复制到 ~/.dsh/ 并填好真实值）：
#   AUTH_USER / AUTH_PASS : 反代认证用户名密码
#   PROXY_SCRIPT           : dsh-gateway-proxy.mjs 的路径
#   TUNNEL_NAME            : cloudflared 隧道名（默认 dsh）
set -e

AUTH_USER="${AUTH_USER:?请设置 AUTH_USER}"
AUTH_PASS="${AUTH_PASS:?请设置 AUTH_PASS}"
PROXY_SCRIPT="${PROXY_SCRIPT:-$HOME/dsh-public-access/proxy/dsh-gateway-proxy.mjs}"
TUNNEL_NAME="${TUNNEL_NAME:-dsh}"

echo "[1/2] 启动认证反代 (127.0.0.1:3099 -> 127.0.0.1:3080) ..."
if lsof -iTCP:3099 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "     反代已在运行，跳过"
else
  AUTH_USER="$AUTH_USER" AUTH_PASS="$AUTH_PASS" \
    nohup node "$PROXY_SCRIPT" > /tmp/dsh-proxy.log 2>&1 &
  sleep 1
  echo "     已启动 (日志: /tmp/dsh-proxy.log)"
fi

echo "[2/2] 启动 Cloudflare 隧道 ($TUNNEL_NAME) ..."
if pgrep -f "cloudflared tunnel run $TUNNEL_NAME" >/dev/null 2>&1; then
  echo "     隧道已在运行，跳过"
else
  nohup cloudflared tunnel run "$TUNNEL_NAME" > /tmp/dsh-tunnel.log 2>&1 &
  sleep 3
  echo "     已启动 (日志: /tmp/dsh-tunnel.log)"
fi

echo "完成。验证: curl -s -u $AUTH_USER:<密码> -o /dev/null -w '%{http_code}' https://你的域名/"
