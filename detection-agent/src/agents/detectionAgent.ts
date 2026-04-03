import { Kafka } from "kafkajs"
import Redis from "ioredis"
import crypto from "crypto"

/*
CONFIGURATION
*/

const KAFKA_BROKER =
  process.env.KAFKA_BROKER ||
  "kafka:9092"

const REDIS_HOST =
  process.env.REDIS_HOST ||
  "redis"

const LOG_TOPIC =
  process.env.LOG_TOPIC ||
  "security_logs"

const ALERT_TOPIC =
  process.env.ALERT_TOPIC ||
  "alerts"

const FAILURE_THRESHOLD =
  Number(process.env.FAILURE_THRESHOLD) || 5

const WINDOW_SECONDS =
  Number(process.env.WINDOW_SECONDS) || 60

const DEDUP_WINDOW_SECONDS =
  Number(process.env.DEDUP_WINDOW_SECONDS) || 300

/*
SERVICES
*/

const kafka = new Kafka({
  clientId: "detection-agent",
  brokers: [KAFKA_BROKER]
})

const consumer = kafka.consumer({
  groupId: "detection-group"
})

const producer = kafka.producer()

const redis = new Redis({
  host: REDIS_HOST,
  port: 6379
})

/*
LOG PARSER
Supports both Linux/SSH and Windows Security Event Log formats:
  - SSH:     "Failed password for [invalid user] <user> from <ip>"
  - Windows: "Windows Event 4625: Failed login. User: [DOMAIN\]<user> IP: <ip>"
  - Generic: Any event with logType=authentication and severity=warning/critical
*/

function parseFailedLogin(
  rawLog: string,
  event?: { logType?: string; severity?: string; sourceIp?: string; username?: string }
) {

  // Pattern 1: Linux/SSH failed password
  const sshMatch = rawLog.match(
    /Failed password for (?:invalid user )?(\w+) from (\d+\.\d+\.\d+\.\d+)/
  )
  if (sshMatch) {
    return { username: sshMatch[1], sourceIp: sshMatch[2], eventType: "authentication_failure" }
  }

  // Pattern 2: Windows Event 4625 (failed login)
  const winMatch = rawLog.match(
    /Windows Event 4625.*User:\s*(?:\S+\\)?(\S+)\s+IP:\s*(\d+\.\d+\.\d+\.\d+)/
  )
  if (winMatch) {
    return { username: winMatch[1], sourceIp: winMatch[2], eventType: "authentication_failure" }
  }

  // Pattern 3: Windows failed login (alternate format from event log)
  const winAlt = rawLog.match(
    /Failed login.*(?:user|User)\s+(?:\S+\\)?(\S+).*(?:from|IP)\s+(\d+\.\d+\.\d+\.\d+)/i
  )
  if (winAlt) {
    return { username: winAlt[1], sourceIp: winAlt[2], eventType: "authentication_failure" }
  }

  // Pattern 4: Structured event fallback — use fields directly if log format unknown
  if (
    event &&
    event.logType === "authentication" &&
    (event.severity === "warning" || event.severity === "critical") &&
    event.sourceIp &&
    event.sourceIp !== "127.0.0.1" &&
    event.sourceIp !== "0.0.0.0" &&
    event.username
  ) {
    return { username: event.username, sourceIp: event.sourceIp, eventType: "authentication_failure" }
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
DEDUPLICATION
*/

async function shouldEmitAlert(
  ip: string
) {

  const key =
    `alerted:${ip}`

  const exists =
    await redis.exists(key)

  if (exists) {

    console.log(
      "[DEDUP] Suppressed alert for",
      ip
    )

    return false

  }

  await redis.set(
    key,
    "1",
    "EX",
    DEDUP_WINDOW_SECONDS
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
    await shouldEmitAlert(ip)

  if (!allowed)
    return

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
      WINDOW_SECONDS,

    description:
      "Possible SSH brute force attack detected"

  }

  try {

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
      alert.ruleId,
      ip,
      attempts
    )

  }

  catch (err) {

    console.error(
      "Failed to send alert",
      err
    )

  }

}

/*
PROCESS EVENT
*/

async function processEvent(
  message: any
) {

  const value =
    message.value?.toString()

  if (!value)
    return

  let event

  try {

    event =
      JSON.parse(value)

  }

  catch {

    console.log(
      "Invalid message format"
    )

    return

  }

  const rawLog =
    event.rawLog || ""

  console.log(
    "[EVENT]",
    rawLog || event.message || "no rawLog"
  )

  const parsed =
    parseFailedLogin(rawLog, event)

  if (!parsed)
    return

  const {
    sourceIp,
    username
  } = parsed

  const attempts =
    await trackFailure(
      sourceIp
    )

  console.log(
    "[COUNT]",
    sourceIp,
    attempts
  )

  if (
    attempts >=
    FAILURE_THRESHOLD
  ) {

    await emitAlert(
      sourceIp,
      username,
      attempts
    )

    await redis.del(
      `failures:${sourceIp}`
    )

  }

}

/*
STARTUP WITH RETRY
*/

async function start() {

  while (true) {

    try {

      console.log(
        "Connecting to Kafka..."
      )

      await consumer.connect()

      await producer.connect()

      await consumer.subscribe({

        topic: LOG_TOPIC,

        fromBeginning: false

      })

      console.log(
        "Detection agent running"
      )

      await consumer.run({

        eachMessage:
          async ({
            message
          }) => {

            await processEvent(
              message
            )

          }

      })

      break

    }

    catch (err) {

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
GRACEFUL SHUTDOWN
*/

async function shutdown() {

  console.log(
    "Shutting down detection agent..."
  )

  try {

    await consumer.disconnect()

    await producer.disconnect()

    await redis.quit()

  }

  catch (err) {

    console.error(
      "Shutdown error",
      err
    )

  }

  process.exit(0)

}

process.on("SIGINT", shutdown)

process.on("SIGTERM", shutdown)

/*
START SERVICE
*/

start()