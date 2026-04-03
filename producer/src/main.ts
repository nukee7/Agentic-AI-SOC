import fs from "fs"
import http from "http"
import readline from "readline"
import crypto from "crypto"
import { Kafka } from "kafkajs"

/*
CONFIG
*/

const kafka = new Kafka({
  clientId: "linux-log-producer",
  brokers: [process.env.KAFKA_BROKER || "kafka:9092"]
})

const producer = kafka.producer()
const TOPIC = "security_logs"
const INGEST_PORT = 3001
const HOSTNAME = process.env.HOSTNAME || "unknown-host"

/*
Log paths across systems — Docker on Windows will use simulation
since /var/log/auth.log won't exist inside the container
*/

const LOG_PATHS = [
  "/var/log/auth.log",    // Ubuntu / Debian / Kali
  "/var/log/secure",      // RHEL / CentOS / Amazon Linux
  "/var/log/system.log",  // macOS
]

/*
EVENT STRUCTURE
*/

interface SecurityEvent {
  eventId: string
  timestamp: string
  host: string
  service: string
  logType: string
  severity: "info" | "warning" | "critical"
  sourceIp: string
  username: string
  message: string
  rawLog: string
}

/*
LOG PARSER
Extracts structured fields from raw auth log lines
*/

function parseLine(rawLog: string): SecurityEvent | null {

  const patterns = [
    {
      regex: /Failed password for (?:invalid user )?(\S+) from (\d+\.\d+\.\d+\.\d+)/,
      severity: "warning" as const,
      logType: "authentication",
      buildMessage: (m: RegExpMatchArray) =>
        `Failed password for user ${m[1]} from ${m[2]}`
    },
    {
      regex: /Accepted (?:password|publickey) for (\S+) from (\d+\.\d+\.\d+\.\d+)/,
      severity: "info" as const,
      logType: "authentication",
      buildMessage: (m: RegExpMatchArray) =>
        `Successful login for user ${m[1]} from ${m[2]}`
    },
    {
      regex: /Invalid user (\S+) from (\d+\.\d+\.\d+\.\d+)/,
      severity: "warning" as const,
      logType: "authentication",
      buildMessage: (m: RegExpMatchArray) =>
        `Invalid user ${m[1]} attempted login from ${m[2]}`
    },
    {
      regex: /sudo:.*authentication failure.*user=(\S+)/,
      severity: "critical" as const,
      logType: "privilege-escalation",
      buildMessage: (m: RegExpMatchArray) =>
        `Sudo authentication failure for user ${m[1]}`,
      sourceIp: "127.0.0.1"
    },
    {
      regex: /session opened for user (\S+)/,
      severity: "info" as const,
      logType: "session",
      buildMessage: (m: RegExpMatchArray) =>
        `Session opened for user ${m[1]}`,
      sourceIp: "127.0.0.1"
    },
  ]

  for (const pattern of patterns) {
    const match = rawLog.match(pattern.regex)
    if (match) {
      return {
        eventId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        host: HOSTNAME,
        service: "linux-auth",
        logType: pattern.logType,
        severity: pattern.severity,
        sourceIp: pattern.sourceIp ?? match[2] ?? "0.0.0.0",
        username: match[1],
        message: pattern.buildMessage(match),
        rawLog
      }
    }
  }

  return null
}

/*
SEND TO KAFKA
*/

async function sendEvent(event: SecurityEvent) {
  await producer.send({
    topic: TOPIC,
    messages: [{ value: JSON.stringify(event) }]
  })
  console.log(`[${event.severity.toUpperCase()}] ${event.message}`)
}

/*
TAIL LOG FILE
Reads existing content then watches for new lines
*/

