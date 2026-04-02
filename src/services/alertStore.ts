import { redisClient } from "./redisClient"

export interface Alert {

  alertType: string

  severity: string

  timestamp: string

  user: string

  sourceIp: string

  failedAttempts: number

  service: string

}

/* Store alert in Redis list */

export async function storeAlert(

  alert: Alert

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