import { Kafka } from "kafkajs"
import Redis from "ioredis"
import crypto from "crypto"

/*
CONFIG
*/

const KAFKA_BROKER =
  process.env.KAFKA_BROKER || "kafka:9092"

const REDIS_HOST =
  process.env.REDIS_HOST || "redis"

const INPUT_TOPIC =
  process.env.INPUT_TOPIC || "security_logs"

const OUTPUT_TOPIC =
  process.env.OUTPUT_TOPIC || "enriched_logs"

const ALERT_TOPIC =
  process.env.ALERT_TOPIC || "alerts"

const INCIDENT_TOPIC =
  process.env.INCIDENT_TOPIC || "incidents"

const FAILURE_THRESHOLD =
  Number(process.env.FAILURE_THRESHOLD) || 5

const WINDOW_SECONDS =
  Number(process.env.WINDOW_SECONDS) || 60

const DEDUP_SECONDS =
  Number(process.env.DEDUP_SECONDS) || 300

/*
SERVICES
*/

const kafka = new Kafka({
  clientId: "enrichment-agent",
  brokers: [KAFKA_BROKER]
})

const consumer = kafka.consumer({
  groupId: "enrichment-group"
})

const producer = kafka.producer()

const redis = new Redis({
  host: REDIS_HOST,
  port: 6379
})

/*
HELPERS
*/

function classifyIp(ip: string) {

  if (ip === "127.0.0.1" || ip === "::1")
    return "loopback"

  const parts =
    ip.split(".").map(Number)

  if (
    parts[0] === 10 ||
    (parts[0] === 172 &&
      parts[1] >= 16 &&
      parts[1] <= 31) ||
    (parts[0] === 192 &&
      parts[1] === 168)
  )
    return "private"

  return "public"

}

function getLoginContext(
  timestamp: string
) {

  const d =
    new Date(timestamp)

  const day =
    d.getUTCDay()

  const hour =
    d.getUTCHours()

  if (day === 0 || day === 6)
    return "weekend"

  if (hour >= 9 && hour < 18)
    return "business-hours"

  return "after-hours"

}

/*
CORRELATION
Track failures
*/

async function trackFailures(
  ip: string
) {

  const key =
    `failures:${ip}`

  const count =
    await redis.incr(key)

  if (count === 1) {

    await redis.expire(
      key,
      WINDOW_SECONDS
    )

  }

  return count

}

/*
DEDUP CHECK
*/

async function shouldEmit(
  ip: string
) {

  const key =
    `alerted:${ip}`

  const exists =
    await redis.exists(key)

  if (exists)
    return false

  await redis.setex(
    key,
    DEDUP_SECONDS,
    "1"
  )

  return true

}

/*
ALERT
*/

async function emitAlert(
  ip: string,
  username: string,
  attempts: number
) {

  const allowed =
    await shouldEmit(ip)

  if (!allowed) {

    console.log(
      "[DEDUP] Alert suppressed",
      ip
    )

    return

  }

  const alert = {

    alertId:
      crypto.randomUUID(),

    timestamp:
      new Date().toISOString(),

    ruleId:
      "SSH_BRUTE_FORCE",

    ruleName:
      "Multiple failed SSH logins",

    severity:
      "high",

    sourceIp: ip,

    username,

    attempts,

    windowSeconds:
      WINDOW_SECONDS

  }

  await producer.send({

    topic: ALERT_TOPIC,

    messages: [
      {
        value:
          JSON.stringify(alert)
      }
    ]

  })

  console.log(
    "[ALERT]",
    ip,
    attempts
  )

}

/*
INCIDENT
*/

async function createIncident(
  ip: string,
  username: string,
  attempts: number
) {

  const incident = {

    incidentId:
      crypto.randomUUID(),

    title:
      "SSH brute force attack",

    severity:
      "high",

    sourceIp: ip,

    username,

    attempts,

    status:
      "OPEN",

    createdAt:
      new Date().toISOString()

  }

  await producer.send({

    topic: INCIDENT_TOPIC,

    messages: [
      {
        value:
          JSON.stringify(incident)
      }
    ]

  })

  console.log(
    "[INCIDENT]",
    ip
  )

}

/*
PROCESS EVENT
*/

async function processEvent(
  raw: string
) {

  let event

  try {

    event =
      JSON.parse(raw)

  }

  catch {

    console.log(
      "Invalid message"
    )

    return

  }

  const ip =
    event.sourceIp ||
    "0.0.0.0"

  /*
  ENRICHMENT
  */

  const enriched = {

    ...event,

    enrichment: {

      enrichedAt:
        new Date().toISOString(),

      ipType:
        classifyIp(ip),

      loginContext:
        getLoginContext(
          event.timestamp
        ),

      isRootAttempt:
        event.username === "root" ||
        event.username === "admin"

    }

  }

  /*
  SEND ENRICHED EVENT
  */

  await producer.send({

    topic: OUTPUT_TOPIC,

    messages: [
      {
        value:
          JSON.stringify(enriched)
      }
    ]

  })

  /*
  CORRELATION
  */

  const attempts =
    await trackFailures(ip)

  console.log(
    "[COUNT]",
    ip,
    attempts
  )

  if (
    attempts >=
    FAILURE_THRESHOLD
  ) {

    await emitAlert(
      ip,
      event.username,
      attempts
    )

    await createIncident(
      ip,
      event.username,
      attempts
    )

    await redis.del(
      `failures:${ip}`
    )

  }

}

/*
STARTUP
*/

async function startKafka() {

  while (true) {

    try {

      await consumer.connect()

      await producer.connect()

      await consumer.subscribe({

        topic: INPUT_TOPIC,

        fromBeginning: false

      })

      console.log(
        "Enrichment + Correlation running"
      )

      break

    }

    catch {

      console.log(
        "Kafka not ready — retrying"
      )

      await new Promise(
        r => setTimeout(r, 5000)
      )

    }

  }

}

/*
RUN
*/

export async function runEnrichmentAgent() {

  console.log(
    "Enrichment agent starting"
  )

  await startKafka()

  await consumer.run({

    eachMessage:
      async ({
        message
      }) => {

        const raw =
          message.value?.toString()

        if (!raw)
          return

        await processEvent(raw)

      }

  })

}

/*
SHUTDOWN
*/

async function shutdown() {

  console.log(
    "Stopping enrichment agent"
  )

  await consumer.disconnect()

  await producer.disconnect()

  await redis.quit()

  process.exit(0)

}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)