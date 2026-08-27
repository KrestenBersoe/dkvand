// ═══════════════════════════════════════════════════════════════════════════
// admin-dashboard-stats.js — cross-market admin dashboard (bruger-krav
// 2026-08-27), delt mellem internal-choose-country.html (country='ALL') og
// internal-country-admin.html (country=dens eget land)
// ═══════════════════════════════════════════════════════════════════════════
//
// Visuelt: SAMME stat-card-/trend-graf-udseende som stats.html (den
// offentlige side dette dashboard erstatter, se server.js's fjernede
// GET /stats) — renderTrendChart() herunder er lige på linjenummeret
// overtaget derfra, uændret. Datamæssigt: 7 nye/genbrugte mål for en
// VALGBAR periode i stedet for stats.html's faste installations-/
// abonnement-/vurderings-/push-tal og faste 90-dages historik — se
// server.js's GET /internal/api/admin-stats og admin-stats.js's filhoved.
//
// ÉN fil, genbrugt af to sider (første tilfælde af en delt JS-fil på tværs
// af flere admin-sider i dette repo) — CSS forbliver dupliceret i hver
// vært-side (samme etablerede mønster som internal-sales.html/
// internal-create-trial.html allerede har for hinanden), kun selve
// logikken er delt.
'use strict';

const ADMIN_STATS_PERIOD_LABELS = {
  today: 'I dag', '7d': 'Sidste 7 dage', '30d': 'Sidste 30 dage',
  quarter: 'Sidste kvartal', halfyear: 'Sidste halvår', ytd: 'I år (indtil nu)',
};

const ADMIN_STATS_METRICS = [
  { key: 'siteViews',            label: 'Site-detaljevisninger',   trendLabel: 'Site-detaljevisninger' },
  { key: 'pageViews',            label: 'Sidevisninger',           trendLabel: 'Sidevisninger' },
  { key: 'newInstalls',          label: 'Nye installationer',      trendLabel: 'Nye installationer', note: s => `${s.totals.activeInstalls} aktive lige nu` },
  { key: 'newPushSubscriptions', label: 'Nye webpush-abonnenter',  trendLabel: 'Nye webpush-abonnenter', note: s => `${s.totals.pushSubscriptions} i alt lige nu` },
  { key: 'reports',              label: 'Indberetninger',          trendLabel: 'Indberetninger' },
  { key: 'alertsSent',           label: 'Varsler udsendt',         trendLabel: 'Varsler udsendt' },
  { key: 'closedSites',          label: 'Lukkede badesteder',      trendLabel: 'Lukkede badesteder', note: () => 'Distinkte steder med en aktiv lukket-status i perioden' },
];

function escHtmlAds(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Trend-graf — overtaget UÆNDRET fra stats.html, se dens egen kommentar
// for dataviz-begrundelsen (linje 2px/rund cap, arealfyld ~10-16% opacitet,
// hårfine gridlinjer, slutpunkt-mærkat, crosshair+tooltip på hover). ────────
function fmtDateShortAds(d) {
  const [, m, day] = d.split('-');
  return `${day}/${m}`;
}
function fmtCountAds(n) { return Math.round(n).toLocaleString('da-DK'); }

let _adsTrendChartSeq = 0;
function renderTrendChart(containerId, points, opts) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  if (points.length === 0) {
    wrap.innerHTML = '<div class="trend-empty">Ingen data endnu — første punkt gemmes i løbet af i dag</div>';
    return;
  }
  if (points.length === 1) {
    wrap.innerHTML = `<div class="trend-empty">${fmtCountAds(points[0].value)} (${fmtDateShortAds(points[0].date)}) — for lidt historik til en graf endnu</div>`;
    return;
  }

  const W = 600, H = 150;
  const padL = 4, padR = 46, padT = 10, padB = 20;
  const plotL = padL, plotR = W - padR, plotT = padT, plotB = H - padB;
  const plotW = plotR - plotL, plotH = plotB - plotT;

  const values = points.map(p => p.value);
  let vMin = Math.min(...values), vMax = Math.max(...values);
  if (vMin === vMax) { vMin = Math.max(0, vMin - 1); vMax = vMax + 1; }
  const yPad = (vMax - vMin) * 0.12;
  vMin = Math.max(0, vMin - yPad);
  vMax = vMax + yPad;

  const xAt = i => plotL + (plotW * i) / (points.length - 1);
  const yAt = v => plotB - ((v - vMin) / (vMax - vMin)) * plotH;

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(p.value).toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${xAt(points.length - 1).toFixed(1)},${plotB} L${xAt(0).toFixed(1)},${plotB} Z`;
  const last = points[points.length - 1];
  const gradId = `trendGrad${_adsTrendChartSeq++}`;

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${opts.label} over tid, seneste værdi ${fmtCountAds(last.value)}">
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" class="trend-grad-stop-1"/>
          <stop offset="100%" class="trend-grad-stop-2"/>
        </linearGradient>
      </defs>
      <line class="trend-grid-line" x1="${plotL}" y1="${plotT}" x2="${plotR}" y2="${plotT}"/>
      <line class="trend-grid-line" x1="${plotL}" y1="${(plotT + plotB) / 2}" x2="${plotR}" y2="${(plotT + plotB) / 2}"/>
      <line class="trend-grid-line" x1="${plotL}" y1="${plotB}" x2="${plotR}" y2="${plotB}"/>
      <path fill="url(#${gradId})" d="${areaPath}"/>
      <path class="trend-line" d="${linePath}"/>
      <circle class="trend-end-dot" cx="${xAt(points.length - 1).toFixed(1)}" cy="${yAt(last.value).toFixed(1)}" r="5"/>
      <text class="trend-end-label" x="${(plotR + 8).toFixed(1)}" y="${yAt(last.value).toFixed(1)}" dominant-baseline="middle">${fmtCountAds(last.value)}</text>
      <text class="trend-axis-label" x="${plotL}" y="${H - 4}">${fmtDateShortAds(points[0].date)}</text>
      <text class="trend-axis-label" x="${plotR}" y="${H - 4}" text-anchor="end">${fmtDateShortAds(last.date)}</text>
      <line class="trend-crosshair" x1="0" y1="${plotT}" x2="0" y2="${plotB}"/>
      <circle class="trend-hover-dot" r="5"/>
      <rect class="trend-hit-layer" x="${plotL}" y="0" width="${plotW}" height="${H}"/>
    </svg>
    <div class="trend-tooltip"><span class="tt-date"></span><span class="tt-value"></span></div>
  `;

  const svgEl      = wrap.querySelector('svg');
  const hitLayer   = wrap.querySelector('.trend-hit-layer');
  const crosshair  = wrap.querySelector('.trend-crosshair');
  const hoverDot   = wrap.querySelector('.trend-hover-dot');
  const tooltip    = wrap.querySelector('.trend-tooltip');
  const ttDate     = tooltip.querySelector('.tt-date');
  const ttValue    = tooltip.querySelector('.tt-value');

  function showAt(clientX) {
    const rect = svgEl.getBoundingClientRect();
    const svgX = ((clientX - rect.left) / rect.width) * W;
    let idx = Math.round(((svgX - plotL) / plotW) * (points.length - 1));
    idx = Math.max(0, Math.min(points.length - 1, idx));
    const p = points[idx];
    const px = xAt(idx), py = yAt(p.value);
    crosshair.setAttribute('x1', px); crosshair.setAttribute('x2', px);
    crosshair.style.opacity = '1';
    hoverDot.setAttribute('cx', px); hoverDot.setAttribute('cy', py);
    hoverDot.style.opacity = '1';
    tooltip.style.opacity = '1';
    tooltip.style.left = `${(px / W) * 100}%`;
    tooltip.style.top  = `${(py / H) * 100}%`;
    ttDate.textContent  = p.date;
    ttValue.textContent = fmtCountAds(p.value);
  }
  function hide() {
    crosshair.style.opacity = '0';
    hoverDot.style.opacity  = '0';
    tooltip.style.opacity   = '0';
  }
  hitLayer.addEventListener('pointermove', e => showAt(e.clientX));
  hitLayer.addEventListener('pointerdown', e => showAt(e.clientX));
  hitLayer.addEventListener('pointerleave', hide);
}

