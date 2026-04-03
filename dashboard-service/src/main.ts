import express from "express"
import { Kafka } from "kafkajs"
import { Client } from "pg"
import { WebSocketServer } from "ws"
import http from "http"

/*
CONFIGURATION
*/

const PORT =
  Number(process.env.PORT) || 3000

const KAFKA_BROKER =
  process.env.KAFKA_BROKER ||
  "kafka:9092"

const POSTGRES_HOST =
  process.env.POSTGRES_HOST ||
  "postgres"

const POSTGRES_USER =
  process.env.POSTGRES_USER ||
  "soc_user"

const POSTGRES_PASSWORD =
  process.env.POSTGRES_PASSWORD ||
  "soc_password"

const POSTGRES_DB =
  process.env.POSTGRES_DB ||
  "soc_db"

const ALERT_TOPIC =
  process.env.ALERT_TOPIC ||
  "alerts"

/*
SERVICES
*/

const app = express()

const server =
  http.createServer(app)

const wss =
  new WebSocketServer({
    server
  })

const kafka = new Kafka({
  clientId: "dashboard-service",
  brokers: [KAFKA_BROKER]
})

const consumer = kafka.consumer({
  groupId: "dashboard-group"
})

const pgClient = new Client({

  host: POSTGRES_HOST,
  port: 5432,
  user: POSTGRES_USER,
  password: POSTGRES_PASSWORD,
  database: POSTGRES_DB

})

/*
WEBSOCKET CLIENTS
*/

const clients =
  new Set<any>()

wss.on(
  "connection",
  (ws) => {

    console.log(
      "WebSocket client connected"
    )

    clients.add(ws)

    ws.on(
      "close",
      () => {

        clients.delete(ws)

        console.log(
          "WebSocket client disconnected"
        )

      }

    )

  }
)

/*
BROADCAST ALERT
*/

function broadcastAlert(
  alert: any
) {

  const message =
    JSON.stringify(alert)

  clients.forEach(
    (client) => {

      if (
        client.readyState === 1
      ) {

        client.send(message)

      }

    }
  )

}

/*
DATABASE INITIALIZATION
*/

async function initDatabase() {

  await pgClient.connect()

  await pgClient.query(`

    CREATE TABLE IF NOT EXISTS alerts (

      alert_id TEXT PRIMARY KEY,
      timestamp TIMESTAMP,
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

  console.log(
    "PostgreSQL initialized"
  )

}

/*
SAVE ALERT
*/

async function saveAlertToDB(
  alert: any
) {

  try {

    await pgClient.query(

      `
      INSERT INTO alerts (
        alert_id,
        timestamp,
        rule_id,
        rule_name,
        severity,
        source_ip,
        username,
        attempts,
        window_seconds,
        description
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
      )
      ON CONFLICT (alert_id)
      DO NOTHING
      `,

      [
        alert.alertId,
        alert.timestamp,
        alert.ruleId,
        alert.ruleName,
        alert.severity,
        alert.sourceIp,
        alert.username,
        alert.attempts,
        alert.windowSeconds,
        alert.description
      ]

    )

    console.log(
      "Alert saved to database"
    )

  }

  catch (err) {

    console.error(
      "DB insert failed",
      err
    )

  }

}

/*
KAFKA CONSUMER
*/

async function startKafka() {

  while (true) {

    try {

      console.log(
        "Dashboard connecting to Kafka"
      )

      await consumer.connect()

      await consumer.subscribe({

        topic: ALERT_TOPIC,
        fromBeginning: true

      })

      console.log(
        "Subscribed to alerts topic"
      )

      await consumer.run({

        eachMessage:
          async ({
            message
          }) => {

            const value =
              message.value?.toString()

            if (!value)
              return

            let alert

            try {

              alert =
                JSON.parse(value)

            }

            catch {

              console.log(
                "Invalid alert format"
              )

              return

            }

            await saveAlertToDB(alert)

            broadcastAlert(alert)

            console.log(
              "Alert received:",
              alert.ruleName
            )

          }

      })

      break

    }

    catch {

      console.log(
        "Kafka not ready, retrying in 5 seconds"
      )

      await new Promise(
        r => setTimeout(r, 5000)
      )

    }

  }

}

/*
API ROUTES
*/

app.get(
  "/alerts",
  async (
    req,
    res
  ) => {

    try {

      const result =
        await pgClient.query(
          `
          SELECT *
          FROM alerts
          ORDER BY timestamp DESC
          LIMIT 100
          `
        )

      res.json(
        result.rows
      )

    }

    catch {

      res
        .status(500)
        .json({
          error:
            "Failed to fetch alerts"
        })

    }

  }
)

/*
HEALTH CHECK
*/

app.get(
  "/health",
  (
    req,
    res
  ) => {

    res.json({

      status: "ok"

    })

  }
)

/*
STARTUP
*/

async function start() {

  await initDatabase()

  await startKafka()

  server.listen(
    PORT,
    () => {

      console.log(
        "Dashboard running on port",
        PORT
      )

    }
  )

}

start()

/*
SHUTDOWN
*/

async function shutdown() {

  console.log(
    "Shutting down dashboard..."
  )

  await consumer.disconnect()

  await pgClient.end()

  server.close()

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