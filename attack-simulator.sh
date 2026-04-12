#!/bin/bash

# ============================================================
#  SOC Agent — Attack Simulator
#  Run this script from ANOTHER laptop on the same network.
#
#  Usage:
#    chmod +x attack-simulator.sh
#    ./attack-simulator.sh <SOC_IP>
#
#  Example:
#    ./attack-simulator.sh 192.168.1.100
# ============================================================

SOC_IP="${1:?Usage: ./attack-simulator.sh <SOC_IP>}"
PORT=3001
URL="http://${SOC_IP}:${PORT}/ingest"
ATTACKER_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$ATTACKER_IP" ] && ATTACKER_IP=$(ipconfig getifaddr en0 2>/dev/null || echo "10.99.99.1")

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

send_event() {
  local payload="$1"
  local response
  response=$(curl -s -w "\n%{http_code}" -X POST "$URL" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>&1)
  local http_code=$(echo "$response" | tail -1)
  local body=$(echo "$response" | head -1)
  if [ "$http_code" = "200" ]; then
    echo -e "  ${GREEN}OK${NC} ($body)"
  else
    echo -e "  ${RED}FAILED${NC} HTTP $http_code — $body"
  fi
}

# --------------------------------------------------
#  Health Check
# --------------------------------------------------
echo -e "${CYAN}=== Health Check ===${NC}"
echo -n "Checking $SOC_IP:$PORT ... "
health=$(curl -s -o /dev/null -w "%{http_code}" "http://${SOC_IP}:${PORT}/health" 2>&1)
if [ "$health" = "200" ]; then
  echo -e "${GREEN}ONLINE${NC}"
else
  echo -e "${RED}OFFLINE (HTTP $health) — is docker-compose up?${NC}"
  exit 1
fi
echo ""

# --------------------------------------------------
#  Attack 1: SSH Brute Force
#  Sends 7 failed login events in rapid succession.
#  Triggers: Enrichment Agent (AUTH_BRUTE_FORCE rule)
#            → Alert + Incident
#            → Response Agent blocks IP
# --------------------------------------------------
echo -e "${RED}=== ATTACK 1: SSH Brute Force (7 attempts) ===${NC}"
echo "Attacker IP: $ATTACKER_IP"
echo ""

for i in $(seq 1 7); do
  echo -e "  ${YELLOW}Attempt $i/7${NC} — Failed SSH login as root"
  send_event "{
    \"host\": \"prod-server-01\",
    \"service\": \"sshd\",
    \"logType\": \"authentication\",
    \"severity\": \"warning\",
    \"sourceIp\": \"${ATTACKER_IP}\",
    \"username\": \"root\",
    \"message\": \"Failed password for root from ${ATTACKER_IP} port 22 ssh2\",
    \"rawLog\": \"Failed password for root from ${ATTACKER_IP} port 22 ssh2\"
  }"
  sleep 1
done

echo ""
echo -e "${GREEN}Expected: Enrichment agent fires AUTH_BRUTE_FORCE alert after attempt 5${NC}"
echo -e "${GREEN}Expected: Response agent blocks ${ATTACKER_IP}${NC}"
echo ""
sleep 3

# --------------------------------------------------
#  Attack 2: Username Enumeration
#  Tries many different usernames from same IP.
#  Triggers: Enrichment Agent (brute-force per IP)
# --------------------------------------------------
ENUM_IP="203.0.113.50"
echo -e "${RED}=== ATTACK 2: Username Enumeration ===${NC}"
echo "Attacker IP: $ENUM_IP"
echo ""

for user in admin root administrator deploy jenkins gitlab ci-cd backup oracle postgres mysql; do
  echo -e "  ${YELLOW}Trying user: ${user}${NC}"
  send_event "{
    \"host\": \"prod-server-01\",
    \"service\": \"sshd\",
    \"logType\": \"authentication\",
    \"severity\": \"warning\",
    \"sourceIp\": \"${ENUM_IP}\",
    \"username\": \"${user}\",
    \"message\": \"Failed password for invalid user ${user} from ${ENUM_IP} port 22 ssh2\",
    \"rawLog\": \"Failed password for invalid user ${user} from ${ENUM_IP} port 22 ssh2\"
  }"
  sleep 0.5
done

echo ""
echo -e "${GREEN}Expected: Alert fires after 5th failed attempt from ${ENUM_IP}${NC}"
echo ""
sleep 3

# --------------------------------------------------
#  Attack 3: Privilege Escalation
#  Triggers: Anomaly Agent (HIGH severity)
#            → Response Agent blocks IP
# --------------------------------------------------
PRIV_IP="198.51.100.77"
echo -e "${RED}=== ATTACK 3: Privilege Escalation ===${NC}"
echo "Attacker IP: $PRIV_IP"
echo ""

echo -e "  ${YELLOW}sudo su root attempt${NC}"
send_event "{
  \"host\": \"prod-server-01\",
  \"service\": \"sudo\",
  \"logType\": \"privilege-escalation\",
  \"severity\": \"critical\",
  \"sourceIp\": \"${PRIV_IP}\",
  \"username\": \"attacker\",
  \"message\": \"user attacker attempted sudo su root\",
  \"rawLog\": \"user attacker attempted sudo su root\"
}"

