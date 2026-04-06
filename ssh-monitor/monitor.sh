#!/bin/zsh
# ============================================================
# SSH Monitor Agent
# Independently detects SSH attacks by monitoring real sshd
# events from macOS unified log and forwarding structured
# alerts to the producer's /ingest endpoint.
#
# This is the log-collection layer of the SOC pipeline,
# equivalent to Filebeat/Fluentd/osquery in a real setup.
#
# Usage:  ./ssh-monitor/monitor.sh
# Stop:   Ctrl+C
# ============================================================

INGEST_URL="${INGEST_URL:-http://localhost:3001/ingest}"
HOSTNAME=$(hostname)
SEEN_FILE=$(mktemp /tmp/ssh_monitor_seen.XXXXX)
LOG_FIFO=$(mktemp /tmp/ssh_monitor_fifo.XXXXX)
rm -f "$LOG_FIFO"
mkfifo "$LOG_FIFO"

cleanup() {
  rm -f "$SEEN_FILE" "$LOG_FIFO"
  kill $(jobs -p) 2>/dev/null
  exit
}
trap cleanup INT TERM EXIT

echo "============================================"
echo "  SSH Monitor Agent"
echo "============================================"
echo "Ingesting to: $INGEST_URL"
echo ""

if curl -s "http://localhost:3001/health" >/dev/null 2>&1; then
  echo "Producer is reachable."
else
  echo "WARNING: Producer not reachable yet."
fi
echo ""
echo "Monitoring sshd events on this host..."
echo ""

post_event() {
  local severity="$1"
  local username="$2"
  local source_ip="$3"
  local message="$4"
  local raw_log="$5"

  local json="{
    \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",
    \"host\": \"${HOSTNAME}\",
    \"service\": \"macos-sshd\",
    \"logType\": \"authentication\",
    \"severity\": \"${severity}\",
    \"sourceIp\": \"${source_ip}\",
    \"username\": \"${username}\",
    \"message\": \"${message}\",
    \"rawLog\": \"${raw_log}\"
  }"

  curl -s -w "%{http_code}" -o /dev/null -X POST "$INGEST_URL" \
    -H "Content-Type: application/json" \
    -d "$json" 2>/dev/null
}

# Use `script` to force a pseudo-TTY for `log stream`
# (log stream produces no output without a TTY)
script -q /dev/null log stream --predicate 'process == "sshd"' --style compact 2>/dev/null > "$LOG_FIFO" &

# Read from the fifo and process events
while IFS= read -r line; do

  # Strip ANSI color codes
  clean=$(echo "$line" | sed 's/\x1b\[[0-9;]*m//g')

  # Skip header, empty, and noise lines
  [[ "$clean" == *"Filtering"* ]] && continue
  [[ -z "$clean" ]] && continue

  # Only process "Retrieve User by Name" — fires during SSH auth lookup
  echo "$clean" | grep -q "Retrieve User by Name" || continue

  # Extract sshd PID
  pid=$(echo "$clean" | grep -oE 'sshd\[[0-9]+' | grep -oE '[0-9]+')
  [ -z "$pid" ] && continue

  # Deduplicate by PID
  if grep -q "^${pid}$" "$SEEN_FILE" 2>/dev/null; then
    continue
  fi
  echo "$pid" >> "$SEEN_FILE"

  # Get remote IPv4 from this sshd process (skip IPv6 link-local)
  source_ip=$(lsof -p "$pid" -i 4 -n -P 2>/dev/null | grep "ESTABLISHED" | awk '{print $9}' | sed 's/.*->//' | cut -d: -f1 | head -1)
  [ -z "$source_ip" ] && source_ip="127.0.0.1"

  # Skip child sshd processes (parent already captured the connection)
  ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  if [ -n "$ppid" ] && grep -q "^${ppid}$" "$SEEN_FILE" 2>/dev/null; then
    continue
  fi

  response=$(post_event "warning" "unknown" "$source_ip" \
    "SSH authentication attempt detected from ${source_ip}" \
    "sshd[$pid]: auth attempt from ${source_ip}")

  if [ "$response" = "200" ]; then
    echo "[SENT] SSH auth attempt from ${source_ip} (sshd PID $pid)"
  else
    echo "[FAIL] HTTP $response — SSH auth attempt from ${source_ip}"
  fi

  # Keep seen file from growing
  line_count=$(wc -l < "$SEEN_FILE" 2>/dev/null | tr -d ' ')
  if [ "$line_count" -gt 500 ]; then
    tail -100 "$SEEN_FILE" > "${SEEN_FILE}.tmp" && mv "${SEEN_FILE}.tmp" "$SEEN_FILE"
  fi

done < "$LOG_FIFO"
