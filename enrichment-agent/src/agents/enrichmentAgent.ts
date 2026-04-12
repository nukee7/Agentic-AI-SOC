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

const IGNORED_IPS = new Set([
  "0.0.0.0",
  "::1"
])

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
LOG PARSER
(ported from detection-agent)
*/

function parseFailedLogin(
  rawLog: string,
  event?: any
) {

  const sshMatch = rawLog.match(
    /Failed password for (?:invalid user )?(\w+) from (\d+\.\d+\.\d+\.\d+)/
  )

  if (sshMatch) {
    return {
      username: sshMatch[1],
      sourceIp: sshMatch[2]
    }
  }

  const winMatch = rawLog.match(
    /Windows Event 4625.*User:\s*(?:\S+\\)?(\S+)\s+IP:\s*(\d+\.\d+\.\d+\.\d+)/
  )

  if (winMatch) {
    return {
      username: winMatch[1],
      sourceIp: winMatch[2]
    }
  }

  const winAlt = rawLog.match(
    /Failed login.*(?:user|User)\s+(?:\S+\\)?(\S+).*(?:from|IP)\s+(\d+\.\d+\.\d+\.\d+)/i
  )

  if (winAlt) {
    return {
      username: winAlt[1],
      sourceIp: winAlt[2]
    }
  }

  if (
    event &&
    event.logType === "authentication" &&
    (event.severity === "warning" ||
     event.severity === "critical") &&
    event.sourceIp &&
    event.username
  ) {
    return {
      username: event.username,
      sourceIp: event.sourceIp
    }
  }

  return null

}

/*
TRACK FAILURES
*/

async function trackFailure(
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
EMIT ALERT
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
      "AUTH_BRUTE_FORCE",

    ruleName:
      "Multiple failed authentication attempts",

    severity:
      "high",

    sourceIp: ip,

    username,

    attempts,

    windowSeconds:
      WINDOW_SECONDS,

    description:
      "Possible brute force authentication attack"

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
      "Brute force authentication attack",

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
  ENRICHMENT — always runs
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
  DETECTION — only for failed logins
  */

  const rawLog =
    event.rawLog || ""

  const parsed =
    parseFailedLogin(rawLog, event)

  if (!parsed)
    return

  if (IGNORED_IPS.has(parsed.sourceIp))
    return

  const attempts =
    await trackFailure(parsed.sourceIp)

  console.log(
    "[COUNT]",
    parsed.sourceIp,
    attempts
  )

  if (
    attempts >=
    FAILURE_THRESHOLD
  ) {

    await emitAlert(
      parsed.sourceIp,
      parsed.username,
      attempts
    )

    await createIncident(
      parsed.sourceIp,
      parsed.username,
      attempts
    )

    await redis.del(
      `failures:${parsed.sourceIp}`
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