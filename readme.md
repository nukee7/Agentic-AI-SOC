# Agentic AI SOC (Security Operations Center)

A real-time, AI-driven Security Operations Center built with an **agentic microservices architecture**. Multiple specialized agents work in parallel — each consuming security events from Apache Kafka, applying detection logic, enriching with threat intelligence, and automatically responding to threats. Everything streams live to a web dashboard via WebSocket.

---

## Architecture Overview

```
Windows Laptop                    Linux / macOS
(windows-log-sender.ps1)          (/var/log/auth.log)
         |                               |
         v                               v
   +-----------+                   +-----------+
   | HTTP POST |                   | File Tail |
   +-----------+                   +-----------+
         |                               |
         +---------- Producer -----------+
                   (port 3001)
                        |
                        v
               +----------------+
               |  Apache Kafka  |
               |  (port 9092)   |
               +----------------+
               |  security_logs |
               |  alerts        |
               |  enriched_logs |
               +----------------+
                   |        |
       +-----------+--------+-----------+
       |           |                    |
       v           v                    v
 +-----------+ +-----------+    +-------------+
 | Detection | | Anomaly   |    | Enrichment  |
 |   Agent   | |   Agent   |    |    Agent    |
 +-----------+ +-----------+    +-------------+
 | SSH brute | | Off-hours |    | AbuseIPDB   |
 | force     | | logins    |    | threat intel|
 | Windows   | | New IPs   |    | IP classify |
 | Event 4625| | Priv esc  |    | GeoIP/ISP   |
 +-----------+ +-----------+    +-------------+
       |           |
       v           v
    +--------+  alerts topic
    | alerts |<-----+
    | topic  |
    +--------+
       |
       +------------------+
       |                  |
       v                  v
 +-------------+   +-----------+
 |  Response   |   | Dashboard |
 |    Agent    |   |  Service  |
 +-------------+   +-----------+
 | Auto-block  |   | REST API  |
 | IPs in Redis|   | WebSocket |
 +-------------+   | PostgreSQL|
                    +-----------+
                         |
                         v
                  +------------+
                  |  Frontend  |
                  | (port 8080)|
                  +------------+
                  | Live feed  |
                  | Stats      |
                  | Alert table|
                  +------------+
```

---

## Tech Stack

| Layer          | Technology                                |
| -------------- | ----------------------------------------- |
| Language       | TypeScript (Node.js)                      |
| Streaming      | Apache Kafka + Zookeeper                  |
| State / Cache  | Redis 7                                   |
| Database       | PostgreSQL 15                              |
| Threat Intel   | AbuseIPDB API (real-time IP reputation)   |
| Frontend       | Vanilla HTML/CSS/JS + WebSocket           |
| Orchestration  | Docker Compose                            |
| Log Sources    | Windows Event Log, Linux auth.log, HTTP   |

---

## Services

### 1. Producer (`producer/`)
**Port:** 3001

The entry point for all security events. Three ingestion modes:

- **Linux/macOS** — Automatically tails `/var/log/auth.log` (or `/var/log/secure`, `/var/log/system.log`) and parses SSH log lines in real-time.
- **Windows** — Accepts HTTP POST requests at `/ingest`. The `windows-log-sender.ps1` PowerShell script runs on the Windows host, reads Security Event Log entries (Event IDs 4624, 4625, 4648), and forwards them to the producer.
- **Simulation** — When no log file exists (Docker on Windows), generates realistic attack traffic: SSH brute force, Windows RDP failed logins, privilege escalation, and user probing from diverse attacker IPs.

Parses raw log lines into structured `SecurityEvent` objects and publishes them to the `security_logs` Kafka topic.

**Parsed event structure:**
```json
{
  "eventId": "uuid",
  "timestamp": "2025-01-15T14:30:00Z",
  "host": "hostname",
  "service": "linux-auth | windows-security",
  "logType": "authentication | privilege-escalation | session",
  "severity": "info | warning | critical",
  "sourceIp": "45.33.32.156",
  "username": "root",
  "message": "Failed password for root from 45.33.32.156",
  "rawLog": "<original log line>"
}
```

