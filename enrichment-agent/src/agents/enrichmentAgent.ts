import { Kafka } from "kafkajs"

/*
CONFIG
*/

const KAFKA_BROKER = process.env.KAFKA_BROKER || "kafka:9092"
const INPUT_TOPIC  = "security_logs"
const OUTPUT_TOPIC = "enriched_logs"

/*
Known malicious IPs (static list — replace with threat intel feed)
*/

const KNOWN_BAD_IPS = new Set([
  "203.0.113.42",
  "198.51.100.10",
  "192.0.2.99",
])

/*
SERVICES
*/

const kafka    = new Kafka({ clientId: "enrichment-agent", brokers: [KAFKA_BROKER] })
const consumer = kafka.consumer({ groupId: "enrichment-group" })
const producer = kafka.producer()

/*
HELPERS
*/

function classifyIp(ip: string): "private" | "public" | "loopback" {
  if (ip === "127.0.0.1" || ip === "::1") return "loopback"
  const parts = ip.split(".").map(Number)
  if (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  ) return "private"
  return "public"
}

function getLoginContext(timestamp: string): "business-hours" | "after-hours" | "weekend" {
  const d    = new Date(timestamp)
  const day  = d.getUTCDay()
  const hour = d.getUTCHours()

  if (day === 0 || day === 6) return "weekend"
  if (hour >= 9 && hour < 18)  return "business-hours"
  return "after-hours"
}

/*
MAIN
*/

export async function runEnrichmentAgent() {

  console.log("Enrichment agent starting")

  await consumer.connect()
  await producer.connect()
  await consumer.subscribe({ topic: INPUT_TOPIC, fromBeginning: false })

  console.log(`Subscribed to ${INPUT_TOPIC} → enriching to ${OUTPUT_TOPIC}`)

  await consumer.run({
    eachMessage: async ({ message }) => {

      const raw = message.value?.toString()
      if (!raw) return

      const event = JSON.parse(raw)

      const enriched = {
        ...event,
        enrichment: {
          ipType:        classifyIp(event.sourceIp ?? "0.0.0.0"),
          loginContext:  getLoginContext(event.timestamp),
          isThreatIp:    KNOWN_BAD_IPS.has(event.sourceIp),
          isRootAttempt: event.username === "root" || event.username === "admin",
        }
      }

      await producer.send({
        topic: OUTPUT_TOPIC,
        messages: [{ value: JSON.stringify(enriched) }]
      })

      console.log(
        `[ENRICHED] ${event.username}@${event.sourceIp}`,
        `| ip=${enriched.enrichment.ipType}`,
        `| context=${enriched.enrichment.loginContext}`,
        enriched.enrichment.isThreatIp ? "| THREAT IP" : "",
        enriched.enrichment.isRootAttempt ? "| ROOT ATTEMPT" : ""
      )
    }
  })
}
