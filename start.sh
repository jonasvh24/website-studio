#!/usr/bin/env bash
# Start the local Website Studio dashboard.
cd "$(dirname "$0")/dashboard" || exit 1
PORT="${PORT:-$(node -p 'require("./config.json").port || 4321')}"
if command -v open >/dev/null 2>&1; then (sleep 1; open "http://localhost:$PORT") & fi
exec node server.js