/**
 * @param {{containerId: string, country: 'ALL'|'DK'|'UK'|'FR'}} p — containerId
 *   peger på et TOMT element, hvis indhold denne funktion helt overtager
 *   (periode-vælger + stat-grid + trend-grid), samme "overtag hele
 *   #content"-mønster som stats.html's egen loadStats().
 */
function initAdminDashboard({ containerId, country }) {
  const root = document.getElementById(containerId);
  if (!root) return;

  root.innerHTML = `
    <div class="stat-controls" style="margin-bottom:1rem">
      <label for="ads-period">Periode</label>
      <select id="ads-period">
        ${Object.entries(ADMIN_STATS_PERIOD_LABELS).map(([v, l]) => `<option value="${v}"${v === '7d' ? ' selected' : ''}>${escHtmlAds(l)}</option>`).join('')}
      </select>
    </div>
    <div id="ads-content" class="loading">Indlæser…</div>
  `;

  document.getElementById('ads-period').addEventListener('change', load);
  load();

  async function load() {
    const content = document.getElementById('ads-content');
    const period = document.getElementById('ads-period').value;
    content.className = 'loading';
    content.textContent = 'Indlæser…';
    try {
      const resp = await fetch(`/internal/api/admin-stats?period=${encodeURIComponent(period)}&country=${encodeURIComponent(country)}`, { cache: 'no-store' });
      const s = await resp.json();
      if (!resp.ok) throw new Error(s.error || `HTTP ${resp.status}`);

      content.className = '';
      content.innerHTML = `
        <div class="grid">
          ${ADMIN_STATS_METRICS.map(m => `
            <div class="card">
              <h2>${escHtmlAds(m.label)}</h2>
              <div class="stat">${fmtCountAds(s.totals[m.key])}</div>
              ${m.note ? `<div class="stat-note">${escHtmlAds(m.note(s))}</div>` : ''}
            </div>
          `).join('')}
        </div>

        <h1 style="font-size:1rem;margin:0 0 .8rem">Udvikling over perioden</h1>
        <div class="trend-grid">
          ${ADMIN_STATS_METRICS.map(m => `
            <div class="card trend-card">
              <h2>${escHtmlAds(m.trendLabel)}</h2>
              <div class="trend-chart-wrap" id="ads-trend-${m.key}"></div>
            </div>
          `).join('')}
        </div>
      `;
      for (const m of ADMIN_STATS_METRICS) {
        renderTrendChart(`ads-trend-${m.key}`, s.trends[m.key], { label: m.trendLabel });
      }
    } catch (e) {
      content.className = 'err';
      content.textContent = `Kunne ikke hente statistik: ${e.message}`;
    }
  }
}
