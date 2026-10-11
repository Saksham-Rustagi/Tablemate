#!/bin/bash
# Demo keep-alive: keeps the Mac awake (caffeinate) and restarts Tablemate 2 s after it exits. Ctrl-C stops both.
cd "$(dirname "$0")/.." || exit 1
mkdir -p logs

caffeinate -dimsu -w $$ &
CAF=$!
trap 'kill "$CAF" 2>/dev/null; kill "$TM" 2>/dev/null; exit 0' INT TERM

# Tunnel: start a quick tunnel to :3001 if none is running, then point PUBLIC_BASE_URL in .env at its address.
# Tablemate re-syncs the Retell tool + webhook URLs itself when the base URL changes (ensureRetellSynced).
if ! pgrep -f "cloudflared tunnel --no-autoupdate --url http://localhost:3001" >/dev/null; then
  echo "[$(date '+%H:%M:%S')] run.sh: no tunnel running; starting cloudflared" >> logs/tablemate.log
  cloudflared tunnel --no-autoupdate --url http://localhost:3001 > logs/tunnel.log 2>&1 &
  for _ in $(seq 1 30); do
    grep -qoE 'https://[a-z0-9-]+\.trycloudflare\.com' logs/tunnel.log 2>/dev/null && break
    sleep 1
  done
fi
URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' logs/tunnel.log 2>/dev/null | tail -1)
if [ -n "$URL" ] && [ -f .env ]; then
  CUR=$(grep -E '^PUBLIC_BASE_URL=' .env | tail -1 | cut -d= -f2- | tr -d '"'"'"' ')
  if [ "$CUR" != "$URL" ]; then
    if grep -qE '^PUBLIC_BASE_URL=' .env; then
      sed -i '' "s#^PUBLIC_BASE_URL=.*#PUBLIC_BASE_URL=$URL#" .env
    else
      echo "PUBLIC_BASE_URL=$URL" >> .env
    fi
    echo "[$(date '+%H:%M:%S')] run.sh: tunnel address changed; updated PUBLIC_BASE_URL in .env" >> logs/tablemate.log
  fi
elif [ -z "$URL" ]; then
  echo "[$(date '+%H:%M:%S')] run.sh: WARN no trycloudflare URL found in logs/tunnel.log; leaving .env as is" >> logs/tablemate.log
fi

n=0
while true; do
  n=$((n + 1))
  echo "[$(date '+%H:%M:%S')] run.sh: starting Tablemate (run $n)" >> logs/tablemate.log
  ~/.bun/bin/bun src/main.ts >> logs/tablemate.log 2>&1 &
  TM=$!
  wait "$TM"
  code=$?
  echo "[$(date '+%H:%M:%S')] run.sh: Tablemate exited (code $code); restarting in 2 s" >> logs/tablemate.log
  sleep 2
done
