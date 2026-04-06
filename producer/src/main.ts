import http from "http"
import crypto from "crypto"
import { Kafka } from "kafkajs"

/*
CONFIG
*/

const kafka = new Kafka({
  clientId: "log-producer",
  brokers: [process.env.KAFKA_BROKER || "kafka:9092"]
})

const producer = kafka.producer()
const TOPIC = "security_logs"
const INGEST_PORT = 3001
const HOSTNAME = process.env.HOSTNAME || "unknown-host"

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
HTTP INGESTION SERVER
Accepts real security events from external log forwarders.

  POST http://localhost:3001/ingest
  Content-Type: application/json
  Body: { eventId, timestamp, host, service, logType,
          severity, sourceIp, username, message, rawLog }

Use the log-forwarder.sh script on the host to stream
real macOS/Linux SSH events into this endpoint.
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
            service:   parsed.service   || "unknown",
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
START
*/

async function start() {
  await producer.connect()
  console.log("Producer connected to Kafka")
  console.log("Waiting for real events via /ingest endpoint...")
  startIngestionServer()
}

start().catch(err => {
  console.error("Producer fatal error:", err)
  process.exit(1)
})