echo -e "  ${YELLOW}passwd file access${NC}"
send_event "{
  \"host\": \"prod-server-01\",
  \"service\": \"sudo\",
  \"logType\": \"privilege-escalation\",
  \"severity\": \"critical\",
  \"sourceIp\": \"${PRIV_IP}\",
  \"username\": \"attacker\",
  \"message\": \"user attacker ran cat /etc/shadow\",
  \"rawLog\": \"user attacker ran cat /etc/shadow\"
}"

echo ""
echo -e "${GREEN}Expected: Anomaly agent fires HIGH alert, Response agent blocks ${PRIV_IP}${NC}"
echo ""
sleep 3

# --------------------------------------------------
#  Attack 4: Off-Hours Login
#  Sends login events timestamped at 3 AM UTC.
#  Triggers: Anomaly Agent (OFF_HOURS_LOGIN rule)
# --------------------------------------------------
OFF_HOURS_IP="192.0.2.33"
echo -e "${RED}=== ATTACK 4: Off-Hours Login (3 AM UTC) ===${NC}"
echo "Attacker IP: $OFF_HOURS_IP"
echo ""

# Build a 3AM UTC timestamp for today
TODAY=$(date -u +"%Y-%m-%d")
OFF_HOURS_TS="${TODAY}T03:00:00.000Z"

echo -e "  ${YELLOW}Login at 3 AM UTC${NC}"
send_event "{
  \"host\": \"prod-server-01\",
  \"service\": \"sshd\",
  \"logType\": \"authentication\",
  \"severity\": \"info\",
  \"sourceIp\": \"${OFF_HOURS_IP}\",
  \"username\": \"developer\",
  \"timestamp\": \"${OFF_HOURS_TS}\",
  \"message\": \"Accepted password for developer from ${OFF_HOURS_IP}\",
  \"rawLog\": \"Accepted password for developer from ${OFF_HOURS_IP}\"
}"

echo ""
echo -e "${GREEN}Expected: Anomaly agent fires OFF_HOURS_LOGIN (medium severity)${NC}"
echo ""
sleep 3

# --------------------------------------------------
#  Attack 5: Login from Multiple New IPs
#  Same user logs in from many different IPs.
#  Triggers: Anomaly Agent (NEW_IP_LOGIN rule)
# --------------------------------------------------
echo -e "${RED}=== ATTACK 5: Login from Multiple New IPs ===${NC}"
echo "Target user: sysadmin"
echo ""

for ip in 45.33.32.156 104.16.249.249 185.199.108.153 151.101.1.140 13.107.42.14; do
  echo -e "  ${YELLOW}Login from ${ip}${NC}"
  send_event "{
    \"host\": \"prod-server-01\",
    \"service\": \"sshd\",
    \"logType\": \"authentication\",
    \"severity\": \"info\",
    \"sourceIp\": \"${ip}\",
    \"username\": \"sysadmin\",
    \"message\": \"Accepted password for sysadmin from ${ip} port 22 ssh2\",
    \"rawLog\": \"Accepted password for sysadmin from ${ip} port 22 ssh2\"
  }"
  sleep 1
done

echo ""
echo -e "${GREEN}Expected: Anomaly agent fires NEW_IP_LOGIN for each unseen IP${NC}"
echo ""
sleep 3

# --------------------------------------------------
#  Attack 6: Windows RDP Brute Force
#  Simulates Windows Event 4625 (failed logon).
#  Triggers: Enrichment Agent (parses Windows format)
# --------------------------------------------------
RDP_IP="10.200.50.99"
echo -e "${RED}=== ATTACK 6: Windows RDP Brute Force ===${NC}"
echo "Attacker IP: $RDP_IP"
echo ""

for i in $(seq 1 6); do
  echo -e "  ${YELLOW}RDP attempt $i/6${NC}"
  send_event "{
    \"host\": \"WIN-DC01\",
    \"service\": \"EventLog\",
    \"logType\": \"authentication\",
    \"severity\": \"warning\",
    \"sourceIp\": \"${RDP_IP}\",
    \"username\": \"Administrator\",
    \"message\": \"Windows Event 4625 - Failed logon User: DOMAIN\\\\Administrator IP: ${RDP_IP}\",
    \"rawLog\": \"Windows Event 4625 - Failed logon User: DOMAIN\\\\Administrator IP: ${RDP_IP}\"
  }"
  sleep 0.5
done

echo ""
echo -e "${GREEN}Expected: Enrichment agent parses Windows event format and fires alert${NC}"
echo ""

# --------------------------------------------------
#  Summary
# --------------------------------------------------
echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN}  ATTACK SIMULATION COMPLETE${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""
echo "Check your SOC dashboard at: http://${SOC_IP}:8080"
echo ""
echo "Verify on the SOC machine:"
echo "  docker logs enrichment-agent --tail 30"
echo "  docker logs anomaly-agent --tail 30"
echo "  docker logs response-agent --tail 30"
echo "  docker exec redis redis-cli keys '*'"
echo ""
