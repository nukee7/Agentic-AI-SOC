import express from "express"
import cors from "cors"
import { Kafka } from "kafkajs"

/*
CONFIG
*/

const PORT = 3000

const kafka = new Kafka({
  clientId: "dashboard-service",
  brokers: [
    process.env.KAFKA_BROKER ||
    "kafka:9092"
  ]
})

const consumer = kafka.consumer({
  groupId: "dashboard-group"
})

/*
IN-MEMORY STORAGE
*/

const alerts: any[] = []

/*
KAFKA CONSUMER
*/

async function startKafka() {

  console.log(
    "Dashboard service connecting to Kafka"
  )

  await consumer.connect()

  await consumer.subscribe({
    topic: "alerts",
    fromBeginning: true
  })

  console.log(
    "Subscribed to alerts topic"
  )

  await consumer.run({

    eachMessage:
      async ({
        message
      }) => {

        const value =
          message.value?.toString()

        if (!value) return

        const alert =
          JSON.parse(value)

        alerts.push(alert)

        console.log(
          "Alert received:",
          alert.ruleName
        )

      }

  })

}

/*
API SERVER
*/

const app = express()

app.use(cors())

/*
GET ALL ALERTS
*/

app.get(
  "/alerts",
  (req, res) => {

    res.json(alerts)

  }
)

/*
GET STATS
*/

app.get(
  "/stats",
  (req, res) => {

    const total =
      alerts.length

    const high =
      alerts.filter(
        a =>
          a.severity === "high"
      ).length

    res.json({

      totalAlerts: total,

      highSeverity: high

    })

  }
)

/*
HEALTH CHECK
*/

app.get(
  "/health",
  (req, res) => {

    res.json({
      status: "ok"
    })

  }
)

app.listen(
  PORT,
  () => {

    console.log(
      "Dashboard API running on port",
      PORT
    )

  }
)

startKafka()
