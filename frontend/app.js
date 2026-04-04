const state = {
  metrics: {
    summary: null,
    topIps: [],
    severity: [],
    timeline: [],
    generatedAt: null
  },
  ws: null,
  reconnectTimer: null,
  pollTimer: null
}

const dom = {
  statusDot: document.getElementById("status-dot"),
  statusText: document.getElementById("status-text"),
  updatedAt: document.getElementById("updated-at"),
  refreshButton: document.getElementById("btn-refresh"),
  alertsLast5: document.getElementById("s-alerts-last-5"),
  incidentsOpen: document.getElementById("s-incidents-open"),
  topSourceIp: document.getElementById("s-top-source-ip"),
  totalTrackedIps: document.getElementById("s-total-tracked-ips"),
  severityList: document.getElementById("severity-list"),
  topIpsList: document.getElementById("top-ips-list"),
  timelineChart: document.getElementById("timeline-chart"),
  timelineEmpty: document.getElementById("timeline-empty"),
  streamFeed: document.getElementById("stream-feed"),
  tblBody: document.getElementById("tbl-body")
}

const severityRank = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1
}

function setConnectionStatus(status) {
  dom.statusDot.className = `status-dot ${status}`

  if (status === "connected") {
    dom.statusText.textContent = "Live stream connected"
    return
  }

  if (status === "connecting") {
    dom.statusText.textContent = "Connecting to analytics stream"
    return
  }

  dom.statusText.textContent = "Stream offline, polling APIs"
}

function formatTimestamp(ts) {
  if (!ts) {
    return "Pending"
  }

  return new Date(ts).toLocaleString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    day: "2-digit",
    month: "short"
  })
}

function formatCompactNumber(value) {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(Number(value || 0))
}

function renderSummary() {
  const summary = state.metrics.summary || {}
  const topIps = state.metrics.topIps || []

  dom.alertsLast5.textContent = formatCompactNumber(summary.alertsLast5Minutes || 0)
  dom.incidentsOpen.textContent = formatCompactNumber(summary.incidentsOpen || 0)
  dom.topSourceIp.textContent = topIps[0]?.source_ip || "None"
  dom.totalTrackedIps.textContent = formatCompactNumber(topIps.length)
  dom.updatedAt.textContent = formatTimestamp(state.metrics.generatedAt)
}

function renderSeverity() {
  const rows = [...(state.metrics.severity || [])]
    .map(item => ({
      severity: String(item.severity || "unknown").toLowerCase(),
      count: Number(item.count || 0)
    }))
    .sort((left, right) => {
      const diff =
        (severityRank[right.severity] || 0) -
        (severityRank[left.severity] || 0)

      return diff || right.count - left.count
    })

  if (rows.length === 0) {
    dom.severityList.innerHTML =
      '<div class="panel-empty">No severity data available yet.</div>'
    return
  }

  const max = Math.max(...rows.map(row => row.count), 1)

  dom.severityList.innerHTML = rows.map(row => `
    <div class="metric-row">
      <div class="metric-row-head">
        <span class="badge badge-${row.severity}">${row.severity}</span>
        <span class="metric-value">${row.count}</span>
      </div>
      <div class="metric-track">
        <div class="metric-fill fill-${row.severity}" style="width:${Math.round((row.count / max) * 100)}%"></div>
      </div>
    </div>
  `).join("")
}

function renderTopIps() {
  const rows = [...(state.metrics.topIps || [])]
    .map(item => ({
      sourceIp: item.source_ip || "Unknown",
      count: Number(item.count || 0)
    }))

  if (rows.length === 0) {
    dom.topIpsList.innerHTML =
      '<div class="panel-empty">No source IP data available yet.</div>'
    return
  }

  const max = Math.max(...rows.map(row => row.count), 1)

  dom.topIpsList.innerHTML = rows.map((row, index) => `
    <div class="ip-row">
      <div class="ip-rank">${index + 1}</div>
      <div class="ip-meta">
        <div class="ip-address">${row.sourceIp}</div>
        <div class="metric-track compact">
          <div class="metric-fill fill-default" style="width:${Math.round((row.count / max) * 100)}%"></div>
        </div>
      </div>
      <div class="ip-count">${row.count}</div>
    </div>
  `).join("")
}

function renderTimeline() {
  const rows = [...(state.metrics.timeline || [])]
    .map(item => ({
      label: new Date(item.hour).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      }),
      count: Number(item.count || item.count_1 || 0)
    }))

  if (rows.length === 0) {
    dom.timelineChart.innerHTML = ""
    dom.timelineEmpty.hidden = false
    return
  }

  dom.timelineEmpty.hidden = true

  const max = Math.max(...rows.map(row => row.count), 1)

  dom.timelineChart.innerHTML = rows.map(row => `
    <div class="timeline-bar-wrap">
      <div class="timeline-bar" style="height:${Math.max(16, Math.round((row.count / max) * 100))}%">
        <span class="timeline-bar-value">${row.count}</span>
      </div>
      <div class="timeline-label">${row.label}</div>
    </div>
  `).join("")
}

