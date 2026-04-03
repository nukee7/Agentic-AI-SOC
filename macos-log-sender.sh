#!/bin/bash
#
# macos-log-sender.sh
#
# Streams macOS Unified Logging and forwards SSH/auth events to the SOC producer.
# Run this script on your macOS host (NOT inside Docker).
# Requires sudo to access security-related log streams.
#
# Usage:
#   chmod +x macos-log-sender.sh
#   sudo ./macos-log-sender.sh
#
# What it captures:
#   - Failed SSH logins (sshd)
#   - Failed sudo attempts
#   - Authorization failures (login window, screensaver)
#   - Successful SSH logins

INGEST_URL="${INGEST_URL:-http://localhost:3001/ingest}"
HOSTNAME_VAL=$(hostname)

echo "==================================="
echo " macOS Security Log Sender"
echo "==================================="
echo "Sending to: $INGEST_URL"
echo "Host: $HOSTNAME_VAL"
echo "Streaming macOS logs — press Ctrl+C to stop"
echo ""

send_event() {
  local severity="$1"
  local log_type="$2"
  local source_ip="$3"
  local username="$4"
  local message="$5"
  local raw_log="$6"

  local event_id
  event_id=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "$(date +%s)-$$-$RANDOM")

  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  local payload
  payload=$(cat <<ENDJSON
{
  "eventId": "$event_id",
  "timestamp": "$timestamp",
  "host": "$HOSTNAME_VAL",
  "service": "macos-security",
  "logType": "$log_type",
  "severity": "$severity",
  "sourceIp": "$source_ip",
  "username": "$username",
  "message": "$message",
  "rawLog": "$raw_log"
}
ENDJSON
)

  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "$INGEST_URL" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>/dev/null)

  if [ "$http_code" = "200" ]; then
    echo "[$(echo "$severity" | tr '[:lower:]' '[:upper:]')] $message"
  else
    echo "[ERROR] Failed to send event (HTTP $http_code): $message"
  fi
}

# Check if producer is reachable
echo "Checking producer connection..."
if curl -s -o /dev/null -w "%{http_code}" "$INGEST_URL" 2>/dev/null | grep -q "404\|200"; then
  echo "Producer is reachable."
else
  echo "[WARN] Cannot reach producer at $INGEST_URL"
  echo "       Make sure docker-compose is running first."
  echo "       Continuing anyway — will retry on each event."
fi
echo ""

# Stream macOS unified logs and filter for auth-related events
log stream --predicate '
  (subsystem == "com.openssh.sshd") OR
  (process == "sshd") OR
  (process == "sudo") OR
  (process == "login") OR
  (process == "loginwindow") OR
  (process == "screensaver") OR
  (eventMessage CONTAINS "authentication" AND eventMessage CONTAINS "failure") OR
  (eventMessage CONTAINS "Failed password") OR
  (eventMessage CONTAINS "Invalid user") OR
  (eventMessage CONTAINS "Accepted password") OR
  (eventMessage CONTAINS "Accepted publickey")
' --style compact 2>/dev/null | while IFS= read -r line; do

  # Skip header lines from log stream
  if echo "$line" | grep -q "^Filtering the log data"; then
    continue
  fi
  if echo "$line" | grep -q "^Timestamp"; then
    continue
  fi

  # --- Pattern: Failed SSH password ---
  if echo "$line" | grep -qi "Failed password"; then
    username=$(echo "$line" | grep -oE "for (invalid user )?[a-zA-Z0-9_.-]+" | head -1 | sed 's/for \(invalid user \)\?//')
    source_ip=$(echo "$line" | grep -oE "from [0-9]+\.[0-9]+\.[0-9]+\.[0-9]+" | head -1 | sed 's/from //')
    username="${username:-unknown}"
    source_ip="${source_ip:-127.0.0.1}"
    safe_line=$(echo "$line" | tr '"' "'" | tr '\n' ' ')
    send_event "warning" "authentication" "$source_ip" "$username" \
      "Failed SSH login for $username from $source_ip" \
      "Failed password for $username from $source_ip port 22 ssh2"
    continue
  fi

  # --- Pattern: Invalid user SSH attempt ---
  if echo "$line" | grep -qi "Invalid user"; then
    username=$(echo "$line" | grep -oE "Invalid user [a-zA-Z0-9_.-]+" | head -1 | sed 's/Invalid user //')
    source_ip=$(echo "$line" | grep -oE "from [0-9]+\.[0-9]+\.[0-9]+\.[0-9]+" | head -1 | sed 's/from //')
    username="${username:-unknown}"
    source_ip="${source_ip:-127.0.0.1}"
    send_event "warning" "authentication" "$source_ip" "$username" \
      "Invalid user $username attempted login from $source_ip" \
      "Invalid user $username from $source_ip port 22 ssh2"
    continue
  fi

  # --- Pattern: Successful SSH login ---
  if echo "$line" | grep -qi "Accepted \(password\|publickey\)"; then
    username=$(echo "$line" | grep -oE "for [a-zA-Z0-9_.-]+" | head -1 | sed 's/for //')
    source_ip=$(echo "$line" | grep -oE "from [0-9]+\.[0-9]+\.[0-9]+\.[0-9]+" | head -1 | sed 's/from //')
    username="${username:-unknown}"
    source_ip="${source_ip:-127.0.0.1}"
    send_event "info" "authentication" "$source_ip" "$username" \
      "Successful SSH login for $username from $source_ip" \
      "Accepted password for $username from $source_ip port 22 ssh2"
    continue
  fi

  # --- Pattern: sudo authentication failure ---
  if echo "$line" | grep -qi "sudo.*authentication failure\|sudo.*auth.*failure\|sudo.*incorrect password"; then
    username=$(echo "$line" | grep -oE "user[= ][a-zA-Z0-9_.-]+" | head -1 | sed 's/user[= ]//')
    username="${username:-unknown}"
    send_event "critical" "privilege-escalation" "127.0.0.1" "$username" \
      "Sudo authentication failure for $username" \
      "sudo: pam_unix(sudo:auth): authentication failure; logname= uid=1000 euid=0 tty=/dev/pts/0 ruser=$username rhost=  user=$username"
    continue
  fi

  # --- Pattern: General authorization failure ---
  if echo "$line" | grep -qi "authentication failure\|auth.*fail"; then
    username=$(echo "$line" | grep -oE "user[= ][a-zA-Z0-9_.-]+" | head -1 | sed 's/user[= ]//')
    username="${username:-unknown}"
    send_event "warning" "authentication" "127.0.0.1" "$username" \
      "Authentication failure for $username on macOS" \
      "macOS auth failure for user $username"
    continue
  fi

done

echo ""
echo "Log stream ended."
