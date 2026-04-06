export interface Summary {
  alertsLast5Minutes: number
  incidentsOpen: number
}

export interface TopIp {
  source_ip: string
  count: number
}

export interface SeverityCount {
  severity: string
  count: number
}

export interface TimelineEntry {
  hour: string
  count: number
}

export interface MetricsData {
  summary: Summary
  topIps: TopIp[]
  severity: SeverityCount[]
  timeline: TimelineEntry[]
}
