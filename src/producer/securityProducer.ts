import { Kafka } from "kafkajs"
import { SecurityEvent } from "../types/security"

const kafka = new Kafka({

  clientId: "security-service",

  brokers: ["localhost:9092"]

})

const producer = kafka.producer()

const TOPIC = "security_logs"

function generateSecurityEvent(): SecurityEvent {

  const users = ["admin", "john", "alice"]

  const statuses: ("SUCCESS" | "FAILED")[] = [
    "SUCCESS",
    "FAILED"
  ]

  return {

    timestamp: new Date().toISOString(),

    user: users[Math.floor(Math.random() * users.length)],

    sourceIp: `192.168.1.${Math.floor(Math.random() * 50)}`,

    loginStatus:
      statuses[Math.floor(Math.random() * 2)],

    service: "auth-service"

  }

}

async function startProducer() {

  await producer.connect()

  console.log("Producer connected")

  setInterval(async () => {

    const event = generateSecurityEvent()

    await producer.send({

      topic: TOPIC,

      messages: [

        {

          value: JSON.stringify(event)

        }

      ]

    })

    console.log("Sent event:", event)

  }, 2000)

}

startProducer()