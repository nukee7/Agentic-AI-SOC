import { useState } from "react"
import { useMetrics } from "./hooks/useMetrics"
import Dashboard from "./pages/Dashboard"
import SystemMap from "./pages/SystemMap"
import "./App.css"

type Page = "dashboard" | "system-map"

export default function App() {
  const [page, setPage] = useState<Page>("dashboard")
  const { data, wsStatus, lastUpdate, refresh } = useMetrics()

  const statusColor =
    wsStatus === "connected" ? "#7ef0a8" :
    wsStatus === "connecting" ? "#ffb84d" : "#ff6b7a"

  const statusLabel =
    wsStatus === "connected" ? "Live" :
    wsStatus === "connecting" ? "Connecting…" : "Polling"

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-icon">◈</span>
          <div>
            <div className="brand-name">AgentSOC</div>
            <div className="brand-sub">Intelligence Console</div>
          </div>
        </div>

        <nav className="nav">
          <button
            className={`nav-btn ${page === "dashboard" ? "active" : ""}`}
            onClick={() => setPage("dashboard")}
          >
            Live Analytics
          </button>
          <button
            className={`nav-btn ${page === "system-map" ? "active" : ""}`}
            onClick={() => setPage("system-map")}
          >
            System Map
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className="ws-status">
            <span className="ws-dot" style={{ background: statusColor }} />
            <span>{statusLabel}</span>
          </div>
          {lastUpdate && (
            <div className="last-update">
              {new Date(lastUpdate).toLocaleTimeString()}
            </div>
          )}
          <button className="refresh-btn" onClick={refresh}>
            ↻ Refresh
          </button>
        </div>
      </aside>

      <main className="main">
        {page === "dashboard" ? <Dashboard data={data} /> : <SystemMap />}
      </main>
    </div>
  )
}
