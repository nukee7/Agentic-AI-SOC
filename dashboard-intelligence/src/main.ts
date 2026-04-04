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

/*
CONFIG
*/

const PORT =
  Number(process.env.PORT) || 3000

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

  return {

    summary,

    topIps,

    severity,

    timeline,

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