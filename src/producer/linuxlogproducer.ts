import fs from "fs"
import readline from "readline"
import { Kafka } from "kafkajs"

const kafka = new Kafka({

  clientId: "linux-log-producer",

  brokers: ["localhost:9092"]

})

const producer = kafka.producer()

const LOG_FILE = "/var/log/auth.log"

async function startLogProducer() {

  await producer.connect()

  const stream = fs.createReadStream(LOG_FILE)

  const rl = readline.createInterface({

    input: stream

  })

  rl.on("line", async (line) => {

    await producer.send({

      topic: "security_logs",

      messages: [

        {

          value: JSON.stringify({

            timestamp: new Date().toISOString(),

            rawLog: line,

            service: "linux-auth"

          })

        }

      ]

    })

    console.log("Sent log")

  })

}

startLogProducer()