import { Kafka } from "kafkajs"
import Redis from "ioredis"
import { exec } from "child_process"

/*
CONFIG
*/

const KAFKA_BROKER =
  process.env.KAFKA_BROKER || "kafka:9092"

const REDIS_HOST =
  process.env.REDIS_HOST || "redis"

const INPUT_TOPIC =
  process.env.INPUT_TOPIC || "alerts"

const BLOCK_TTL =
  Number(process.env.BLOCK_TTL) || 60 * 60

const BLOCK_SEVERITY =
  process.env.BLOCK_SEVERITY || "high"

/*
SAFETY
*/

const SAFE_IPS = [
  "127.0.0.1",
  "0.0.0.0",
  "localhost"
]

/*
SERVICES
*/

const kafka = new Kafka({
  clientId: "response-agent",
  brokers: [KAFKA_BROKER]
})

const consumer = kafka.consumer({
  groupId: "response-group"
})

const redis = new Redis({
  host: REDIS_HOST,
  port: 6379
})

/*
FIREWALL BLOCK
*/

function firewallBlock(ip: string): Promise<void> {

  return new Promise((resolve) => {

    exec(
      `iptables -C INPUT -s ${ip} -j DROP`,
      (checkErr) => {

        if (!checkErr) {

          console.log(
            `[SKIP] Firewall rule exists for ${ip}`
          )

          return resolve()

        }

        exec(
          `iptables -A INPUT -s ${ip} -j DROP`,
          (err) => {

            if (err) {

              console.error(
                "Firewall block failed",
                err
              )

              return resolve()

            }

            console.log(
              `[FIREWALL] Blocked ${ip}`
            )

            resolve()

          }

        )

      }

    )

  })

}

/*
FIREWALL UNBLOCK
*/

function firewallUnblock(ip: string): Promise<void> {

  return new Promise((resolve) => {

    exec(
      `iptables -D INPUT -s ${ip} -j DROP`,
      () => {

        console.log(
          `[UNBLOCKED] ${ip}`
        )

        resolve()

      }

    )

  })

}

/*
SCHEDULE UNBLOCK
*/

function scheduleUnblock(
  ip: string,
  ttlSeconds: number
) {

  console.log(
    `[SCHEDULE] Unblock ${ip} in ${ttlSeconds}s`
  )

  setTimeout(async () => {

    await firewallUnblock(ip)

    await redis.del(
      `blocked:${ip}`
    )

    console.log(
      `[CLEANUP] ${ip} removed`
    )

  },
  ttlSeconds * 1000)

}

/*
BLOCK ACTION
*/

async function blockIp(
  ip: string,
  reason: string
) {

  if (SAFE_IPS.includes(ip)) {

    console.log(
      `[SAFE] Skipping protected IP ${ip}`
    )

    return

  }

  const key =
    `blocked:${ip}`

  const exists =
    await redis.exists(key)

  if (exists) {

    console.log(
      `[SKIP] ${ip} already blocked`
    )

    return

  }

  await firewallBlock(ip)

  await redis.setex(
    key,
    BLOCK_TTL,
    reason
  )

  console.log(
    `[BLOCKED] ${ip} — ${reason}`
  )

  scheduleUnblock(
    ip,
    BLOCK_TTL
  )

}

/*
PERSISTENT RECOVERY
*/

async function recoverBlockedIps() {

  console.log(
    "Recovering blocked IPs..."
  )

  const keys =
    await redis.keys(
      "blocked:*"
    )

  if (keys.length === 0) {

    console.log(
      "No blocked IPs to recover"
    )

    return

  }

  for (const key of keys) {

    const ip =
      key.split(":")[1]

    const ttl =
      await redis.ttl(key)

    if (ttl <= 0)
      continue

    console.log(
      `[RECOVERY] Restoring block for ${ip} (TTL ${ttl}s)`
    )

    await firewallBlock(ip)

    scheduleUnblock(
      ip,
      ttl
    )

  }

}

/*
LOGGING
*/

async function logAlert(
  alert: Record<string, any>
) {

  const key =
    `alert_count:${alert.ruleId}`

  const count =
    await redis.incr(key)

  await redis.expire(
    key,
    86400
  )

  console.log(
    `[LOGGED] ${alert.ruleName} | total today: ${count}`
  )

}

/*
PROCESS ALERT
*/

async function processAlert(
  raw: string
) {

  let alert

  try {

    alert =
      JSON.parse(raw)

  }

  catch {

    console.log(
      "Invalid alert payload"
    )

    return

  }

  const {
    ruleId,
    sourceIp,
    severity,
    ruleName
  } = alert

  console.log(
    `[RESPONSE] ${ruleName} (${severity})`
  )

  await logAlert(alert)

  if (
    severity === BLOCK_SEVERITY &&
    sourceIp
  ) {

    await blockIp(
      sourceIp,
      `${ruleId} — ${ruleName}`
    )

  }

}

/*
STARTUP
*/

export async function runResponseAgent() {

  console.log(
    "Response agent starting"
  )

  /*
  STEP 1 — Recover firewall state
  */

  await recoverBlockedIps()

  /*
  STEP 2 — Start Kafka
  */

  while (true) {

    try {

      await consumer.connect()

      await consumer.subscribe({

        topic: INPUT_TOPIC,
        fromBeginning: false

      })

      console.log(
        `Subscribed to ${INPUT_TOPIC}`
      )

      await consumer.run({

        eachMessage:
          async ({ message }) => {

            const raw =
              message.value?.toString()

            if (!raw)
              return

            await processAlert(raw)

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
    "Stopping response agent"
  )

  await consumer.disconnect()

  await redis.quit()

  process.exit(0)

}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)