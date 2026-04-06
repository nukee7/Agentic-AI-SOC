import { Kafka } from "kafkajs"
import Redis from "ioredis"
import crypto from "crypto"

/*
CONFIGURATION
*/

const KAFKA_BROKER =
  process.env.KAFKA_BROKER || "kafka:9092"

const REDIS_HOST =
  process.env.REDIS_HOST || "redis"

const LOG_TOPIC =
  process.env.LOG_TOPIC || "security_logs"

const ALERT_TOPIC =
  process.env.ALERT_TOPIC || "alerts"

const FAILURE_THRESHOLD =
  Number(process.env.FAILURE_THRESHOLD) || 5

const WINDOW_SECONDS =
  Number(process.env.WINDOW_SECONDS) || 60

const DEDUP_WINDOW_SECONDS =
  Number(process.env.DEDUP_WINDOW_SECONDS) || 300

/*
IGNORE LIST
*/

const IGNORED_IPS = new Set([
  "0.0.0.0",
  "::1"
])

/*
RULE METADATA
*/

const RULE = {

  ruleId: "AUTH_BRUTE_FORCE",

  ruleName:
    "Multiple failed authentication attempts",

  severity:
    "high",

  threshold:
    FAILURE_THRESHOLD,

  windowSeconds:
    WINDOW_SECONDS

}

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

      username:
        sshMatch[1],

      sourceIp:
        sshMatch[2],

      eventType:
        "authentication_failure"

    }

  }

  const winMatch = rawLog.match(
    /Windows Event 4625.*User:\s*(?:\S+\\)?(\S+)\s+IP:\s*(\d+\.\d+\.\d+\.\d+)/
  )

  if (winMatch) {

    return {

      username:
        winMatch[1],

      sourceIp:
        winMatch[2],

      eventType:
        "authentication_failure"

    }

  }

  const winAlt = rawLog.match(
    /Failed login.*(?:user|User)\s+(?:\S+\\)?(\S+).*(?:from|IP)\s+(\d+\.\d+\.\d+\.\d+)/i
  )

  if (winAlt) {

    return {

      username:
        winAlt[1],

      sourceIp:
        winAlt[2],

      eventType:
        "authentication_failure"

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

      username:
        event.username,

      sourceIp:
        event.sourceIp,

      eventType:
        "authentication_failure"

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
DEDUPLICATION
*/

async function shouldEmit(
  ip: string
) {

  const key =
    `alerted:${ip}`

  const exists =
    await redis.exists(key)

  if (exists) {

    console.log(
      "[DEDUP] Suppressed event",
      ip
    )

    return false

  }

  await redis.setex(
    key,
    DEDUP_WINDOW_SECONDS,
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

  const alert = {

    alertId:
      crypto.randomUUID(),

    timestamp:
      new Date().toISOString(),

    ruleId:
      RULE.ruleId,

    ruleName:
      RULE.ruleName,

    severity:
      RULE.severity,

    sourceIp: ip,

    username,

    attempts,

    windowSeconds:
      RULE.windowSeconds,

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

    rawLog ||
    event.message ||
    "no rawLog"

  )

  const parsed =
    parseFailedLogin(
      rawLog,
      event
    )

  if (!parsed)
    return

  const {
    sourceIp,
    username
  } = parsed

  if (
    IGNORED_IPS.has(sourceIp)
  )
    return

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
    RULE.threshold
  ) {

    const allowed =
      await shouldEmit(
        sourceIp
      )

    if (!allowed) {

      await redis.del(
        `failures:${sourceIp}`
      )

      return

    }

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
GRACEFUL SHUTDOWN
*/

async function shutdown() {

  console.log(
    "Stopping detection agent"
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

process.on(
  "SIGINT",
  shutdown
)

process.on(
  "SIGTERM",
  shutdown
)

/*
START SERVICE
*/

start()