#!/bin/zsh
# ============================================================
# SOC Agent — Start
# Boots the full backend: Docker services + SSH monitor
#
# Usage:  ./start.sh
# Stop:   ./stop.sh
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MONITOR_PID_FILE="/tmp/ssh-monitor.pid"

echo "============================================"
echo "  Starting SOC Agent Backend"
echo "============================================"
echo ""

# 1. Start Docker services
echo "[1/2] Starting Docker services..."
docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d --build
echo ""

# 2. Wait for producer to be healthy
echo "Waiting for producer to be ready..."
retries=0
until curl -s http://localhost:3001/health >/dev/null 2>&1; do
  retries=$((retries + 1))
  if [ $retries -gt 30 ]; then
    echo "WARNING: Producer not ready after 30s. Starting monitor anyway."
    break
  fi
  sleep 1
done
echo "Producer is ready."
echo ""

# 3. Start SSH monitor on the host
echo "[2/2] Starting SSH monitor agent..."
if [ -f "$MONITOR_PID_FILE" ]; then
  old_pid=$(cat "$MONITOR_PID_FILE")
  kill "$old_pid" 2>/dev/null
  rm -f "$MONITOR_PID_FILE"
fi

nohup "$SCRIPT_DIR/ssh-monitor/monitor.sh" > "$SCRIPT_DIR/ssh-monitor/monitor.log" 2>&1 &
echo $! > "$MONITOR_PID_FILE"
echo "SSH monitor running (PID $(cat $MONITOR_PID_FILE))"
echo "Logs: $SCRIPT_DIR/ssh-monitor/monitor.log"
echo ""

echo "============================================"
echo "  SOC Agent Backend is running"
echo "============================================"
echo ""
echo "  Dashboard:    http://localhost:8080"
echo "  API:          http://localhost:3000"
echo "  Ingest:       http://localhost:3001/ingest"
echo "  SSH Monitor:  running on host (PID $(cat $MONITOR_PID_FILE))"
echo ""
echo "  To attack:    ./scripts/ssh-attack.sh"
echo "  To stop:      ./stop.sh"
echo ""
