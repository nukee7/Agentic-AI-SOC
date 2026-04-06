import express, {
  Request,
  Response
} from "express"

import { Client } from "pg"

import http from "http"

import {
  WebSocket,
  WebSocketServer
} from "ws"

import { Kafka } from "kafkajs"

/*
CONFIG
*/

const PORT =
  Number(process.env.PORT) || 3000

const KAFKA_BROKER =
  process.env.KAFKA_BROKER || "kafka:9092"

const POSTGRES_HOST =
  process.env.POSTGRES_HOST || "postgres"

const POSTGRES_USER =
  process.env.POSTGRES_USER || "soc_user"

const POSTGRES_PASSWORD =
  process.env.POSTGRES_PASSWORD || "soc_password"

const POSTGRES_DB =
  process.env.POSTGRES_DB || "soc_db"

const METRIC_INTERVAL_MS =
  Number(process.env.METRIC_INTERVAL_MS) || 5000

/*
SERVICES
*/

const app = express()

const server =
  http.createServer(app)

/*
WebSocket server with explicit /ws route
*/

const wss =
  new WebSocketServer({
    noServer: true
  })

/*
Attach WebSocket upgrade handler
*/

server.on(
  "upgrade",
  (
    request,
    socket,
    head
  ) => {

    if (
      request.url === "/ws"
    ) {

      wss.handleUpgrade(
        request,
        socket,
        head,
        (ws) => {

          wss.emit(
            "connection",
            ws,
            request
          )

        }
      )

    }

    else {

      socket.destroy()

    }

  }
)

/*
WebSocket connection
*/

wss.on(
  "connection",
  (
    ws: WebSocket
  ) => {

    console.log(
      "WebSocket client connected"
    )

    ws.on(
      "close",
      () => {

        console.log(
          "WebSocket client disconnected"
        )

      }
    )

  }
)

/*
PostgreSQL
*/

const pgClient =
  new Client({

    host: POSTGRES_HOST,

    port: 5432,

    user: POSTGRES_USER,

    password: POSTGRES_PASSWORD,

    database: POSTGRES_DB

  })

/*
DATABASE INIT
*/

