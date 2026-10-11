#!/bin/bash
# Demo keep-alive: keeps the Mac awake (caffeinate) and restarts Kin 2 s after it exits. Ctrl-C stops both.
cd "$(dirname "$0")/.." || exit 1
mkdir -p logs

caffeinate -dimsu -w $$ &
CAF=$!
trap 'kill "$CAF" 2>/dev/null; kill "$KIN" 2>/dev/null; exit 0' INT TERM

# Tunnel: start a quick tunnel if none is running, then point PUBLIC_BASE_URL in .env at its address.
# Kin re-syncs the ElevenLabs agent tools itself when the base URL changes (ensureAgentSynced).
if ! pgrep -f "cloudflared tunnel" >/dev/null; then
  echo "[$(date '+%H:%M:%S')] run.sh: no tunnel running; starting cloudflared" >> logs/kin.log
  cloudflared tunnel --no-autoupdate --url http://localhost:3000 > logs/tunnel.log 2>&1 &
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
    echo "[$(date '+%H:%M:%S')] run.sh: tunnel address changed; updated PUBLIC_BASE_URL in .env" >> logs/kin.log
  fi
elif [ -z "$URL" ]; then
  echo "[$(date '+%H:%M:%S')] run.sh: WARN no trycloudflare URL found in logs/tunnel.log; leaving .env as is" >> logs/kin.log
fi

n=0
while true; do
  n=$((n + 1))
  echo "[$(date '+%H:%M:%S')] run.sh: starting Kin (run $n)" >> logs/kin.log
  ~/.bun/bin/bun src/main.ts >> logs/kin.log 2>&1 &
  KIN=$!
  wait "$KIN"
  code=$?
  echo "[$(date '+%H:%M:%S')] run.sh: Kin exited (code $code); restarting in 2 s" >> logs/kin.log
  sleep 2
done
