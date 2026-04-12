# Presentation Script — Agentic AI SOC Platform
### Team Avengers: Nikhil Kumar (23BDS038), Shreevats (23BDS055), Vishavjeet Yadav (23BDS069)
---

## OPENING (30 seconds)

Good morning/afternoon, sir. We are Team Avengers — Nikhil, Shreevats, and Vishavjeet. Today we're presenting our project: **Agentic AI Security Operations Center** — a real-time platform that automatically detects cyber attacks and responds to them without any human intervention.

---

## THE PROBLEM (45 seconds)

In today's world, organizations face thousands of security events every second — failed logins, unauthorized access attempts, privilege escalation attacks. Traditional SOCs rely on human analysts to manually review these events, but that creates two major problems:

1. **Alert fatigue** — analysts get overwhelmed by the volume and start missing real threats.
2. **Slow response** — the average time to detect a breach is over 200 days according to IBM's 2024 report.

Our question was simple: **Can we build a system where specialized software agents automatically detect and respond to attacks in real time, without waiting for a human?**

---

## OUR SOLUTION (1 minute)

We built an **event-driven microservices platform** with three autonomous agents, each handling one part of the security workflow:

1. **Enrichment Agent** — takes raw security events and enriches them with context like IP classification, login timing, and root attempt detection. It also detects brute-force attacks using a sliding window algorithm.

2. **Anomaly Agent** — looks for behavioral anomalies: logins at unusual hours, logins from never-before-seen IP addresses, and privilege escalation attempts.

3. **Response Agent** — when a high-severity alert is generated, this agent automatically blocks the attacker's IP address using iptables firewall rules. It auto-unblocks after one hour to prevent permanent lockout from false positives.

These agents don't talk to each other directly. They communicate through **Apache Kafka** — a distributed message broker. This means each agent works independently, can be scaled separately, and if one crashes, the others keep running.

---

## ARCHITECTURE WALKTHROUGH (1.5 minutes)

Let me walk you through the data flow:

**Step 1 — Ingestion:** Security logs come in from multiple sources — Linux SSH logs, Windows Event Logs, or macOS system logs. They hit our **Producer service** via HTTP on port 3001, which parses them into a standard format and publishes to Kafka's `security_logs` topic.

**Step 2 — Parallel Detection:** Both the Enrichment Agent and Anomaly Agent consume from this same topic simultaneously, using separate Kafka consumer groups. This is key — they process the same events in parallel without interfering with each other.

**Step 3 — Alert Generation:** When either agent detects a threat, it publishes an alert to the `alerts` topic. The Enrichment Agent also creates incident records for brute-force attacks.

**Step 4 — Automated Response:** The Response Agent consumes alerts. For high-severity ones, it executes `iptables -A INPUT -s <attacker-ip> -j DROP` to block the IP at the kernel level. It tracks blocked IPs in Redis with a one-hour TTL and automatically unblocks them when the timer expires.

**Step 5 — Dashboard:** Everything flows into our Dashboard Intelligence service, which persists data to PostgreSQL and pushes live updates to our React frontend via WebSocket every 5 seconds.

---

## TECHNOLOGY STACK (30 seconds)

Our stack:
- **TypeScript on Node.js 20** for all services
- **Apache Kafka** as the message broker — gives us decoupling and replay capability
- **Redis** for transient state — failure counters, deduplication, blocked IP tracking
- **PostgreSQL** for persistent storage of alerts, incidents, and responses
- **React 19 with Vite** for the live dashboard
- **Docker Compose** orchestrating all 9 containers

---

## KEY ALGORITHMS (1 minute)

Let me highlight two key algorithms:

### Brute-Force Detection (Enrichment Agent)
We use a **sliding window counter** in Redis:
- Every failed login increments a counter keyed by IP: `INCR failures:<ip>`
- On the first failure, we set a 60-second TTL on that key
- If the counter reaches 5 within that window, we fire an alert
- We then set a deduplication flag for 5 minutes so we don't spam alerts for the same IP
- This is memory-efficient — Redis auto-expires the keys, no cleanup needed

### New IP Detection (Anomaly Agent)
- For every successful login, we check Redis for the key `seen_ip:<username>:<ip>`
- If the key doesn't exist, this is a new IP for that user — we fire an alert
- We then set the key with a 24-hour TTL, building a rolling baseline
- This catches account compromise from unusual locations

---

## LIVE DEMO (2 minutes)

