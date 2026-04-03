export interface SecurityEvent {
  eventId: string
  timestamp: string
  host: string
  service: string
  logType: string
  severity: "info" | "warning" | "critical"
  sourceIp: string
  username: string
  message: string
  rawLog: string
}