function tailFile(logFile: string) {

  console.log(`Streaming log file: ${logFile}`)

  let filePosition = 0

  const stream = fs.createReadStream(logFile, { encoding: "utf8" })
  const rl = readline.createInterface({ input: stream })

  rl.on("line", async (line) => {
    const event = parseLine(line)
    if (event) await sendEvent(event)
  })

  rl.on("close", () => {
    filePosition = fs.statSync(logFile).size
    console.log("Initial read complete — watching for new entries...")

    fs.watchFile(logFile, { interval: 1000 }, async () => {
      const stat = fs.statSync(logFile)
      if (stat.size <= filePosition) return

      const newStream = fs.createReadStream(logFile, {
        encoding: "utf8",
        start: filePosition,
        end: stat.size
      })
      const newRl = readline.createInterface({ input: newStream })

      newRl.on("line", async (line) => {
        const event = parseLine(line)
        if (event) await sendEvent(event)
      })

      newRl.on("close", () => {
        filePosition = stat.size
      })
    })
  })
}

/*
HTTP INGESTION SERVER
Lets the Windows host POST events directly to the pipeline.

  POST http://localhost:3001/ingest
  Content-Type: application/json
  Body: { eventId, timestamp, host, service, logType,
          severity, sourceIp, username, message, rawLog }

Use the windows-log-sender.ps1 script on the host to feed
real Windows Security Event Log entries here.
*/

function startIngestionServer() {

  const server = http.createServer(async (req, res) => {

    if (req.method === "POST" && req.url === "/ingest") {

      let body = ""
      req.on("data", chunk => { body += chunk })
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body)

          const event: SecurityEvent = {
            eventId:   parsed.eventId   || crypto.randomUUID(),
            timestamp: parsed.timestamp || new Date().toISOString(),
            host:      parsed.host      || HOSTNAME,
            service:   parsed.service   || "windows-security",
            logType:   parsed.logType   || "authentication",
            severity:  parsed.severity  || "warning",
            sourceIp:  parsed.sourceIp  || "0.0.0.0",
            username:  parsed.username  || "unknown",
            message:   parsed.message   || parsed.rawLog || "",
            rawLog:    parsed.rawLog    || parsed.message || ""
          }

          await sendEvent(event)
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ ok: true, eventId: event.eventId }))

        } catch {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Invalid JSON" }))
        }
      })

    } else if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "ok" }))

    } else {
      res.writeHead(404)
      res.end()
    }
  })

  server.listen(INGEST_PORT, "0.0.0.0", () => {
    console.log(`HTTP ingestion listening on port ${INGEST_PORT}`)
    console.log(`POST events to http://localhost:${INGEST_PORT}/ingest`)
  })
}

/*
SIMULATION MODE
Runs when no system log file is found (e.g. Docker on Windows).
Simulates realistic SSH auth events for testing the full pipeline.
*/

function startSimulation() {

  console.log("No system log found — running simulation mode")
  console.log("Use POST http://localhost:3001/ingest to push real events from Windows")

  const scenarios: { rawLog: string; interval: number }[] = [
    {
      rawLog: "Failed password for invalid user root from 192.168.1.105 port 22 ssh2",
      interval: 3000
    },
    {
      rawLog: "Failed password for admin from 10.0.0.55 port 22 ssh2",
      interval: 7000
    },
    {
      rawLog: "Accepted password for deploy from 192.168.1.1 port 22 ssh2",
      interval: 15000
    },
    {
      rawLog: "Invalid user oracle from 203.0.113.42 port 22 ssh2",
      interval: 5000
    },
    {
      rawLog: "sudo: pam_unix(sudo:auth): authentication failure; logname= uid=1000 euid=0 tty=/dev/pts/0 ruser=ubuntu rhost=  user=ubuntu",
      interval: 20000
    }
  ]

  for (const scenario of scenarios) {
    setInterval(async () => {
      const event = parseLine(scenario.rawLog)
      if (event) await sendEvent(event)
    }, scenario.interval)
  }
}

/*
START
*/

async function start() {
  await producer.connect()
  console.log("Producer connected to Kafka")

  startIngestionServer()

  const logFile = LOG_PATHS.find(p => fs.existsSync(p))

  if (logFile) {
    tailFile(logFile)
  } else {
    startSimulation()
  }
}

start().catch(err => {
  console.error("Producer fatal error:", err)
  process.exit(1)
})