function renderFeed() {
  const timeline = [...(state.metrics.timeline || [])]
    .slice(-6)
    .reverse()

  if (timeline.length === 0) {
    dom.streamFeed.innerHTML =
      '<div class="panel-empty">Waiting for the first analytics snapshot.</div>'
    return
  }

  dom.streamFeed.innerHTML = timeline.map(item => `
    <div class="feed-item live">
      <div class="feed-body">
        <div class="feed-rule">${new Date(item.hour).toLocaleString([], { hour: "2-digit", minute: "2-digit", month: "short", day: "2-digit" })}</div>
        <div class="feed-meta">Alerts aggregated in this hourly bucket</div>
      </div>
      <div class="feed-time">${Number(item.count || 0)}</div>
    </div>
  `).join("")
}

function renderTable() {
  const rows = [...(state.metrics.topIps || [])]
    .map(item => ({
      sourceIp: item.source_ip || "Unknown",
      count: Number(item.count || 0),
      severity: inferSeverityFromTopIps(item),
      posture: derivePosture(Number(item.count || 0))
    }))

  if (rows.length === 0) {
    dom.tblBody.innerHTML =
      '<tr><td colspan="4" class="tbl-empty">No attacker IP analytics available yet.</td></tr>'
    return
  }

  dom.tblBody.innerHTML = rows.map(row => `
    <tr>
      <td><span class="ip-mono">${row.sourceIp}</span></td>
      <td>${row.count}</td>
      <td><span class="badge badge-${row.severity}">${row.severity}</span></td>
      <td>${row.posture}</td>
    </tr>
  `).join("")
}

function inferSeverityFromTopIps(item) {
  const count = Number(item.count || 0)

  if (count >= 10) {
    return "critical"
  }

  if (count >= 5) {
    return "high"
  }

  if (count >= 2) {
    return "medium"
  }

  return "low"
}

function derivePosture(count) {
  if (count >= 10) {
    return "Escalate and block immediately"
  }

  if (count >= 5) {
    return "Prioritize investigation"
  }

  if (count >= 2) {
    return "Watch closely"
  }

  return "Baseline activity"
}

function renderAll() {
  renderSummary()
  renderSeverity()
  renderTopIps()
  renderTimeline()
  renderFeed()
  renderTable()
}

async function fetchJson(url) {
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`Request failed for ${url}`)
  }

  return response.json()
}

async function fetchMetricsSnapshot() {
  const [summary, topIps, severity, timeline] = await Promise.all([
    fetchJson("/api/metrics/summary"),
    fetchJson("/api/metrics/top-ips"),
    fetchJson("/api/metrics/severity"),
    fetchJson("/api/metrics/timeline")
  ])

  state.metrics = {
    summary,
    topIps,
    severity,
    timeline,
    generatedAt: new Date().toISOString()
  }

  renderAll()
}

function handleMetricsUpdate(payload) {
  if (!payload || typeof payload !== "object") {
    return
  }

  state.metrics = {
    summary: payload.summary || state.metrics.summary,
    topIps: Array.isArray(payload.topIps) ? payload.topIps : state.metrics.topIps,
    severity: Array.isArray(payload.severity) ? payload.severity : state.metrics.severity,
    timeline: Array.isArray(payload.timeline) ? payload.timeline : state.metrics.timeline,
    generatedAt: payload.generatedAt || new Date().toISOString()
  }

  renderAll()
}

function connectWebSocket() {
  clearTimeout(state.reconnectTimer)

  const protocol = location.protocol === "https:" ? "wss:" : "ws:"
  const socket = new WebSocket(`${protocol}//${location.host}/ws`)
  state.ws = socket

  setConnectionStatus("connecting")

  socket.onopen = () => {
    setConnectionStatus("connected")
  }

  socket.onmessage = event => {
    try {
      const message = JSON.parse(event.data)

      if (message.type === "metrics_update") {
        handleMetricsUpdate(message.data)
      }
    } catch (error) {
      console.warn("Ignoring malformed WebSocket payload", error)
    }
  }

  socket.onerror = () => {
    setConnectionStatus("disconnected")
  }

  socket.onclose = () => {
    setConnectionStatus("disconnected")
    state.reconnectTimer = setTimeout(connectWebSocket, 5000)
  }
}

async function refreshDashboard() {
  dom.refreshButton.disabled = true

  try {
    await fetchMetricsSnapshot()
  } catch (error) {
    console.warn("Unable to refresh metrics", error)
  } finally {
    dom.refreshButton.disabled = false
  }
}

document.querySelectorAll(".nav-btn").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach(item => item.classList.remove("active"))
    document.querySelectorAll(".page").forEach(page => page.classList.remove("active"))
    button.classList.add("active")
    document.getElementById(`page-${button.dataset.page}`).classList.add("active")
  })
})

dom.refreshButton.addEventListener("click", refreshDashboard)

renderAll()
refreshDashboard()
connectWebSocket()
state.pollTimer = setInterval(refreshDashboard, 30000)
