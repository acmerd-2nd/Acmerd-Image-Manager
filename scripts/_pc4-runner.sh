#!/usr/bin/env bash
# PC-4 sandbox runner (v2): keeps local wrangler dev alive for the whole sandbox run.
# Single process tree => worker cannot die between "start" and "sandbox".
# Uses port 8787 to avoid stale unkillable listeners on 4173.
# curl localhost health-check uses --noproxy (env forces http_proxy which breaks localhost).
set -u
cd "E:/【项目】0002.Acmerd-Image-Manager"

# Neutralize the forced (dead) http_proxy for the LOCAL worker's server-side fetch
# to raw.githubusercontent.com. Plain Node fetch (undici) ignores http_proxy, but
# workerd/miniflare may honor it -> dead proxy -> ZIP preflight 502. NO_PROXY='*'
# makes the worker go direct. Harmless if workerd ignores it.
export NO_PROXY='*'
export no_proxy='*'
export HTTP_PROXY=''
export HTTPS_PROXY=''
export http_proxy=''
export https_proxy=''

PORT=8787
LOG=.pc4-wrangler.log
: > "$LOG"

# Defensive: kill any stragglers from prior sessions
pkill -9 -f "npx-cli.js wrangler" 2>/dev/null || true
pkill -9 -f "wrangler dev" 2>/dev/null || true
sleep 2

echo "=== starting wrangler dev on $PORT at $(date) ==="
npx wrangler dev --port $PORT --ip 127.0.0.1 >> "$LOG" 2>&1 &
WR=$!
echo "wrangler pid=$WR"

cleanup() {
  echo "=== cleanup: killing wrangler pid=$WR ==="
  kill -9 $WR 2>/dev/null || true
  pkill -9 -f "npx-cli.js wrangler" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for /api/health (up to 180s). Must bypass the forced http_proxy for localhost.
READY=0
for i in $(seq 1 180); do
  code=$(curl -s --noproxy 127.0.0.1 -o /dev/null -w "%{http_code}" --max-time 3 http://127.0.0.1:$PORT/api/health 2>/dev/null)
  if [ "$code" = "200" ]; then READY=1; echo "worker healthy after ${i}s"; break; fi
  sleep 1
done

if [ "$READY" -ne 1 ]; then
  echo "WORKER NOT READY — last 50 lines of $LOG:"
  tail -n 50 "$LOG"
  exit 2
fi

echo "=== running sandbox (global timeout 1500s) at $(date) ==="
export PC4_BASE=http://127.0.0.1:$PORT
timeout 1500 node scripts/v11-pc4-sandbox.mjs 2>&1 | tee docs/v1.1/evidence-pc4-sandbox-rerun.md
RC=${PIPESTATUS[0]}
echo "=== SANDBOX_RC=$RC at $(date) ==="
exit $RC
