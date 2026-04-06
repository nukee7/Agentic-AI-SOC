#!/bin/zsh
# ============================================================
# SOC Agent — Stop
# Shuts down all backend services: Docker + SSH monitor
#
# Usage:  ./stop.sh
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MONITOR_PID_FILE="/tmp/ssh-monitor.pid"

echo "============================================"
echo "  Stopping SOC Agent Backend"
echo "============================================"
echo ""

# 1. Stop SSH monitor
echo "[1/2] Stopping SSH monitor..."
if [ -f "$MONITOR_PID_FILE" ]; then
  pid=$(cat "$MONITOR_PID_FILE")
  kill "$pid" 2>/dev/null
  # Also kill child processes (log stream, script)
  pkill -P "$pid" 2>/dev/null
  rm -f "$MONITOR_PID_FILE"
  echo "SSH monitor stopped."
else
  echo "SSH monitor not running."
fi
# Kill any stray monitor processes
pkill -f "ssh-monitor/monitor.sh" 2>/dev/null
pkill -f 'log stream.*sshd' 2>/dev/null
echo ""

# 2. Stop Docker services
echo "[2/2] Stopping Docker services..."
docker compose -f "$SCRIPT_DIR/docker-compose.yml" down
echo ""

echo "============================================"
echo "  SOC Agent Backend stopped"
echo "============================================"