*[Open browser to http://localhost:8080]*

This is our live dashboard. You can see:
- **Stats cards** showing alerts in the last 5 minutes and open incidents
- **Severity distribution** chart
- **Top attacking IPs** ranked by frequency
- **Response Actions table** — this is the most important part

Now let me simulate an attack. I'll run our attack simulator script from the terminal:

*[Run: `./attack-simulator.sh localhost` or send curl commands]*

```bash
# Brute-force attack — 7 failed SSH logins
for i in $(seq 1 7); do
  curl -s -X POST http://localhost:3001/ingest \
    -H "Content-Type: application/json" \
    -d '{"host":"prod-server","service":"sshd","logType":"authentication","severity":"warning","sourceIp":"192.168.50.99","username":"root","message":"Failed password for root from 192.168.50.99 port 22 ssh2","rawLog":"Failed password for root from 192.168.50.99 port 22 ssh2"}'
  sleep 1
done
```

Watch the dashboard — after the 5th attempt, the Enrichment Agent fires an `AUTH_BRUTE_FORCE` alert, creates an incident, and the Response Agent immediately blocks the IP. You can see it appear in the Response Actions table as `BLOCKED`.

If I send more events from the same IP, you'll see it say `ALREADY_BLOCKED` — that's our deduplication working.

Now let me send a privilege escalation:

```bash
curl -s -X POST http://localhost:3001/ingest \
  -H "Content-Type: application/json" \
  -d '{"host":"prod-server","service":"sudo","logType":"privilege-escalation","severity":"critical","sourceIp":"10.20.30.40","username":"attacker","message":"user attacker attempted sudo su root","rawLog":"user attacker attempted sudo su root"}'
```

The Anomaly Agent catches this as `PRIVILEGE_ESCALATION_ATTEMPT` with high severity, and the Response Agent blocks this IP too.

*[Point to the dashboard showing the new entries]*

As you can see — from the moment an attack happens to the IP being blocked, it takes less than 50 milliseconds. That's fully automated detection and response.

---

## MULTI-PLATFORM SUPPORT (30 seconds)

Our system isn't limited to simulated events. We've built forwarder scripts for real environments:
- **Linux/macOS**: A shell script that streams SSH authentication events using the system's unified logging
- **Windows**: A PowerShell script that polls Windows Security Event Log for Event IDs 4624, 4625, and 4648
- **Any platform**: Direct HTTP POST to our `/ingest` endpoint

We also have an **attack simulator script** that can be run from a separate laptop on the same network to test all 6 attack scenarios against the SOC.

---

## DESIGN PATTERNS (30 seconds)

We've applied several distributed systems design patterns:
- **Event Sourcing** — all events go through Kafka, giving us full replay and audit trail
- **CQRS** — detection (write path) is separate from dashboard queries (read path)
- **Bulkhead** — each agent in its own container, so failures don't cascade
- **Sliding Window** — efficient temporal counting for brute-force detection
- **Idempotent Consumer** — PostgreSQL `ON CONFLICT DO NOTHING` prevents duplicates even on message replay

---

## RESULTS & ACHIEVEMENTS (30 seconds)

To summarize what we achieved:
- **Sub-50ms** end-to-end latency from event to dashboard
- **3 autonomous agents** operating in parallel without coordination
- **6 attack scenarios** fully detected and responded to automatically
- **Multi-platform** log ingestion — Linux, Windows, macOS
- **Self-healing state** — Redis TTLs auto-expire, Response Agent recovers on restart
- **Zero manual intervention** required for detection and response

---

## FUTURE SCOPE (30 seconds)

For future work, we envision:
1. **Machine learning models** replacing rule-based detection for adaptive threat scoring
2. **Additional threat intelligence feeds** like VirusTotal and MaxMind GeoIP
3. **SOAR integration** for complex multi-step response playbooks
4. **LLM-powered analysis** to generate natural-language incident summaries for analysts

---

## CLOSING (15 seconds)

In conclusion, our Agentic AI SOC demonstrates that autonomous software agents, communicating through event streams, can achieve real-time threat detection and automated response — significantly reducing the time between attack and mitigation. Thank you, sir. We're happy to take any questions.

---

## POTENTIAL QUESTIONS & ANSWERS

**Q: Why didn't you use machine learning for detection?**
A: We chose rule-based detection first to establish a reliable baseline. Rules are deterministic, explainable, and have zero false positives for known attack patterns. ML would be the natural next step for detecting unknown threats.

**Q: Why Kafka instead of a simpler queue like RabbitMQ?**
A: Kafka gives us two key advantages — multiple consumers can independently read the same topic (our Enrichment and Anomaly agents both consume `security_logs`), and Kafka retains messages, so we can replay events for debugging or new agent onboarding.

**Q: What happens if the Response Agent goes down?**
A: The other agents keep running — alerts still get generated and stored. When the Response Agent restarts, it recovers its state from Redis, re-applies any active firewall blocks, and starts processing new alerts from where it left off (Kafka consumer offset tracking).

**Q: How do you prevent blocking legitimate users?**
A: Three safeguards: (1) Protected IP list — localhost and internal IPs are never blocked. (2) Only high-severity alerts trigger blocks. (3) All blocks auto-expire after 1 hour via Redis TTL, so even false positives self-correct.

**Q: Can this scale to enterprise level?**
A: Yes. Each agent uses Kafka consumer groups, so you can run 5 instances of the Enrichment Agent and Kafka will distribute partitions across them. Redis and PostgreSQL can be clustered. The architecture is horizontally scalable by design.

**Q: How is this different from a SIEM like Splunk?**
A: SIEMs are primarily for log aggregation and search — they alert, but don't act. Our system goes beyond detection to automated response. Also, SIEMs are monolithic; our agent-based architecture allows independent scaling and development of each detection capability.

**Q: What's the sliding window algorithm?**
A: Instead of storing every event timestamp and counting, we use Redis's atomic `INCR` command with a TTL. The first failure starts a 60-second timer. Each subsequent failure increments the counter. After 60 seconds, Redis auto-deletes the key, resetting the window. This gives us O(1) memory per IP regardless of event volume.

**Q: Why TypeScript and not Python?**
A: Node.js excels at I/O-bound tasks like consuming Kafka messages and making Redis calls — its event loop handles thousands of concurrent connections efficiently. TypeScript adds type safety, making the codebase more maintainable. Python would be better if we were doing heavy ML computation.

**Q: How do you handle duplicate alerts?**
A: At two levels — (1) Redis deduplication: after alerting on an IP, we set a 5-minute suppression window so the same IP doesn't generate repeated alerts. (2) PostgreSQL level: `INSERT ... ON CONFLICT DO NOTHING` ensures the same alert ID is never stored twice.

**Q: What if an attacker spoofs their IP?**
A: IP spoofing is a valid concern for UDP-based attacks, but our system primarily monitors TCP-based authentication events (SSH, RDP) where spoofing is impractical due to the TCP handshake. The source IP in these events is reliable.
