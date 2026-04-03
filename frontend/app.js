/* ── State ── */
let alerts = []
let ws = null

/* ── DOM ── */
const statusDot  = document.getElementById('status-dot')
const statusText = document.getElementById('status-text')
const sTotal     = document.getElementById('s-total')
const sHigh      = document.getElementById('s-high')
const sIps       = document.getElementById('s-ips')
const sLast      = document.getElementById('s-last')
const liveFeed   = document.getElementById('live-feed')
const breakdown  = document.getElementById('breakdown')
const tblBody    = document.getElementById('tbl-body')

/* ── Navigation ── */
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'))
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'))
    btn.classList.add('active')
    document.getElementById('page-' + btn.dataset.page).classList.add('active')
  })
})

document.getElementById('btn-refresh').addEventListener('click', fetchAlerts)

/* ── Normalize alert (handle snake_case from DB + camelCase from WS) ── */
function normalize(a) {
  return {
    alertId:     a.alert_id     || a.alertId     || '',
    timestamp:   a.timestamp,
    ruleName:    a.rule_name    || a.ruleName     || 'Unknown',
    ruleId:      a.rule_id      || a.ruleId       || '',
    severity:    a.severity     || 'medium',
    sourceIp:    a.source_ip    || a.sourceIp     || '—',
    username:    a.username     || '—',
    description: a.description  || '—',
    attempts:    a.attempts     || null,
  }
}

/* ── Time helpers ── */
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - new Date(ts)) / 1000)
  if (s < 60)   return s + 's ago'
  if (s < 3600) return Math.floor(s / 60) + 'm ago'
  return Math.floor(s / 3600) + 'h ago'
}

/* ── Stats ── */
function updateStats() {
  const total = alerts.length
  const high  = alerts.filter(a => a.severity === 'high').length
  const ips   = new Set(alerts.map(a => a.sourceIp).filter(Boolean)).size
  const last  = alerts[0]

  sTotal.textContent = total
  sHigh.textContent  = high
  sIps.textContent   = ips
  sLast.textContent  = last ? timeAgo(last.timestamp) : '—'
}

/* ── Table ── */
function updateTable() {
  if (alerts.length === 0) {
    tblBody.innerHTML = '<tr><td colspan="6" class="tbl-empty">No alerts yet</td></tr>'
    return
  }

  tblBody.innerHTML = alerts.slice(0, 100).map(a => `
    <tr>
      <td>${formatTime(a.timestamp)}</td>
      <td>${a.ruleName}</td>
      <td><span class="badge badge-${a.severity}">${a.severity}</span></td>
      <td><span class="ip-mono">${a.sourceIp}</span></td>
      <td>${a.username}</td>
      <td>${a.description}</td>
    </tr>
  `).join('')
}

/* ── Live feed ── */
function addToFeed(a) {
  const empty = liveFeed.querySelector('.feed-empty')
  if (empty) empty.remove()

  const item = document.createElement('div')
  item.className = `feed-item ${a.severity}`
  item.innerHTML = `
    <div class="feed-body">
      <div class="feed-rule">${a.ruleName}</div>
      <div class="feed-meta">${a.sourceIp}${a.username !== '—' ? ' · ' + a.username : ''}</div>
    </div>
    <div class="feed-time">${formatTime(a.timestamp)}</div>
  `

  liveFeed.insertBefore(item, liveFeed.firstChild)

  while (liveFeed.children.length > 8) {
    liveFeed.removeChild(liveFeed.lastChild)
  }
}

/* ── Breakdown ── */
function updateBreakdown() {
  const counts = {}
  let max = 0

  alerts.forEach(a => {
    const key = a.ruleName
    if (!counts[key]) counts[key] = { count: 0, sev: a.severity }
    counts[key].count++
    if (counts[key].count > max) max = counts[key].count
  })

  const rows = Object.entries(counts)
    .sort((x, y) => y[1].count - x[1].count)
    .slice(0, 5)

  if (rows.length === 0) {
    breakdown.innerHTML = '<div class="feed-empty">No data yet</div>'
    return
  }

  breakdown.innerHTML = rows.map(([rule, d]) => `
    <div class="bk-row">
      <div class="bk-label">
        <span>${rule}</span>
        <span class="bk-count">${d.count}</span>
      </div>
      <div class="bk-track">
        <div class="bk-fill ${d.sev}" style="width:${Math.round(d.count / max * 100)}%"></div>
      </div>
    </div>
  `).join('')
}

/* ── Fetch from API ── */
async function fetchAlerts() {
  try {
    const res = await fetch('/api/alerts')
    if (!res.ok) return
    const data = await res.json()

    alerts = (Array.isArray(data) ? data : []).map(normalize)

    updateStats()
    updateTable()
    updateBreakdown()

    // Seed feed on first load
    if (!liveFeed.querySelector('.feed-item')) {
      alerts.slice(0, 5).reverse().forEach(addToFeed)
    }
  } catch (e) {
    console.warn('API unavailable:', e.message)
  }
}

/* ── WebSocket ── */
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(`${proto}//${location.host}/ws`)

  ws.onopen = () => {
    statusDot.className = 'status-dot connected'
    statusText.textContent = 'Connected'
  }

  ws.onclose = () => {
    statusDot.className = 'status-dot disconnected'
    statusText.textContent = 'Disconnected'
    setTimeout(connectWS, 5000)
  }

  ws.onerror = () => {
    statusDot.className = 'status-dot disconnected'
    statusText.textContent = 'Error'
  }

  ws.onmessage = ({ data }) => {
    try {
      const raw   = JSON.parse(data)
      const alert = normalize(raw)
      alerts.unshift(alert)
      addToFeed(alert)
      updateStats()
      updateTable()
      updateBreakdown()
    } catch {
      // ignore malformed messages
    }
  }
}

/* ── Init ── */
fetchAlerts()
connectWS()
setInterval(fetchAlerts, 30000)
