import * as fs from "fs"
import * as readline from "readline"
import { Kafka } from "kafkajs"

const kafka = new Kafka({
  clientId: "linux-log-producer",
  brokers: [
    process.env.KAFKA_BROKER ||
    "kafka:9092"
  ]
})

const producer = kafka.producer()

const TOPIC = "security_logs"

/*
Common log locations across systems
*/

const LOG_PATHS = [

  // Ubuntu / Debian / Kali
  "/var/log/auth.log",

  // RHEL / CentOS / Amazon Linux
  "/var/log/secure",

  // macOS (system log)
  "/var/log/system.log"

]

function findLogFile(): string | null {

  for (const path of LOG_PATHS) {

    if (fs.existsSync(path)) {

      console.log(
        "Using log file:",
        path
      )

      return path
    }

  }

  return null

}

async function start() {

  await producer.connect()

  console.log(
    "Linux log producer running"
  )

  const logFile =
    findLogFile()

  /*
  Fallback if no log file exists
  */

  if (!logFile) {

    console.log(
      "No system log found — running test generator"
    )

    setInterval(async () => {

      const simulatedLog = {

        timestamp:
          new Date().toISOString(),

        rawLog:
          "Failed password for invalid user root from 192.168.1.10 port 22 ssh2",

        service:
          "linux-auth"

      }

      await producer.send({

        topic: TOPIC,

        messages: [
          {
            value:
              JSON.stringify(
                simulatedLog
              )
          }
        ]

      })

      console.log(
        "Simulated log sent"
      )

    }, 5000)

    return

  }

  /*
  Real log streaming
  */

  const stream =
    fs.createReadStream(
      logFile,
      {
        encoding: "utf8"
      }
    )

  const rl =
    readline.createInterface({

      input: stream

    })

  rl.on(
    "line",
    async (line) => {

      try {

        await producer.send({

          topic: TOPIC,

          messages: [
            {
              value:
                JSON.stringify({

                  timestamp:
                    new Date().toISOString(),

                  rawLog: line,

                  service:
                    "linux-auth"

                })
            }
          ]

        })

        console.log(
          "Log sent"
        )

      } catch (err) {

        console.error(
          "Kafka send error:",
          err
        )

      }

    }

  )

}

start()