#!/usr/bin/env bash
# ============================================================
#  OCI poll-agent. Polls the Cloudflare panel every 10s and
#  starts/stops a local k6 loop to match the panel's state.
#  Runs as a systemd service so it survives reboots.
#
#  Env (from /etc/blast-agent.env):
#    PANEL_URL   https://blast-panel.mbm-blast.workers.dev
#    VM_KEY      shared secret
#    VM_NAME     label for heartbeats
# ============================================================
set -u
ENVF=/etc/blast-agent.env
[ -f "$ENVF" ] && . "$ENVF"
PANEL_URL="${PANEL_URL:?}"
VM_KEY="${VM_KEY:?}"
VM_NAME="${VM_NAME:-$(hostname)}"
WORKDIR=/opt/blast
RAW=https://raw.githubusercontent.com/AMAZINGAaryan/Blast/main

mkdir -p "$WORKDIR"
# fetch the k6 scripts (engine + keycloak)
curl -fsSL "$RAW/engine.js"   -o "$WORKDIR/engine.js"   2>/dev/null || true
curl -fsSL "$RAW/keycloak.js" -o "$WORKDIR/keycloak.js" 2>/dev/null || true

CUR_PID=""
CUR_SIG=""

ncpu=$(nproc); ram=$(awk '/MemTotal/{printf "%d",$2/1024/1024}' /proc/meminfo); [ "$ram" -lt 1 ] && ram=1
BUDGET=$(( ram * 800 )); [ "$BUDGET" -gt 20000 ] && BUDGET=20000   # scales with RAM (micro~800, ARM~19200)

start_k6() {
  local target="$1" scenario="$2" mode="$3" vus="$4"
  local script="$WORKDIR/engine.js"
  [ "$scenario" = "keycloak" ] && script="$WORKDIR/keycloak.js"
  local v="${vus:-$BUDGET}"; [ "$v" -gt "$BUDGET" ] && v="$BUDGET"
  nohup bash -c "while true; do k6 run -e TARGET='$target' -e MODE='$mode' -e VUS='$v' -e RATE='$v' -e DURATION=5m -e SHARD='$VM_NAME' '$script' --no-color --quiet 2>&1 | grep -E 'shard|discovered' || true; sleep 2; done" >/var/log/blast-k6.log 2>&1 &
  CUR_PID=$!
}
stop_k6() {
  [ -n "$CUR_PID" ] && kill "$CUR_PID" 2>/dev/null
  pkill -f 'k6 run' 2>/dev/null
  CUR_PID=""
}

while true; do
  # heartbeat
  curl -fsS --max-time 8 -X POST "$PANEL_URL/api/heartbeat?key=$VM_KEY&vm=$VM_NAME" >/dev/null 2>&1 || true
  # command
  resp=$(curl -fsS --max-time 8 "$PANEL_URL/api/command?key=$VM_KEY" 2>/dev/null || echo '{}')
  running=$(echo "$resp" | grep -o '"running":[^,}]*' | head -1 | grep -o 'true\|false')
  target=$(echo "$resp"  | grep -o '"target":"[^"]*"'  | head -1 | sed 's/.*:"//;s/"//')
  scenario=$(echo "$resp"| grep -o '"scenario":"[^"]*"'| head -1 | sed 's/.*:"//;s/"//')
  mode=$(echo "$resp"    | grep -o '"mode":"[^"]*"'    | head -1 | sed 's/.*:"//;s/"//')
  vus=$(echo "$resp"     | grep -o '"vus":[0-9]*'      | head -1 | grep -o '[0-9]*')
  sig="$running|$target|$scenario|$mode|$vus"

  if [ "$running" = "true" ]; then
    if [ "$sig" != "$CUR_SIG" ]; then
      stop_k6; start_k6 "$target" "${scenario:-pages}" "${mode:-max}" "${vus:-$BUDGET}"; CUR_SIG="$sig"
    fi
  else
    if [ -n "$CUR_PID" ]; then stop_k6; CUR_SIG=""; fi
  fi
  sleep 10
done
