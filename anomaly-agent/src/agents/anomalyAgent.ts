import { Kafka } from "kafkajs"
import Redis from "ioredis"
import crypto from "crypto"

/*
CONFIG
*/

const KAFKA_BROKER = process.env.KAFKA_BROKER || "kafka:9092"
const REDIS_HOST   = process.env.REDIS_HOST   || "redis"
const INPUT_TOPIC  = "security_logs"
const ALERT_TOPIC  = "alerts"

/*
RULES
*/

const OFF_HOURS_START = 23  // 11 PM
const OFF_HOURS_END   = 6   // 6 AM
const NEW_IP_TTL      = 60 * 60 * 24  // 24 hours

/*
SERVICES
*/

const kafka = new Kafka({
  clientId: "anomaly-agent",
  brokers: [KAFKA_BROKER]
})

const consumer = kafka.consumer({ groupId: "anomaly-group" })
const producer  = kafka.producer()
const redis     = new Redis({ host: REDIS_HOST, port: 6379 })

/*
HELPERS
*/

function isOffHours(timestamp: string): boolean {
  const hour = new Date(timestamp).getUTCHours()
  return hour >= OFF_HOURS_START || hour < OFF_HOURS_END
}

async function isNewIpForUser(username: string, sourceIp: string): Promise<boolean> {
  const key = `seen_ip:${username}:${sourceIp}`
  const exists = await redis.exists(key)
  await redis.setex(key, NEW_IP_TTL, "1")
  return exists === 0
}

async function emitAnomaly(
  ruleName: string,
  description: string,
  severity: "medium" | "high",
  event: Record<string, unknown>
) {
  const alert = {
    alertId:     crypto.randomUUID(),
    timestamp:   new Date().toISOString(),
    ruleId:      ruleName.toUpperCase().replace(/ /g, "_"),
    ruleName,
    severity,
    sourceIp:    event.sourceIp,
    username:    event.username,
    host:        event.host,
    description,
    originalEvent: event
  }

  await producer.send({
    topic: ALERT_TOPIC,
    messages: [{ value: JSON.stringify(alert) }]
  })

  console.log(`[ANOMALY][${severity.toUpperCase()}] ${ruleName} — ${description}`)
}

/*
MAIN
*/

export async function runAnomalyAgent() {

  console.log("Anomaly agent starting")

  await consumer.connect()
  await producer.connect()
  await consumer.subscribe({ topic: INPUT_TOPIC, fromBeginning: false })

  console.log(`Subscribed to ${INPUT_TOPIC}`)

  await consumer.run({
    eachMessage: async ({ message }) => {

      const raw = message.value?.toString()
      if (!raw) return

      const event = JSON.parse(raw)

      const {
        username,
        sourceIp,
        timestamp,
        severity,
        logType
      } = event

      if (!username || !sourceIp) return

      /*
      RULE 1: Login during off-hours (11PM – 6AM UTC)
      */
      if (logType === "authentication" && isOffHours(timestamp)) {
        await emitAnomaly(
          "Off-Hours Login Attempt",
          `Login attempt by ${username} from ${sourceIp} outside business hours`,
          "medium",
          event
        )
      }

      /*
      RULE 2: Login from a new IP never seen for this user
      */
      if (logType === "authentication" && severity === "info") {
        const isNew = await isNewIpForUser(username, sourceIp)
        if (isNew) {
          await emitAnomaly(
            "Login from New IP",
            `User ${username} logged in from a previously unseen IP ${sourceIp}`,
            "medium",
            event
          )
        }
      }

      /*
      RULE 3: Privilege escalation attempt
      */
      if (logType === "privilege-escalation") {
        await emitAnomaly(
          "Privilege Escalation Attempt",
          `User ${username} attempted privilege escalation`,
          "high",
          event
        )
      }
    }
  })
}
