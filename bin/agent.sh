#!/usr/bin/env bash
# Minimal process manager for the SusuMate WhatsApp agent (nohup + pidfile).
# Usage: bin/agent.sh {start|stop|restart|status|logs}
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PIDFILE="$ROOT/.agent.pid"
LOGDIR="${LOG_DIR:-$ROOT/logs}"
LOGFILE="$LOGDIR/agent.out"

mkdir -p "$LOGDIR"

is_running() {
  [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

# Count every live gateway process for THIS repo (node loader running src/index.ts under ROOT).
# Catches orphans a stale pidfile would miss — running two at once makes WhatsApp flap (error 440).
instance_count() {
  # pgrep -c prints "0" and exits 1 when there are no matches; swallow the exit code so we
  # emit a single clean number.
  pgrep -fc "$ROOT/node_modules/tsx/.*src/index.ts" 2>/dev/null || true
}

# Kill ALL gateway processes for this repo (the node loader + the npm/sh wrappers), not just the
# one in the pidfile.
kill_all() {
  pkill -9 -f "$ROOT/node_modules/tsx/.*src/index.ts" 2>/dev/null || true
  pkill -9 -f "$ROOT/node_modules/.bin/tsx src/index.ts" 2>/dev/null || true
}

start() {
  # Always begin from a clean slate — never allow a second instance (prevents 440 flapping).
  if [[ "$(instance_count)" -gt 0 ]]; then
    echo "found $(instance_count) existing instance(s) — stopping them first…"
    kill_all; sleep 2
  fi
  rm -f "$PIDFILE"
  echo "starting susumate-agent…"
  nohup npx tsx src/index.ts >>"$LOGFILE" 2>&1 &
  echo $! >"$PIDFILE"
  sleep 1
  is_running && echo "started (pid $(cat "$PIDFILE")) — logs: $LOGFILE" || { echo "failed to start; see $LOGFILE"; exit 1; }
}

stop() {
  kill_all
  rm -f "$PIDFILE"
  sleep 1
  [[ "$(instance_count)" -eq 0 ]] && echo "stopped (all instances)" || echo "warning: an instance may still be running"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop || true; start ;;
  status)
    c="$(instance_count)"
    if [[ "$c" -eq 0 ]]; then echo "stopped"
    elif [[ "$c" -eq 1 ]]; then echo "running (1 instance)"
    else echo "WARNING: $c instances running — run '$0 restart' to fix (duplicates cause WhatsApp flapping)"; fi ;;
  logs) tail -f "$LOGFILE" ;;
  *) echo "usage: $0 {start|stop|restart|status|logs}"; exit 1 ;;
esac
