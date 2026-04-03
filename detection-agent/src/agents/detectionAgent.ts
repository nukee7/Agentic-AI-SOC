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

const LOG_TOPIC = "security_logs"

const ALERT_TOPIC = "alerts"

const FAILURE_THRESHOLD = 5

const WINDOW_SECONDS = 60

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
STEP 2 + 3
Parse log and extract fields
*/

function parseFailedLogin(
  rawLog: string
) {
  const regex =
    /Failed password for (?:invalid user )?(\w+) from (\d+\.\d+\.\d+\.\d+)/

  const match =
    rawLog.match(regex)

  if (!match) return null

  return {
    username: match[1],
    sourceIp: match[2],
    eventType:
      "authentication_failure"
  }
}

/*
STEP 4
Track state in Redis
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
STEP 6
Emit alert (UPDATED)
*/

async function emitAlert(
  ip: string,
  username: string,
  attempts: number
) {

  const alert = {
    alertId: crypto.randomUUID(),

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
    "ALERT SENT:",
    alert
  )
}

/*
MAIN PIPELINE
*/

async function start() {
  try {

    console.log(
      "Detection agent starting"
    )

    await consumer.connect()

    await producer.connect()

    await consumer.subscribe({
      topic: LOG_TOPIC,
      fromBeginning: false
    })

    console.log(
      "Subscribed to",
      LOG_TOPIC
    )

    await consumer.run({

      eachMessage:
        async ({
          message
        }) => {

          /*
          STEP 1
          Receive event
          */

          const value =
            message.value?.toString()

          if (!value) return

          const event =
            JSON.parse(value)

          const rawLog =
            event.rawLog

          console.log(
            "Event received:",
            rawLog
          )

          /*
          STEP 2 + 3
          Parse and extract fields
          */

          const parsed =
            parseFailedLogin(
              rawLog
            )

          if (!parsed) return

          const {
            sourceIp,
            username
          } = parsed

          console.log(
            "Parsed:",
            sourceIp,
            username
          )

          /*
          STEP 4
          Track state
          */

          const attempts =
            await trackFailure(
              sourceIp
            )

          console.log(
            "Attempts:",
            attempts
          )

          /*
          STEP 5
          Evaluate rule
          */

          if (
            attempts >=
            FAILURE_THRESHOLD
          ) {

            /*
            STEP 6
            Emit alert
            */

            await emitAlert(
              sourceIp,
              username,
              attempts
            )

            /*
            Reset counter
            */

            await redis.del(
              `failures:${sourceIp}`
            )

          }

        }

    })

  } catch (err) {

    console.error(
      "Detection agent error:",
      err
    )

  }
}

start()