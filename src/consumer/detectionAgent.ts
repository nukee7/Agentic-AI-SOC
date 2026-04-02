import { Kafka } from "kafkajs"
import { createClient } from "redis"

/* ===============================
   Security Event Type
=============================== */

export interface SecurityEvent {

  timestamp: string

  user: string

  sourceIp: string

  loginStatus: "SUCCESS" | "FAILED"

  service: string

}

/* ===============================
   Kafka Configuration
=============================== */

const kafka = new Kafka({

  clientId: "detection-agent",

  brokers: ["localhost:9092"]

})

const consumer = kafka.consumer({

  groupId: "detection-group"

})

const TOPIC = "security_logs"

/* ===============================
   Redis Configuration
=============================== */

const redisClient = createClient({

  url: "redis://localhost:6379"

})

redisClient.on("error", (err) => {

  console.error("Redis error:", err)

})

/* ===============================
   Detection Configuration
=============================== */

const FAILED_THRESHOLD = 3
const TIME_WINDOW_MS = 60 * 1000

/* ===============================
   State Store (in-memory)
=============================== */

const failedLoginTracker:
Record<string, number[]> = {}

/* ===============================
   Feature Engineering
=============================== */

function engineerFeatures(
  event: SecurityEvent
) {

  const timestamp =
    new Date(event.timestamp)

  return {

    hour: timestamp.getHours(),

    isFailed:
      event.loginStatus === "FAILED",

    sourceIp: event.sourceIp,

    user: event.user

  }

}

/* ===============================
   Detection Logic
=============================== */

async function detectThreat(
  features: any,
  event: SecurityEvent
) {

  if (!features.isFailed)
    return

  const now = Date.now()

  if (!failedLoginTracker[event.user]) {

    failedLoginTracker[event.user] = []

  }

  failedLoginTracker[event.user].push(now)

  /* Remove old timestamps */

  failedLoginTracker[event.user] =
    failedLoginTracker[event.user]
      .filter(
        t => now - t < TIME_WINDOW_MS
      )

  const attempts =
    failedLoginTracker[event.user].length

  console.log(
    "Failed attempts for",
    event.user,
    ":",
    attempts
  )

  if (attempts >= FAILED_THRESHOLD) {

    await generateAlert(
      "BRUTE_FORCE_DETECTED",
      "HIGH",
      event,
      attempts
    )

  }

}

/* ===============================
   Alert Generation
=============================== */

async function generateAlert(
  type: string,
  severity: string,
  event: SecurityEvent,
  attempts: number
) {

  const alert = {

    alertType: type,

    severity,

    timestamp:
      new Date().toISOString(),

    user: event.user,

    sourceIp: event.sourceIp,

    failedAttempts: attempts,

    service: event.service

  }

  console.log("ALERT GENERATED")

  console.log(alert)

  await storeAlert(alert)

}

/* ===============================
   Redis Alert Storage
=============================== */

async function storeAlert(
  alert: any
) {

  try {

    await redisClient.rPush(

      "security_alerts",

      JSON.stringify(alert)

    )

  }

  catch (err) {

    console.error(
      "Failed to store alert",
      err
    )

  }

}

/* ===============================
   Message Processing
=============================== */

async function processEvent(
  event: SecurityEvent
) {

  const features =
    engineerFeatures(event)

  await detectThreat(
    features,
    event
  )

}

/* ===============================
   Kafka Consumer Startup
=============================== */

async function startConsumer() {

  try {

    /* Connect Redis */

    await redisClient.connect()

    console.log("Connected to Redis")

    /* Connect Kafka */

    await consumer.connect()

    console.log("Connected to Kafka")

    await consumer.subscribe({

      topic: TOPIC,

      fromBeginning: false

    })

    console.log(
      "Subscribed to topic:",
      TOPIC
    )

    await consumer.run({

      eachMessage:
        async ({ message }) => {

          if (!message.value)
            return

          try {

            const event:
              SecurityEvent =
              JSON.parse(
                message.value.toString()
              )

            console.log(
              "Received event:",
              event
            )

            await processEvent(event)

          }

          catch (err) {

            console.error(
              "Invalid message format",
              err
            )

          }

        }

    })

  }

  catch (err) {

    console.error(
      "Consumer failed",
      err
    )

  }

}

/* ===============================
   Graceful Shutdown
=============================== */

async function shutdown() {

  console.log(
    "Shutting down services..."
  )

  try {

    await consumer.disconnect()

    await redisClient.disconnect()

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

/* ===============================
   Start Service
=============================== */

startConsumer()