import { Kafka } from "kafkajs"
import Redis from "ioredis"

/*
CONFIG
*/

const KAFKA_BROKER = process.env.KAFKA_BROKER || "kafka:9092"
const REDIS_HOST   = process.env.REDIS_HOST   || "redis"
const INPUT_TOPIC  = "security_logs"
const OUTPUT_TOPIC = "enriched_logs"

const ABUSEIPDB_API_KEY = process.env.ABUSEIPDB_API_KEY || ""
const IP_CACHE_TTL      = 60 * 60 * 6  // Cache IP reputation for 6 hours

/*
SERVICES
*/

const kafka    = new Kafka({ clientId: "enrichment-agent", brokers: [KAFKA_BROKER] })
const consumer = kafka.consumer({ groupId: "enrichment-group" })
const producer = kafka.producer()
const redis    = new Redis({ host: REDIS_HOST, port: 6379 })

/*
HELPERS
*/

function classifyIp(ip: string): "private" | "public" | "loopback" {
  if (ip === "127.0.0.1" || ip === "::1") return "loopback"
  const parts = ip.split(".").map(Number)
  if (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  ) return "private"
  return "public"
}

function getLoginContext(timestamp: string): "business-hours" | "after-hours" | "weekend" {
  const d    = new Date(timestamp)
  const day  = d.getUTCDay()
  const hour = d.getUTCHours()

  if (day === 0 || day === 6) return "weekend"
  if (hour >= 9 && hour < 18)  return "business-hours"
  return "after-hours"
}

/*
ABUSEIPDB THREAT INTELLIGENCE
Checks an IP against AbuseIPDB's real-time database.
Free tier: 1000 checks/day — results are cached in Redis.
*/

interface ThreatIntel {
  isThreatIp: boolean
  abuseScore: number
  country: string
  isp: string
  totalReports: number
  source: "abuseipdb" | "cache" | "skipped"
}

async function checkThreatIntel(ip: string): Promise<ThreatIntel> {

  const skipResult: ThreatIntel = {
    isThreatIp: false, abuseScore: 0,
    country: "unknown", isp: "unknown",
    totalReports: 0, source: "skipped"
  }

  // Skip private/loopback IPs — they won't exist in threat feeds
  if (classifyIp(ip) !== "public") return skipResult

  // Check Redis cache first
  const cached = await redis.get(`threat:${ip}`)
  if (cached) {
    const parsed = JSON.parse(cached) as ThreatIntel
    parsed.source = "cache"
    return parsed
  }

  // No API key → skip lookup
  if (!ABUSEIPDB_API_KEY) {
    console.log(`[ENRICHMENT] No AbuseIPDB API key — skipping lookup for ${ip}`)
    return skipResult
  }

  try {
    const res = await fetch(
      `https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90`,
      {
        headers: {
          "Key": ABUSEIPDB_API_KEY,
          "Accept": "application/json"
        }
      }
    )

    if (!res.ok) {
      console.error(`[ENRICHMENT] AbuseIPDB error: ${res.status} ${res.statusText}`)
      return skipResult
    }

    const body = await res.json() as {
      data: {
        abuseConfidenceScore: number
        countryCode: string
        isp: string
        totalReports: number
      }
    }

    const result: ThreatIntel = {
      isThreatIp:   body.data.abuseConfidenceScore >= 25,
      abuseScore:   body.data.abuseConfidenceScore,
      country:      body.data.countryCode || "unknown",
      isp:          body.data.isp || "unknown",
      totalReports: body.data.totalReports,
      source:       "abuseipdb"
    }

    // Cache the result in Redis
    await redis.setex(`threat:${ip}`, IP_CACHE_TTL, JSON.stringify(result))

    if (result.isThreatIp) {
      console.log(
        `[THREAT INTEL] ${ip} flagged! Score: ${result.abuseScore}%`,
        `| Country: ${result.country} | ISP: ${result.isp}`,
        `| Reports: ${result.totalReports}`
      )
    }

    return result

  } catch (err) {
    console.error(`[ENRICHMENT] AbuseIPDB lookup failed for ${ip}:`, err)
    return skipResult
  }
}

/*
MAIN
*/

export async function runEnrichmentAgent() {

  console.log("Enrichment agent starting")
  console.log(ABUSEIPDB_API_KEY
    ? "AbuseIPDB API key loaded — real-time threat intelligence enabled"
    : "No AbuseIPDB API key — threat intel disabled (set ABUSEIPDB_API_KEY)"
  )

  await consumer.connect()
  await producer.connect()
  await consumer.subscribe({ topic: INPUT_TOPIC, fromBeginning: false })

  console.log(`Subscribed to ${INPUT_TOPIC} → enriching to ${OUTPUT_TOPIC}`)

  await consumer.run({
    eachMessage: async ({ message }) => {

      const raw = message.value?.toString()
      if (!raw) return

      const event = JSON.parse(raw)
      const ip = event.sourceIp ?? "0.0.0.0"

      // Look up real threat intelligence
      const threatIntel = await checkThreatIntel(ip)

      const enriched = {
        ...event,
        enrichment: {
          ipType:        classifyIp(ip),
          loginContext:  getLoginContext(event.timestamp),
          isThreatIp:    threatIntel.isThreatIp,
          abuseScore:    threatIntel.abuseScore,
          country:       threatIntel.country,
          isp:           threatIntel.isp,
          totalReports:  threatIntel.totalReports,
          threatSource:  threatIntel.source,
          isRootAttempt: event.username === "root" || event.username === "admin",
        }
      }

      await producer.send({
        topic: OUTPUT_TOPIC,
        messages: [{ value: JSON.stringify(enriched) }]
      })

      console.log(
        `[ENRICHED] ${event.username}@${ip}`,
        `| ip=${enriched.enrichment.ipType}`,
        `| context=${enriched.enrichment.loginContext}`,
        `| abuse=${threatIntel.abuseScore}% (${threatIntel.source})`,
        threatIntel.isThreatIp ? "| THREAT IP" : "",
        enriched.enrichment.isRootAttempt ? "| ROOT ATTEMPT" : ""
      )
    }
  })
}
