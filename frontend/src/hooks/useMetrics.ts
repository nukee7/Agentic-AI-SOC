import { useState, useEffect, useRef, useCallback } from "react"
import type { MetricsData } from "../types"

type WsStatus = "connected" | "connecting" | "disconnected"

const EMPTY: MetricsData = {
  summary: { alertsLast5Minutes: 0, incidentsOpen: 0 },
  topIps: [],
  severity: [],
  timeline: [],
}

export function useMetrics() {
  const [data, setData] = useState<MetricsData>(EMPTY)
  const [wsStatus, setWsStatus] = useState<WsStatus>("disconnected")
  const [lastUpdate, setLastUpdate] = useState<string>("")
  const wsRef = useRef<WebSocket | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined)

  const fetchAll = useCallback(async () => {
    try {
      const [summary, topIps, severity, timeline] = await Promise.all([
        fetch("/api/metrics/summary").then((r) => r.json()),
        fetch("/api/metrics/top-ips").then((r) => r.json()),
        fetch("/api/metrics/severity").then((r) => r.json()),
        fetch("/api/metrics/timeline").then((r) => r.json()),
      ])
      setData({ summary, topIps, severity, timeline })
      setLastUpdate(new Date().toISOString())
    } catch {
      // silent — polling fallback
    }
  }, [])

  const connectWs = useCallback(() => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws"
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`)

    ws.onopen = () => setWsStatus("connected")

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === "metrics_update") {
          setData(msg.data)
          setLastUpdate(msg.data.generatedAt || new Date().toISOString())
        }
      } catch {
        // ignore
      }
    }

    ws.onclose = () => {
      setWsStatus("disconnected")
      setTimeout(connectWs, 5000)
    }

    ws.onerror = () => ws.close()

    wsRef.current = ws
    setWsStatus("connecting")
  }, [])

  useEffect(() => {
    fetchAll()
    connectWs()

    pollRef.current = setInterval(fetchAll, 30_000)

    return () => {
      wsRef.current?.close()
      clearInterval(pollRef.current)
    }
  }, [fetchAll, connectWs])

  return { data, wsStatus, lastUpdate, refresh: fetchAll }
}
