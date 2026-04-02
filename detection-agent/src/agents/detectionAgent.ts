import { Kafka } from "kafkajs"

const kafka = new Kafka({
  clientId: "detection-agent",
  brokers: [
    process.env.KAFKA_BROKER || "kafka:9092"
  ]
})

const consumer = kafka.consumer({
  groupId: "detection-group"
})

const TOPIC = "security_logs"

async function start() {
  try {
    console.log("Detection agent starting")

    await consumer.connect()

    console.log("Connected to Kafka")

    await consumer.subscribe({
      topic: TOPIC,
      fromBeginning: true
    })

    console.log(
      "Subscribed to topic:",
      TOPIC
    )

    await consumer.run({
      eachMessage: async ({
        topic,
        partition,
        message
      }) => {
        const value =
          message.value?.toString()

        console.log(
          "Event received:",
          value
        )
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