### 2. Detection Agent (`detection-agent/`)
**Kafka consumer** | Uses Redis for stateful tracking

Detects brute-force attacks using a sliding window counter in Redis.

**Rules:**
- **SSH_BRUTE_FORCE** — Triggers when 5+ failed login attempts come from the same IP within a 60-second window. Configurable via environment variables (`FAILURE_THRESHOLD`, `WINDOW_SECONDS`).

**Supports multiple log formats:**
- Linux/SSH: `Failed password for [invalid user] <user> from <ip>`
- Windows Event 4625: `Windows Event 4625: Failed login. User: DOMAIN\<user> IP: <ip>`
- Structured fallback: Uses event fields directly when `logType=authentication` and `severity=warning|critical`

**Deduplication:** Suppresses repeated alerts for the same IP for 5 minutes (`DEDUP_WINDOW_SECONDS=300`) to prevent alert fatigue.

### 3. Anomaly Agent (`anomaly-agent/`)
**Kafka consumer** | Uses Redis for state tracking

Detects behavioral anomalies that don't fit simple threshold rules.

**Rules:**
| Rule                         | Severity | Logic                                                        |
| ---------------------------- | -------- | ------------------------------------------------------------ |
| Off-Hours Login Attempt      | Medium   | Login between 11 PM - 6 AM UTC                              |
| Login from New IP            | Medium   | Successful login from an IP never seen for that user (24hr)  |
| Privilege Escalation Attempt | High     | Any event with `logType=privilege-escalation` (sudo failure) |

### 4. Enrichment Agent (`enrichment-agent/`)
**Kafka consumer** | Uses Redis for caching | **AbuseIPDB integration**

Enriches every security event with contextual intelligence before publishing to the `enriched_logs` topic.

**Enrichments applied to each event:**

| Field          | Description                                                                 |
| -------------- | --------------------------------------------------------------------------- |
| `ipType`       | Classifies source IP as `private`, `public`, or `loopback`                  |
| `loginContext` | Time context: `business-hours`, `after-hours`, or `weekend`                 |
| `isThreatIp`   | `true` if AbuseIPDB confidence score >= 25%                                |
| `abuseScore`   | AbuseIPDB abuse confidence percentage (0-100)                               |
| `country`      | Country code from AbuseIPDB (e.g., `CN`, `RU`, `US`)                       |
| `isp`          | ISP name from AbuseIPDB                                                     |
| `totalReports` | Number of abuse reports filed against this IP                               |
| `threatSource` | Where the verdict came from: `abuseipdb`, `cache`, or `skipped`             |
| `isRootAttempt` | `true` if username is `root` or `admin`                                    |

**Caching:** IP reputation results are cached in Redis for 6 hours to conserve the free-tier API limit (1000 lookups/day). Private and loopback IPs are skipped entirely.

### 5. Response Agent (`response-agent/`)
**Kafka consumer** | Uses Redis for IP blocking

Automated incident response — takes action on alerts without human intervention.

**Actions:**
- **IP Blocking** — Automatically blocks source IPs from high-severity alerts in Redis with a 1-hour TTL. Excludes loopback (`127.0.0.1`) and null (`0.0.0.0`) IPs.
- **Alert Counting** — Maintains per-rule alert counters in Redis with 24-hour TTL for analytics.

### 6. Dashboard Service (`dashboard-service/`)
**Port:** 3000

Backend API for the web dashboard.

- **Kafka consumer** — Subscribes to the `alerts` topic and processes every alert.
- **PostgreSQL persistence** — Saves all alerts with deduplication (`ON CONFLICT DO NOTHING`).
- **REST API** — `GET /alerts` returns the 100 most recent alerts.
- **WebSocket server** — Broadcasts new alerts in real-time to all connected browsers.
- **Health check** — `GET /health` returns service status.