async function initDatabase() {

  await pgClient.connect()

  console.log(
    "Connected to PostgreSQL"
  )

  await pgClient.query(`
    CREATE TABLE IF NOT EXISTS alerts (
      alert_id TEXT PRIMARY KEY,
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      rule_id TEXT,
      rule_name TEXT,
      severity TEXT,
      source_ip TEXT,
      username TEXT,
      attempts INT,
      window_seconds INT,
      description TEXT
    )
  `)

  await pgClient.query(`
    CREATE TABLE IF NOT EXISTS incidents (
      incident_id TEXT PRIMARY KEY,
      title TEXT,
      severity TEXT,
      source_ip TEXT,
      username TEXT,
      attempts INT,
      status TEXT DEFAULT 'OPEN',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  await pgClient.query(`
    CREATE TABLE IF NOT EXISTS responses (
      response_id TEXT PRIMARY KEY,
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      action TEXT,
      source_ip TEXT,
      reason TEXT,
      severity TEXT
    )
  `)

  console.log("Database tables ready")

}

/*
KAFKA CONSUMER — writes alerts from detection agents to PostgreSQL
*/

async function startAlertConsumer() {

  const kafka = new Kafka({
    clientId: "dashboard-intelligence",
    brokers: [KAFKA_BROKER]
  })

  const consumer = kafka.consumer({
    groupId: "dashboard-db-writer"
  })

  await consumer.connect()
  await consumer.subscribe({ topic: "alerts", fromBeginning: false })

  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        const alert = JSON.parse(message.value!.toString())

        await pgClient.query(
          `INSERT INTO alerts (
            alert_id, timestamp, rule_id, rule_name, severity,
            source_ip, username, attempts, window_seconds, description
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (alert_id) DO NOTHING`,
          [
            alert.alertId,
            alert.timestamp || new Date().toISOString(),
            alert.ruleId,
            alert.ruleName,
            alert.severity,
            alert.sourceIp,
            alert.username,
            alert.attempts || 0,
            alert.windowSeconds || 60,
            alert.description
          ]
        )

        console.log(`[ALERT SAVED] ${alert.severity} — ${alert.sourceIp} — ${alert.description}`)

      } catch (err) {
        console.error("Failed to save alert:", err)
      }
    }
  })

  console.log("Kafka alert consumer started")

  const incidentConsumer = kafka.consumer({
    groupId: "dashboard-incident-writer"
  })

  await incidentConsumer.connect()
  await incidentConsumer.subscribe({ topic: "incidents", fromBeginning: false })

  await incidentConsumer.run({
    eachMessage: async ({ message }) => {
      try {
        const incident = JSON.parse(message.value!.toString())

        await pgClient.query(
          `INSERT INTO incidents (
            incident_id, title, severity, source_ip,
            username, attempts, status, created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (incident_id) DO NOTHING`,
          [
            incident.incidentId,
            incident.title,
            incident.severity,
            incident.sourceIp,
            incident.username,
            incident.attempts || 0,
            incident.status || "OPEN",
            incident.createdAt || new Date().toISOString()
          ]
        )

        console.log(`[INCIDENT SAVED] ${incident.severity} — ${incident.sourceIp} — ${incident.title}`)

      } catch (err) {
        console.error("Failed to save incident:", err)
      }
    }
  })

  console.log("Kafka incident consumer started")

  const responseConsumer = kafka.consumer({
    groupId: "dashboard-response-writer"
  })

  await responseConsumer.connect()
  await responseConsumer.subscribe({ topic: "responses", fromBeginning: false })

  await responseConsumer.run({
    eachMessage: async ({ message }) => {
      try {
        const resp = JSON.parse(message.value!.toString())

        await pgClient.query(
          `INSERT INTO responses (
            response_id, timestamp, action, source_ip, reason, severity
          ) VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (response_id) DO NOTHING`,
          [
            resp.responseId,
            resp.timestamp || new Date().toISOString(),
            resp.action,
            resp.sourceIp,
            resp.reason,
            resp.severity
          ]
        )

        console.log(`[RESPONSE SAVED] ${resp.action} — ${resp.sourceIp}`)

      } catch (err) {
        console.error("Failed to save response:", err)
      }
    }
  })

  console.log("Kafka response consumer started")

}

/*
METRICS QUERIES
*/

async function getSummaryMetrics() {

  const alertsLast5Minutes =
    await pgClient.query(

      `
      SELECT COUNT(*)
      FROM alerts
      WHERE timestamp >=
      NOW() - INTERVAL '5 minutes'
      `
    )

  const incidentsOpen =
    await pgClient.query(

      `
      SELECT COUNT(*)
      FROM incidents
      WHERE status = 'OPEN'
      `
    )
    .catch(
      () => ({
        rows: [{ count: 0 }]
      })
    )

  return {

    alertsLast5Minutes:
      Number(
        alertsLast5Minutes
          .rows[0].count
      ),

    incidentsOpen:
      Number(
        incidentsOpen
          .rows[0].count
      )

  }

}

async function getTopSourceIps() {

  const result =
    await pgClient.query(

      `
      SELECT
        source_ip,
        COUNT(*) AS count
      FROM alerts
      GROUP BY source_ip
      ORDER BY count DESC
      LIMIT 10
      `
    )

  return result.rows

}

async function getAlertsBySeverity() {

  const result =
    await pgClient.query(

      `
      SELECT
        severity,
        COUNT(*) AS count
      FROM alerts
      GROUP BY severity
      `
    )

  return result.rows

}

async function getAlertsTimeline() {

  const result =
    await pgClient.query(

      `
      SELECT
        DATE_TRUNC(
          'hour',
          timestamp
        ) AS hour,

        COUNT(*) AS count
      FROM alerts
      GROUP BY hour
      ORDER BY hour
      `
    )

  return result.rows

}

/*
COLLECT METRICS
*/

async function collectMetrics() {

  const summary =
    await getSummaryMetrics()

  const topIps =
    await getTopSourceIps()

  const severity =
    await getAlertsBySeverity()

  const timeline =
    await getAlertsTimeline()

  const responses =
    await pgClient.query(
      `SELECT response_id, timestamp, action, source_ip, reason, severity
       FROM responses
       ORDER BY timestamp DESC
       LIMIT 20`
    ).then(r => r.rows).catch(() => [])

  return {

    summary,

    topIps,

    severity,

    timeline,

    responses,

    generatedAt:
      new Date().toISOString()

  }

}

/*
BROADCAST
*/

function broadcastMetrics(
  data: any
) {

  console.log(
    "Broadcasting metrics to",
    wss.clients.size,
    "clients"
  )

  wss.clients.forEach(
    (client: WebSocket) => {

      if (
        client.readyState ===
        WebSocket.OPEN
      ) {

        client.send(
          JSON.stringify({

            type:
              "metrics_update",

            data

          })
        )

      }

    }
  )

}

/*
METRICS LOOP
*/

async function startMetricsLoop() {

  console.log(
    "Metrics loop started"
  )

  setInterval(
    async () => {

      try {

        const metrics =
          await collectMetrics()

        broadcastMetrics(
          metrics
        )

      }

      catch (err) {

        console.error(
          "Metrics error",
          err
        )

      }

    },

    METRIC_INTERVAL_MS
  )

}

/*
API ROUTES
*/

app.get(
  "/api/metrics/summary",
  async (
    req: Request,
    res: Response
  ) => {

    const data =
      await getSummaryMetrics()

    res.json(data)

  }
)

app.get(
  "/api/metrics/top-ips",
  async (
    req: Request,
    res: Response
  ) => {

    const data =
      await getTopSourceIps()

    res.json(data)

  }
)

app.get(
  "/api/metrics/severity",
  async (
    req: Request,
    res: Response
  ) => {

    const data =
      await getAlertsBySeverity()

    res.json(data)

  }
)

app.get(
  "/api/metrics/timeline",
  async (
    req: Request,
    res: Response
  ) => {

    const data =
      await getAlertsTimeline()

    res.json(data)

  }
)

app.get(
  "/api/metrics/responses",
  async (
    req: Request,
    res: Response
  ) => {

    const result =
      await pgClient.query(
        `SELECT response_id, timestamp, action, source_ip, reason, severity
         FROM responses
         ORDER BY timestamp DESC
         LIMIT 20`
      )

    res.json(result.rows)

  }
)

/*
HEALTH
*/

app.get(
  "/health",
  (
    req,
    res
  ) => {

    res.json({

      status: "ok",

      service:
        "dashboard-intelligence"

    })

  }
)

/*
START
*/

async function start() {

  try {

    await initDatabase()

    await startAlertConsumer()

    await startMetricsLoop()

    server.listen(

      PORT,

      () => {

        console.log(
          "Dashboard Intelligence running on port",
          PORT
        )

      }

    )

  }

  catch (err) {

    console.error(
      "Startup error",
      err
    )

  }

}

start()

/*
SHUTDOWN
*/

async function shutdown() {

  console.log(
    "Shutting down service"
  )

  await pgClient.end()

  process.exit(0)

}

process.on(
  "SIGINT",
  shutdown
)

process.on(
  "SIGTERM",
  shutdown
)