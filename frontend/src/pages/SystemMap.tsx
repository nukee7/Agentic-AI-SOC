export default function SystemMap() {
  const steps = [
    { num: 1, title: "Security Producers", desc: "SSH monitor agent on host captures real sshd events from macOS unified log and forwards structured alerts." },
    { num: 2, title: "Kafka Topics", desc: "security_logs, alerts, enriched_logs, and incidents — decoupled event streams for each pipeline stage." },
    { num: 3, title: "SOC Agents", desc: "Detection, anomaly, enrichment, and response agents consume events, apply rules, and produce alerts/incidents." },
    { num: 4, title: "PostgreSQL", desc: "Persistent storage for alerts, incidents, and enriched logs. Powers dashboard queries." },
    { num: 5, title: "Dashboard Intelligence", desc: "REST API + WebSocket server. Aggregates metrics from PostgreSQL and pushes live updates." },
    { num: 6, title: "Frontend Console", desc: "React app consuming real-time WebSocket data with REST API fallback." },
  ]

  const services = [
    { title: "REST APIs", desc: "Metrics summary, top IPs, severity distribution, and timeline endpoints." },
    { title: "WebSocket", desc: "Live metrics pushed every 5 seconds to all connected clients." },
    { title: "Resilient UX", desc: "Auto-reconnect WebSocket with polling fallback when connection drops." },
  ]

  return (
    <div className="system-map">
      <h2>System Architecture</h2>
      <p className="map-sub">End-to-end pipeline from attack detection to dashboard</p>

      <div className="pipeline">
        {steps.map((s) => (
          <div key={s.num} className="pipeline-step">
            <div className="step-num">{s.num}</div>
            <div className="step-content">
              <h4>{s.title}</h4>
              <p>{s.desc}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="services-grid">
        {services.map((s) => (
          <div key={s.title} className="service-card">
            <h4>{s.title}</h4>
            <p>{s.desc}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
