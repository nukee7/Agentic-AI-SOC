import { Kafka } from "kafkajs"
import Redis from "ioredis"

/*
CONFIG
*/

const KAFKA_BROKER  = process.env.KAFKA_BROKER || "kafka:9092"
const REDIS_HOST    = process.env.REDIS_HOST   || "redis"
const INPUT_TOPIC   = "alerts"
const BLOCK_TTL     = 60 * 60  // Block IP for 1 hour

/*
SERVICES
*/

const kafka    = new Kafka({ clientId: "response-agent", brokers: [KAFKA_BROKER] })
const consumer = kafka.consumer({ groupId: "response-group" })
const redis    = new Redis({ host: REDIS_HOST, port: 6379 })

/*
ACTIONS
*/

async function blockIp(ip: string, reason: string) {
  const key = `blocked:${ip}`
  await redis.setex(key, BLOCK_TTL, reason)
  console.log(`[BLOCKED] IP ${ip} — reason: ${reason} (TTL: ${BLOCK_TTL}s)`)
}

async function logAlert(alert: Record<string, unknown>) {
  const key  = `alert_count:${alert.ruleId}`
  const count = await redis.incr(key)
  await redis.expire(key, 60 * 60 * 24)
  console.log(`[LOGGED] ${alert.ruleName} | total today: ${count}`)
}

/*
MAIN
*/

export async function runResponseAgent() {

  console.log("Response agent starting")

  await consumer.connect()
  await consumer.subscribe({ topic: INPUT_TOPIC, fromBeginning: false })

  console.log(`Subscribed to ${INPUT_TOPIC}`)

  await consumer.run({
    eachMessage: async ({ message }) => {

      const raw = message.value?.toString()
      if (!raw) return

      const alert = JSON.parse(raw)
      const { ruleId, sourceIp, severity, ruleName } = alert

      console.log(`[RESPONSE] Handling alert: ${ruleName} (${severity})`)

      /*
      Always log every alert
      */
      await logAlert(alert)

      /*
      Block IP for high-severity alerts
      */
      if (
        severity === "high" &&
        sourceIp &&
        sourceIp !== "127.0.0.1" &&
        sourceIp !== "0.0.0.0"
      ) {
        await blockIp(sourceIp, `${ruleId} — ${ruleName}`)
      }
    }
  })
}
