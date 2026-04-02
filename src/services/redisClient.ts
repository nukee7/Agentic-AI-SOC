import { createClient } from "redis"

export const redisClient = createClient({

  url: "redis://localhost:6379"

})

redisClient.on("error", (err) => {

  console.error("Redis error:", err)

})

export async function connectRedis() {

  if (!redisClient.isOpen) {

    await redisClient.connect()

    console.log("Connected to Redis")

  }

}