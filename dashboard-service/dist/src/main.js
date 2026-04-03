"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const kafkajs_1 = require("kafkajs");
/*
CONFIG
*/
const PORT = 3000;
const kafka = new kafkajs_1.Kafka({
    clientId: "dashboard-service",
    brokers: [
        process.env.KAFKA_BROKER ||
            "kafka:9092"
    ]
});
const consumer = kafka.consumer({
    groupId: "dashboard-group"
});
/*
IN-MEMORY STORAGE
*/
const alerts = [];
/*
KAFKA CONSUMER
*/
async function startKafka() {
    console.log("Dashboard service connecting to Kafka");
    await consumer.connect();
    await consumer.subscribe({
        topic: "alerts",
        fromBeginning: true
    });
    console.log("Subscribed to alerts topic");
    await consumer.run({
        eachMessage: async ({ message }) => {
            const value = message.value?.toString();
            if (!value)
                return;
            const alert = JSON.parse(value);
            alerts.push(alert);
            console.log("Alert received:", alert.ruleName);
        }
    });
}
/*
API SERVER
*/
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
/*
GET ALL ALERTS
*/
app.get("/alerts", (req, res) => {
    res.json(alerts);
});
/*
GET STATS
*/
app.get("/stats", (req, res) => {
    const total = alerts.length;
    const high = alerts.filter(a => a.severity === "high").length;
    res.json({
        totalAlerts: total,
        highSeverity: high
    });
});
/*
HEALTH CHECK
*/
app.get("/health", (req, res) => {
    res.json({
        status: "ok"
    });
});
app.listen(PORT, () => {
    console.log("Dashboard API running on port", PORT);
});
startKafka();
