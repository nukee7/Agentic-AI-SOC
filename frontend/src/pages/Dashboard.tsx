import type { MetricsData } from "../types"

interface Props {
  data: MetricsData
}

function deriveSeverity(count: number) {
  if (count >= 10) return { level: "critical", color: "#ff6b7a", suggestion: "Escalate and block immediately" }
  if (count >= 5) return { level: "high", color: "#ffb84d", suggestion: "Prioritize investigation" }
  if (count >= 2) return { level: "medium", color: "#5cc8ff", suggestion: "Watch closely" }
  return { level: "low", color: "#7ef0a8", suggestion: "Baseline activity" }
}

export default function Dashboard({ data }: Props) {
  const { summary, topIps, severity, timeline, responses } = data

  const topIp = topIps[0]?.source_ip ?? "—"
  const maxTimeline = Math.max(...timeline.map((t) => t.count), 1)
  const maxIpCount = Math.max(...topIps.map((ip) => ip.count), 1)
  const totalSev = severity.reduce((s, v) => s + v.count, 0) || 1

  const sevColors: Record<string, string> = {
    critical: "#ff6b7a",
    high: "#ffb84d",
    medium: "#5cc8ff",
    low: "#7ef0a8",
  }

  return (
    <div className="dashboard">
      {/* Stats Cards */}
      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-label">Alerts / 5 min</div>
          <div className="stat-value">{summary.alertsLast5Minutes}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Open Incidents</div>
          <div className="stat-value">{summary.incidentsOpen}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Top Source IP</div>
          <div className="stat-value mono">{topIp}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Tracked Attackers</div>
          <div className="stat-value">{topIps.length}</div>
        </div>
      </div>

      {/* Panels */}
      <div className="panels-grid">
        {/* Severity Distribution */}
        <div className="panel">
          <h3>Alert Distribution</h3>
          <p className="panel-sub">Severity mix</p>
          <div className="severity-list">
            {severity.map((s) => (
              <div key={s.severity} className="severity-row">
                <span className="severity-badge" style={{ background: sevColors[s.severity] || "#888" }}>
                  {s.severity}
                </span>
                <div className="severity-bar-wrap">
                  <div
                    className="severity-bar"
                    style={{
                      width: `${(s.count / totalSev) * 100}%`,
                      background: sevColors[s.severity] || "#888",
                    }}
                  />
                </div>
                <span className="severity-count">{s.count}</span>
              </div>
            ))}
            {severity.length === 0 && <div className="empty">No alerts yet</div>}
          </div>
        </div>

        {/* Source IP Pressure */}
        <div className="panel">
          <h3>Source IP Pressure</h3>
          <p className="panel-sub">Top attackers</p>
          <div className="ip-list">
            {topIps.slice(0, 8).map((ip, i) => (
              <div key={ip.source_ip} className="ip-row">
                <span className="ip-rank">#{i + 1}</span>
                <span className="ip-addr mono">{ip.source_ip}</span>
                <div className="ip-bar-wrap">
                  <div
                    className="ip-bar"
                    style={{ width: `${(ip.count / maxIpCount) * 100}%` }}
                  />
                </div>
                <span className="ip-count">{ip.count}</span>
              </div>
            ))}
            {topIps.length === 0 && <div className="empty">No data</div>}
          </div>
        </div>

        {/* Timeline */}
        <div className="panel panel-wide">
          <h3>Timeline</h3>
          <p className="panel-sub">Hourly volume</p>
          <div className="timeline">
            {timeline.map((t) => {
              const h = new Date(t.hour).getHours()
              const label = `${h.toString().padStart(2, "0")}:00`
              return (
                <div key={t.hour} className="timeline-bar-col">
                  <div className="timeline-bar-wrap">
                    <div
                      className="timeline-bar"
                      style={{ height: `${(t.count / maxTimeline) * 100}%` }}
                    />
                  </div>
                  <span className="timeline-label">{label}</span>
                  <span className="timeline-count">{t.count}</span>
                </div>
              )
            })}
            {timeline.length === 0 && <div className="empty">No data</div>}
          </div>
        </div>

        {/* Response Actions */}
        <div className="panel panel-wide">
          <h3>Response Actions</h3>
          <p className="panel-sub">Automated responses from the response agent</p>
          <table className="inv-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Action</th>
                <th>Source IP</th>
                <th>Reason</th>
                <th>Severity</th>
              </tr>
            </thead>
            <tbody>
              {responses.map((r) => {
                const actionColors: Record<string, string> = {
                  blocked: "#ff6b7a",
                  skipped: "#7ef0a8",
                  already_blocked: "#ffb84d",
                }
                return (
                  <tr key={r.response_id}>
                    <td className="mono">{new Date(r.timestamp).toLocaleTimeString()}</td>
                    <td>
                      <span className="sev-badge" style={{ background: actionColors[r.action] || "#5cc8ff" }}>
                        {r.action}
                      </span>
                    </td>
                    <td className="mono">{r.source_ip}</td>
                    <td className="suggestion">{r.reason}</td>
                    <td>
                      <span className="sev-badge" style={{ background: r.severity === "high" ? "#ff6b7a" : "#5cc8ff" }}>
                        {r.severity}
                      </span>
                    </td>
                  </tr>
                )
              })}
              {responses.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty">No response actions yet</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Investigation Priorities */}
        <div className="panel panel-wide">
          <h3>Investigation Priorities</h3>
          <table className="inv-table">
            <thead>
              <tr>
                <th>Source IP</th>
                <th>Alerts</th>
                <th>Severity</th>
                <th>Suggested Posture</th>
              </tr>
            </thead>
            <tbody>
              {topIps.map((ip) => {
                const sev = deriveSeverity(ip.count)
                return (
                  <tr key={ip.source_ip}>
                    <td className="mono">{ip.source_ip}</td>
                    <td>{ip.count}</td>
                    <td>
                      <span className="sev-badge" style={{ background: sev.color }}>
                        {sev.level}
                      </span>
                    </td>
                    <td className="suggestion">{sev.suggestion}</td>
                  </tr>
                )
              })}
              {topIps.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty">No alerts to investigate</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
