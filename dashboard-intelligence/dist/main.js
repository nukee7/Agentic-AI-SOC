"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const pg_1 = require("pg");
const http_1 = __importDefault(require("http"));
const ws_1 = require("ws");
/*
CONFIG
*/
const PORT = Number(process.env.PORT) || 3000;
const POSTGRES_HOST = process.env.POSTGRES_HOST || "postgres";
const POSTGRES_USER = process.env.POSTGRES_USER || "soc_user";
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || "soc_password";
const POSTGRES_DB = process.env.POSTGRES_DB || "soc_db";
const METRIC_INTERVAL_MS = Number(process.env.METRIC_INTERVAL_MS) || 5000;
/*
SERVICES
*/
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
const wss = new ws_1.WebSocketServer({
    server
});
const pgClient = new pg_1.Client({
    host: POSTGRES_HOST,
    port: 5432,
    user: POSTGRES_USER,
    password: POSTGRES_PASSWORD,
    database: POSTGRES_DB
});
/*
DATABASE INIT
*/
async function initDatabase() {
    await pgClient.connect();
    console.log("Connected to PostgreSQL");
}
/*
METRICS
*/
async function getSummaryMetrics() {
    const alertsLast5Minutes = await pgClient.query(`
      SELECT COUNT(*)
      FROM alerts
      WHERE timestamp >=
      NOW() - INTERVAL '5 minutes'
      `);
    const incidentsOpen = await pgClient.query(`
      SELECT COUNT(*)
      FROM incidents
      WHERE status = 'OPEN'
      `);
    return {
        alertsLast5Minutes: Number(alertsLast5Minutes
            .rows[0].count),
        incidentsOpen: Number(incidentsOpen
            .rows[0].count)
    };
}
async function getTopSourceIps() {
    const result = await pgClient.query(`
      SELECT
        source_ip,
        COUNT(*) AS count
      FROM alerts
      GROUP BY source_ip
      ORDER BY count DESC
      LIMIT 10
      `);
    return result.rows;
}
async function getAlertsBySeverity() {
    const result = await pgClient.query(`
      SELECT
        severity,
        COUNT(*) AS count
      FROM alerts
      GROUP BY severity
      `);
    return result.rows;
}
async function getAlertsTimeline() {
    const result = await pgClient.query(`
      SELECT
        DATE_TRUNC(
          'hour',
          timestamp
        ) AS hour,

        COUNT(*)
      FROM alerts
      GROUP BY hour
      ORDER BY hour
      `);
    return result.rows;
}
/*
COMBINED METRICS
*/
async function collectMetrics() {
    const summary = await getSummaryMetrics();
    const topIps = await getTopSourceIps();
    const severity = await getAlertsBySeverity();
    const timeline = await getAlertsTimeline();
    return {
        summary,
        topIps,
        severity,
        timeline,
        generatedAt: new Date().toISOString()
    };
}
/*
WEBSOCKET
*/
function broadcastMetrics(data) {
    wss.clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(JSON.stringify({
                type: "metrics_update",
                data
            }));
        }
    });
}
async function startMetricsLoop() {
    console.log("Metrics loop started");
    setInterval(async () => {
        try {
            const metrics = await collectMetrics();
            broadcastMetrics(metrics);
        }
        catch (err) {
            console.error("Metrics error", err);
        }
    }, METRIC_INTERVAL_MS);
}
/*
API ROUTES
*/
app.get("/metrics/summary", async (req, res) => {
    const data = await getSummaryMetrics();
    res.json(data);
});
app.get("/metrics/top-ips", async (req, res) => {
    const data = await getTopSourceIps();
    res.json(data);
});
app.get("/metrics/severity", async (req, res) => {
    const data = await getAlertsBySeverity();
    res.json(data);
});
app.get("/metrics/timeline", async (req, res) => {
    const data = await getAlertsTimeline();
    res.json(data);
});
/*
HEALTH CHECK
*/
app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        service: "dashboard-intelligence"
    });
});
/*
STARTUP
*/
async function start() {
    try {
        await initDatabase();
        await startMetricsLoop();
        server.listen(PORT, () => {
            console.log("Dashboard Intelligence running on port", PORT);
        });
    }
    catch (err) {
        console.error("Startup error", err);
    }
}
start();
/*
SHUTDOWN
*/
async function shutdown() {
    console.log("Shutting down service");
    await pgClient.end();
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