### 7. Frontend (`frontend/`)
**Port:** 8080 (Nginx)

A real-time security dashboard served as static HTML/CSS/JS.

**Dashboard page:**
- **Stats cards** — Total alerts, high-severity count, unique attacker IPs, time since last alert
- **Live feed** — Latest 8 alerts with severity color coding, auto-updated via WebSocket
- **Alert breakdown** — Horizontal bar chart showing top 5 alert rules by frequency
- **Alert table** — Full table of the 100 most recent alerts with time, rule, severity badge, source IP, username, and description
- **Auto-refresh** — Polls REST API every 30 seconds + instant WebSocket updates

**Architecture page:**
- Visual pipeline diagram showing data flow from log sources through agents to the dashboard
- Service cards describing each component's role

---

## Getting Started

### Prerequisites
- Docker + Docker Compose
- (Optional) AbuseIPDB free API key for real threat intelligence

### Quick Start

```bash
# Clone and start everything
cd Agentic-AI-SOC
docker-compose up --build
```

The dashboard will be available at **http://localhost:8080**.

Without an AbuseIPDB key, the system runs in simulation mode with all features working except real-time IP reputation lookups.

### With Real Threat Intelligence

1. Sign up at [abuseipdb.com](https://www.abuseipdb.com/) and get a free API key.
2. Set the environment variable and start:

```bash
# Linux/macOS
export ABUSEIPDB_API_KEY="your_key_here"
docker-compose up --build

# Windows PowerShell
$env:ABUSEIPDB_API_KEY="your_key_here"
docker-compose up --build
```

### Real Attack Detection (Windows Host)

To detect real attacks on your Windows laptop (e.g., a friend doing an RDP brute-force):

1. Start the SOC pipeline:
   ```bash
   docker-compose up --build
   ```

2. Run the Windows Event Log sender **as Administrator** on the host:
   ```powershell
   powershell -ExecutionPolicy Bypass -File windows-log-sender.ps1
   ```

3. The script polls Windows Security Event Log every 5 seconds for:
   - **Event 4625** — Failed login attempts (RDP, network, local)
   - **Event 4624** — Successful logins
   - **Event 4648** — Explicit credential use

4. When your friend tries to log in and fails, the events flow through the full pipeline and appear on the dashboard in real-time.

### Real Attack Detection (macOS Host)

macOS doesn't use `/var/log/auth.log` inside Docker containers either, so you need to stream logs from the host.

**Option A — Use the macOS log sender script (recommended):**

1. Start the SOC pipeline:
   ```bash
   docker-compose up --build
   ```

2. Run the macOS log sender on the host (requires sudo for reading auth logs):
   ```bash
   chmod +x macos-log-sender.sh
   sudo ./macos-log-sender.sh
   ```

3. The script streams macOS Unified Logging (`log stream`) in real-time, watching for:
   - **Failed SSH logins** — e.g., a friend running `ssh root@your-mac-ip`
   - **Failed `sudo` attempts** — privilege escalation
   - **Login/authorization failures** — screen unlock, remote login

4. Open the dashboard at **http://localhost:8080** and watch alerts appear live.

**Option B — Tail auth.log directly (if available):**

On older macOS versions or if you have SSH enabled, auth events may appear in `/var/log/system.log`. You can mount it into the producer container by adding this to `docker-compose.yml` under the `producer` service:

```yaml
volumes:
  - /var/log/system.log:/var/log/system.log:ro
```

Then restart: `docker-compose up --build`. The producer will auto-detect and tail the log file.

**Option C — Enable Remote Login and let a friend attack:**

1. Go to **System Settings > General > Sharing > Remote Login** and turn it on.
2. Find your IP: `ifconfig en0 | grep inet`
3. Give your friend your IP. They can try:
   ```bash
   # From the attacker's machine — this will generate failed login events
   ssh root@<your-ip>
   ssh admin@<your-ip>
   ssh test@<your-ip>
   ```
4. The macOS log sender script captures these and forwards them to the pipeline.

### Sending Custom Events

You can POST events directly to the producer:

```bash
curl -X POST http://localhost:3001/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "severity": "warning",
    "logType": "authentication",
    "sourceIp": "203.0.113.50",
    "username": "attacker",
    "message": "Failed login attempt",
    "rawLog": "Failed password for attacker from 203.0.113.50 port 22 ssh2"
  }'
```

---

## Configuration

### Environment Variables

| Variable                 | Service          | Default  | Description                           |
| ------------------------ | ---------------- | -------- | ------------------------------------- |
| `KAFKA_BROKER`           | All              | kafka:9092 | Kafka broker address                |
| `REDIS_HOST`             | Detection, Anomaly, Enrichment, Response | redis | Redis host   |
| `ABUSEIPDB_API_KEY`      | Enrichment       | (empty)  | AbuseIPDB API key for threat intel    |
| `FAILURE_THRESHOLD`      | Detection        | 5        | Failed logins before brute-force alert|
| `WINDOW_SECONDS`         | Detection        | 60       | Sliding window for counting failures  |
| `DEDUP_WINDOW_SECONDS`   | Detection        | 300      | Suppress duplicate alerts for N seconds|
| `POSTGRES_HOST`          | Dashboard        | postgres | PostgreSQL host                       |
| `POSTGRES_USER`          | Dashboard        | soc_user | PostgreSQL username                   |
| `POSTGRES_PASSWORD`      | Dashboard        | soc_password | PostgreSQL password               |
| `POSTGRES_DB`            | Dashboard        | soc_db   | PostgreSQL database name              |
| `PORT`                   | Dashboard        | 3000     | Dashboard API port                    |

---

## Ports

| Port | Service           |
| ---- | ----------------- |
| 8080 | Frontend (Nginx)  |
| 3000 | Dashboard API     |
| 3001 | Producer (ingest) |
| 9092 | Kafka             |
| 2181 | Zookeeper         |
| 5432 | PostgreSQL        |
| 6379 | Redis             |

---

## Adding a New Agent

1. Create a new folder:
   ```
   my-agent/
     src/
       consumer.ts
       agents/
         myAgent.ts
     package.json
     tsconfig.json
     Dockerfile
   ```

2. Write your agent logic in `myAgent.ts` — subscribe to `security_logs` or `alerts` Kafka topic, process events, and optionally publish to `alerts`.

3. Add the service to `docker-compose.yml`:
   ```yaml
   my-agent:
     build: ./my-agent
     container_name: my-agent
     depends_on:
       - kafka
       - redis
     environment:
       KAFKA_BROKER: kafka:9092
       REDIS_HOST: redis
     restart: always
   ```

4. Run `docker-compose up --build`.

---

## Project Structure

```
Agentic-AI-SOC/
  producer/                # Log ingestion + simulation
    src/main.ts
  detection-agent/         # Brute-force detection (SSH + Windows)
    src/agents/detectionAgent.ts
  anomaly-agent/           # Behavioral anomaly detection
    src/agents/anomalyAgent.ts
  enrichment-agent/        # AbuseIPDB threat intel + IP enrichment
    src/agents/enrichmentAgent.ts
  response-agent/          # Auto IP blocking + alert counting
    src/agents/responseAgent.ts
  dashboard-service/       # REST API + WebSocket + PostgreSQL
    src/main.ts
  frontend/                # Web dashboard (HTML/CSS/JS)
    index.html
    app.js
    style.css
  windows-log-sender.ps1   # Windows Event Log → Producer bridge
  macos-log-sender.sh      # macOS Unified Log → Producer bridge
  docker-compose.yml       # Full orchestration (9 containers)
  readme.md
```
