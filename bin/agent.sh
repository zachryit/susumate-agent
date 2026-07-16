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

start() {
  if is_running; then
    echo "already running (pid $(cat "$PIDFILE"))"; exit 0
  fi
  echo "starting susumate-agent…"
  nohup npx tsx src/index.ts >>"$LOGFILE" 2>&1 &
  echo $! >"$PIDFILE"
  sleep 1
  is_running && echo "started (pid $(cat "$PIDFILE")) — logs: $LOGFILE" || { echo "failed to start; see $LOGFILE"; exit 1; }
}

stop() {
  if is_running; then
    kill "$(cat "$PIDFILE")" && echo "stopped"
  else
    echo "not running"
  fi
  rm -f "$PIDFILE"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop || true; start ;;
  status) is_running && echo "running (pid $(cat "$PIDFILE"))" || echo "stopped" ;;
  logs) tail -f "$LOGFILE" ;;
  *) echo "usage: $0 {start|stop|restart|status|logs}"; exit 1 ;;
esac
