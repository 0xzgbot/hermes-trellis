#!/bin/sh
# Start the MCP server. A fresh clone has no dist/; build it once.
set -eu
cd "$(dirname "$0")"
if [ ! -f dist/index.js ]; then
  echo "[trellis-mcp] dist/index.js is missing. Running npm install && npm run build." >&2
  npm install
  npm run build
fi
exec node dist/index.js
