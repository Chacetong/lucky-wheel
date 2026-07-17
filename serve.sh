#!/usr/bin/env bash
# 本地起一个静态服务器并打开浏览器。ES Module 需要 http origin，双击
# index.html（file://）会被浏览器 CORS 拦截，改用这个脚本即可。
set -euo pipefail
PORT="${1:-5173}"
cd "$(dirname "$0")"
open "http://127.0.0.1:${PORT}/" || true
exec python3 -m http.server "${PORT}"
