/**
 * Perf-Trace-Pulse — Side Panel logic
 * - Recording name is optional; prompted at download time if missing
 * - Download blocked while recording
 * - v1.9.1: Live network inspector with DevTools-style
 *           Headers / Payload / Response / Timing tabs
 */

'use strict';

const recordBtn = document.getElementById('recordBtn');
const statusBadge = document.getElementById('statusBadge');
const recordingNameInput = document.getElementById('recordingName');
const outputDiv = document.getElementById('output');
const liveStats = document.getElementById('liveStats');
const downloadZipBtn = document.getElementById('downloadZipBtn');
const networkList = document.getElementById('networkList');
const netCount = document.getElementById('netCount');

let port = null;
let timer = null;
let startTime = 0;

// ── Network inspector state ────────────────────────────────────────
const requests = new Map();      // id → summary
let selectedRequestId = null;
let activeTab = 'headers';

// ── Port connection to service worker ──────────────────────────────
function connectToServiceWorker() {
  port = chrome.runtime.connect({ name: 'perf-trace-panel' });
  port.onMessage.addListener(onPortMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connectToServiceWorker, 1000);
  });
}

function onPortMessage(message) {
  switch (message.type) {
    case 'RECORDING_STATUS':
      applyStatus(message.recording, message.currentRecording);
      break;
    case 'RECORDING_STARTED':
      applyStatus(true);
      addLog('Recording started');
      startTimer();
      requests.clear();
      renderNetworkList();
      break;
    case 'RECORDING_STOPPED':
      applyStatus(false);
      addLog('Recording stopped');
      stopTimer();
      downloadZipBtn.classList.remove('hidden');
       loadHistory();
      break;
    case 'REPORT_READY':
      addLog('Report ready: ' + message.reportId);
      break;
    case 'REQUESTS_CLEARED':
      requests.clear();
      renderNetworkList();
      break;
    case 'REQUEST_ADDED':
      if (message.request) {
        requests.set(message.request.id, message.request);
        renderNetworkList();
      }
      break;
    case 'REQUEST_UPDATED':
      if (message.request && requests.has(message.request.id)) {
        const merged = Object.assign({}, requests.get(message.request.id), message.request);
        requests.set(message.request.id, merged);
        updateRow(message.request.id);
      } else if (message.request) {
        requests.set(message.request.id, message.request);
        renderNetworkList();
      }
      break;
  }
}

// ── UI helpers ─────────────────────────────────────────────────────
function applyStatus(recording, currentRecording) {
  if (recording) {
    statusBadge.textContent = currentRecording
      ? 'Recording: ' + (currentRecording.name || '(unnamed)') : 'Recording…';
    statusBadge.className = 'status status-recording';
    recordBtn.textContent = 'Stop Recording';
    recordBtn.className = 'btn btn-stop';
    recordingNameInput.disabled = true;
    liveStats.classList.remove('hidden');
    downloadZipBtn.classList.add('hidden');
  } else {
    statusBadge.textContent = 'Idle';
    statusBadge.className = 'status status-idle';
    recordBtn.textContent = 'Start Recording';
    recordBtn.className = 'btn btn-record';
    recordingNameInput.disabled = false;
  }
}

function addLog(message) {
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.textContent = new Date().toLocaleTimeString() + ' ' + message;
  outputDiv.appendChild(entry);
  outputDiv.scrollTop = outputDiv.scrollHeight;
}

// ── Timer & live stats ─────────────────────────────────────────────
function startTimer() {
  startTime = Date.now();
  timer = setInterval(() => {
    const s = Math.floor((Date.now() - startTime) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    document.getElementById('statDuration').textContent = mm + ':' + ss;

    chrome.runtime.sendMessage({ type: 'GET_LIVE_STATS' }, (res) => {
      if (res && res.ok) {
        document.getElementById('statActions').textContent = res.actions;
        document.getElementById('statRequests').textContent = res.requests;
        document.getElementById('statErrors').textContent = res.errors;
        document.getElementById('statShots').textContent = res.screenshots || 0;
      }
    });
  }, 1000);
}

function stopTimer() {
  clearInterval(timer);
  timer = null;
}

// ── Network list rendering ─────────────────────────────────────────
function statusClass(req) {
  if (req.failed) return 'err';
  if (!req.status) return 'pending';
  if (req.status >= 400) return 'err';
  if (req.status >= 300) return 'redirect';
  return 'ok';
}

function shortenUrl(url) {
  try {
    const u = new URL(url);
    const host = u.host;
    const path = u.pathname + (u.search || '');
    return { host, path };
  } catch (_) {
    return { host: '', path: url || '' };
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function rowHtml(req) {
  const u = shortenUrl(req.url);
  const m = (req.method || 'GET').toUpperCase();
  const methodCls = m.toLowerCase();
  const sCls = statusClass(req);
  const statusTxt = req.failed ? 'ERR' : (req.status || '…');
  const dur = req.durationMs != null ? req.durationMs + ' ms' : '';
  const durCls = req.durationMs > 1000 ? 'net-dur slow' : 'net-dur';
  return `
    <div class="net-method ${methodCls}">${escapeHtml(m)}</div>
    <div class="net-status ${sCls}">${escapeHtml(statusTxt)}</div>
    <div class="net-url" title="${escapeHtml(req.url)}">
      <span class="host">${escapeHtml(u.host)}</span>${escapeHtml(u.path)}
    </div>
    <div class="${durCls}">${escapeHtml(dur)}</div>
  `;
}

function renderNetworkList() {
  const list = Array.from(requests.values())
    .sort((a, b) => (a.relativeMs || 0) - (b.relativeMs || 0));

  netCount.textContent = list.length;

  if (!list.length) {
    networkList.innerHTML = '<div class="empty">No requests captured yet. Start a recording to inspect network traffic.</div>';
    return;
  }

  networkList.innerHTML = list.map((r) => `
    <div class="net-row" data-id="${escapeHtml(r.id)}">
      ${rowHtml(r)}
    </div>
  `).join('');

  // Bind click handlers
  networkList.querySelectorAll('.net-row').forEach((row) => {
    row.addEventListener('click', () => openRequestDetail(row.dataset.id));
  });
}

function updateRow(id) {
  const row = networkList.querySelector(`.net-row[data-id="${id}"]`);
  const req = requests.get(id);
  if (!row || !req) { renderNetworkList(); return; }
  row.innerHTML = rowHtml(req);
}

// ── Request detail overlay ─────────────────────────────────────────
const reqDetail     = document.getElementById('reqDetail');
const reqDetailBack = document.getElementById('reqDetailBack');
const reqDetailTitle = document.getElementById('reqDetailTitle');
const reqDetailUrl  = document.getElementById('reqDetailUrl');
const reqDetailStatus = document.getElementById('reqDetailStatus');
const reqTabContent = document.getElementById('reqTabContent');

reqDetailBack.addEventListener('click', () => {
  reqDetail.classList.add('hidden');
  selectedRequestId = null;
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    activeTab = tab.dataset.tab;
    if (selectedRequestId) {
      chrome.runtime.sendMessage({ type: 'GET_REQUEST_DETAIL', id: selectedRequestId }, (res) => {
        if (res && res.ok) renderTab(res.request);
      });
    }
  });
});

async function openRequestDetail(id) {
  selectedRequestId = id;
  reqDetail.classList.remove('hidden');
  reqTabContent.innerHTML = '<div class="empty-msg">Loading…</div>';

  chrome.runtime.sendMessage({ type: 'GET_REQUEST_DETAIL', id }, (res) => {
    if (!res || !res.ok) {
      reqTabContent.innerHTML = `<div class="empty-msg">${escapeHtml((res && res.error) || 'Request not found')}</div>`;
      return;
    }
    renderDetailHeader(res.request);
    renderTab(res.request);
  });
}

function renderDetailHeader(req) {
  const m = (req.method || 'GET').toUpperCase();
  reqDetailTitle.textContent = m + ' ' + shortenUrl(req.url).path;
  reqDetailUrl.textContent = req.url;

  const cls = statusClass(req);
  const txt = req.failed
    ? 'FAILED'
    : (req.status ? (req.status + (req.statusText ? ' ' + req.statusText : '')) : 'pending');
  reqDetailStatus.textContent = txt;
  reqDetailStatus.className = 'req-detail-status ' + cls;
}

function renderTab(req) {
  switch (activeTab) {
    case 'headers':  return renderHeadersTab(req);
    case 'payload':  return renderPayloadTab(req);
    case 'response': return renderResponseTab(req);
    case 'timing':   return renderTimingTab(req);
  }
}

// ── Headers tab ────────────────────────────────────────────────────
function kvTable(obj) {
  if (!obj || !Object.keys(obj).length) return '<div class="empty-msg">—</div>';
  return `<table class="kv-table">${Object.entries(obj)
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(
      typeof v === 'object' ? JSON.stringify(v) : String(v)
    )}</td></tr>`).join('')}</table>`;
}

function renderHeadersTab(req) {
  const general = {
    'Request URL': req.url,
    'Request Method': req.method,
    'Status Code': req.failed ? 'FAILED' : (req.status || 'pending') +
                    (req.statusText ? ' ' + req.statusText : ''),
    'Protocol': req.protocol || '—',
    'From cache': req.fromCache ? 'yes' : 'no'
  };

  reqTabContent.innerHTML = `
    <div class="section-title">General</div>
    ${kvTable(general)}
    <div class="section-title">Response Headers</div>
    ${kvTable(req.responseHeaders)}
    <div class="section-title">Request Headers</div>
    ${kvTable(req.requestHeaders)}
  `;
}

// ── Payload tab ────────────────────────────────────────────────────
function tryPrettyJson(s) {
  if (typeof s !== 'string') return s;
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch (_) { return s; }
}

function isJsonish(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (!t) return false;
  if (t[0] !== '{' && t[0] !== '[') return false;
  try { JSON.parse(t); return true; } catch (_) { return false; }
}

function renderPayloadTab(req) {
  const m = (req.method || 'GET').toUpperCase();

  // 1. Actual body captured
  if (req.postData && req.postData.length) {
    const pretty = tryPrettyJson(req.postData);
    const isJson = isJsonish(req.postData);
    reqTabContent.innerHTML = `
      <div class="section-title">Request Payload</div>
      <div class="payload-toolbar">
        <button data-view="pretty" class="active">${isJson ? 'Pretty' : 'View'}</button>
        <button data-view="raw">Raw</button>
      </div>
      <pre class="code-block" id="payloadPre">${escapeHtml(pretty)}</pre>
    `;
    const pre = document.getElementById('payloadPre');
    reqTabContent.querySelectorAll('.payload-toolbar button').forEach((btn) => {
      btn.addEventListener('click', () => {
        reqTabContent.querySelectorAll('.payload-toolbar button')
          .forEach((b) => b.classList.toggle('active', b === btn));
        pre.textContent = btn.dataset.view === 'pretty' ? pretty : req.postData;
      });
    });
    return;
  }

  // 2. GET/HEAD → show query string
  if (m === 'GET' || m === 'HEAD') {
    let qs = null;
    try { qs = new URL(req.url).searchParams; } catch (_) {}
    if (qs && Array.from(qs.keys()).length) {
      const obj = {};
      qs.forEach((v, k) => { obj[k] = v; });
      reqTabContent.innerHTML = `
        <div class="section-title">Query String Parameters</div>
        ${kvTable(obj)}
      `;
    } else {
      reqTabContent.innerHTML = `
        <div class="empty-msg">This request has no query string parameters.</div>
      `;
    }
    return;
  }

  // 3. Body-carrying method but nothing captured
  reqTabContent.innerHTML = `
    <div class="empty-msg">No request payload captured for this ${escapeHtml(m)} request.<br><br>
    Tip: ensure the service worker was updated to pass <code>maxPostDataSize</code> to <code>Network.enable</code>.</div>
  `;
}

// ── Response tab ───────────────────────────────────────────────────
function renderResponseTab(req) {
  if (!req.responseBody) {
    reqTabContent.innerHTML = `<div class="empty-msg">No response body captured.<br>
      (Binary responses, redirects, or bodies exceeding the size limit are not stored.)</div>`;
    return;
  }
  if (req.responseBodyBase64) {
    reqTabContent.innerHTML = `<div class="empty-msg">Binary response (${escapeHtml(req.mimeType || 'unknown')}) — not shown.</div>`;
    return;
  }
  const pretty = tryPrettyJson(req.responseBody);
  const isJson = isJsonish(req.responseBody);
  reqTabContent.innerHTML = `
    <div class="section-title">Response Body (${escapeHtml(req.mimeType || 'text')})</div>
    <div class="payload-toolbar">
      <button data-view="pretty" class="active">${isJson ? 'Pretty' : 'View'}</button>
      <button data-view="raw">Raw</button>
    </div>
    <pre class="code-block" id="respPre">${escapeHtml(pretty)}</pre>
  `;
  const pre = document.getElementById('respPre');
  reqTabContent.querySelectorAll('.payload-toolbar button').forEach((btn) => {
    btn.addEventListener('click', () => {
      reqTabContent.querySelectorAll('.payload-toolbar button')
        .forEach((b) => b.classList.toggle('active', b === btn));
      pre.textContent = btn.dataset.view === 'pretty' ? pretty : req.responseBody;
    });
  });
}

// ── Timing tab ─────────────────────────────────────────────────────
function renderTimingTab(req) {
  const rows = [];
  rows.push(['Started', req.startTime ? new Date(req.startTime).toLocaleTimeString() : '—']);
  rows.push(['Duration', (req.durationMs != null ? req.durationMs + ' ms' : '—')]);
  rows.push(['Transfer size', (req.encodedDataLength != null
    ? (req.encodedDataLength >= 1024
        ? (req.encodedDataLength / 1024).toFixed(1) + ' KB'
        : req.encodedDataLength + ' B')
    : '—')]);
  rows.push(['Protocol', req.protocol || '—']);
  rows.push(['From cache', req.fromCache ? 'yes' : 'no']);

  let t = req.timing || {};
  const tKeys = ['requestTime', 'proxyStart', 'proxyEnd', 'dnsStart', 'dnsEnd',
                 'connectStart', 'connectEnd', 'sslStart', 'sslEnd',
                 'workerStart', 'workerReady', 'sendStart', 'sendEnd',
                 'receiveHeadersEnd'];
  const tRows = tKeys
    .filter((k) => t[k] != null)
    .map((k) => [k, (typeof t[k] === 'number' ? t[k].toFixed(2) + ' ms' : String(t[k]))]);

  reqTabContent.innerHTML = `
    <div class="section-title">Overview</div>
    <table class="kv-table">
      ${rows.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('')}
    </table>
    ${tRows.length ? `
      <div class="section-title">CDP Timing Breakdown</div>
      <table class="kv-table">
        ${tRows.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('')}
      </table>
    ` : ''}
  `;
}

// ── History Logic ──────────────────────────────────────────────────
async function loadHistory() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_REPORTS_INDEX' });
    const container = document.getElementById('historyList');
    const countBadge = document.getElementById('historyCount');
    
    if (!response || !response.ok || !response.reports || !response.reports.length) {
      container.innerHTML = '<div class="empty" style="padding: 12px; color: #6b7280; text-align: center; font-size: 11px;">No previous recordings found.</div>';
      if (countBadge) countBadge.textContent = '0';
      return;
    }

    if (countBadge) countBadge.textContent = response.reports.length;

    container.innerHTML = response.reports.map(function(report) {
      const date = new Date(report.startedAt);
      const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
      
      let scoreColor = '#8b95a5';
      if (report.score >= 80) scoreColor = '#22c55e';
      else if (report.score >= 50) scoreColor = '#f59e0b';
      else if (report.score > 0) scoreColor = '#ef4444';

      // Use the name the user provided, or fallback to 'Untitled Session'
      const displayName = report.name && report.name.trim() ? report.name : 'Untitled Session';

      return `
        <div class="history-item">
          <div class="history-meta">
            <span class="history-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</span>
            <span class="history-date">${dateStr} at ${timeStr} &middot; <span style="color: ${scoreColor}; font-weight: bold;">${report.score || 0} Score</span></span>
          </div>
          <div class="history-actions">
            <button class="btn-hist download btn-dl-hist" data-id="${report.id}">Download</button>
            <button class="btn-hist delete btn-del-hist" data-id="${report.id}">Delete</button>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.btn-dl-hist').forEach(btn => {
      btn.addEventListener('click', () => downloadHistoryReport(btn.dataset.id));
    });
    
    container.querySelectorAll('.btn-del-hist').forEach(btn => {
      btn.addEventListener('click', () => deleteHistoryReport(btn.dataset.id));
    });

  } catch (err) {
    console.error('Failed to load history:', err);
  }
}

async function downloadHistoryReport(id) {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_REPORT_BY_ID', id: id });
    if (!res || !res.ok) {
      addLog('Error: Could not load report data.');
      return;
    }
    const report = res.report;

    // Create a timestamped name
    const date = new Date(report.meta.startedAt || Date.now());
    const ts = date.toISOString().replace(/T/, '_').replace(/\..+/, '').replace(/:/g, '-');
    const baseName = (report.meta.name || 'Session').replace(/[^a-z0-9]/gi, '_');
    report.meta.name = baseName + '_' + ts;

    let health = null;
    let budgetResult = null;
    if (window.PerfHealth) {
      health = window.PerfHealth.computeHealth(report);
      budgetResult = window.PerfHealth.evaluateBudget(report, health, window.PerfHealth.BUDGET_DEFAULTS);
    }

    addLog('Building ZIP for older report...');
    await window.downloadZipReport(report, health, budgetResult);
    addLog('Downloaded: ' + report.meta.name + '.zip');

  } catch (err) {
    addLog('Download error: ' + err.message);
  }
}

async function deleteHistoryReport(id) {
  if (!confirm('Are you sure you want to permanently delete this report?')) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'DELETE_REPORT', id: id });
    if (res.ok) {
      addLog('Report deleted.');
      loadHistory();
    } else {
      addLog('Failed to delete report.');
    }
  } catch (err) {
    console.error(err);
  }
}

// ── Name-prompt modal ──────────────────────────────────────────────
function askForName(defaultVal) {
  return new Promise((resolve) => {
    const modal = document.getElementById('nameModal');
    const input = document.getElementById('nameModalInput');
    const okBtn = document.getElementById('nameModalOk');
    const cancelBtn = document.getElementById('nameModalCancel');
    const backdrop = document.getElementById('nameModalBackdrop');

    if (!modal) { resolve(null); return; }

    input.value = defaultVal || 'perf-report';
    modal.classList.remove('hidden');
    setTimeout(() => { input.focus(); input.select(); }, 30);

    function cleanup() {
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      backdrop.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
    }
    function onOk() {
      const v = input.value.trim();
      cleanup();
      resolve(v || null);
    }
    function onCancel() {
      cleanup();
      resolve(null);
    }
    function onKey(e) {
      if (e.key === 'Enter') onOk();
      else if (e.key === 'Escape') onCancel();
    }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    backdrop.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  });
}

// ── Record button ──────────────────────────────────────────────────
recordBtn.addEventListener('click', async () => {
  const status = await chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATUS' });
  if (status && status.recording) {
    await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
    } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const name = recordingNameInput.value.trim();
    const throttleEl = document.getElementById('throttleSelect');
    const throttle = throttleEl ? throttleEl.value : 'none'; // <--- NEW
    
    const res = await chrome.runtime.sendMessage({
      type: 'START_RECORDING', name: name, tabId: tab.id, throttle: throttle // <--- PASSED HERE
    });
    if (!res || !res.ok) addLog('Error: ' + ((res && res.error) || 'unknown'));
  }
});

// ── Download ZIP ───────────────────────────────────────────────────
downloadZipBtn.addEventListener('click', async () => {
  const status = await chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATUS' });
  if (status && status.recording) {
    addLog('Stop the recording first, then download.');
    return;
  }

  downloadZipBtn.disabled = true;
  downloadZipBtn.textContent = '⏳ Building ZIP… (may take 10–30s)';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_LAST_REPORT' });
    if (!res || !res.ok) throw new Error((res && res.error) || 'No report');
    const report = res.report;

       if (!report.meta.name || !report.meta.name.trim()) {
      const chosen = await askForName('perf-report');
      if (!chosen) {
        downloadZipBtn.disabled = false;
        downloadZipBtn.textContent = '📦 Download Report (.zip)';
        addLog('Download cancelled.');
        return;
      }
      report.meta.name = chosen;
      
      try { 
        // 1. Save to the active report
        await chrome.storage.local.set({ lastReport: report }); 
        
        // 2. Update the History Index so the UI reflects the new name
        const stored = await chrome.storage.local.get('reportsIndex');
        if (stored.reportsIndex) {
          const idx = stored.reportsIndex.findIndex(r => r.id === report.reportId);
          if (idx !== -1) {
            stored.reportsIndex[idx].name = chosen;
            await chrome.storage.local.set({ reportsIndex: stored.reportsIndex });
            loadHistory(); // Refresh the list visually
          }
        }
      } catch (_) {}
    }

    let health = null;
    let budgetResult = null;
    if (window.PerfHealth) {
      health = window.PerfHealth.computeHealth(report);
      budgetResult = window.PerfHealth.evaluateBudget(report, health, window.PerfHealth.BUDGET_DEFAULTS);
    } else {
      console.warn('[Perf-Lens] window.PerfHealth is missing. Health section will be empty.');
    }

    await window.downloadZipReport(report, health, budgetResult);

    addLog('Downloaded: ' + report.meta.name + '.zip');
    downloadZipBtn.textContent = '✅ Downloaded';
    setTimeout(() => {
      downloadZipBtn.textContent = '📦 Download Report (.zip)';
      downloadZipBtn.disabled = false;
    }, 2500);
  } catch (e) {
    console.error(e);
    addLog('ZIP error: ' + e.message);
    downloadZipBtn.textContent = '❌ ' + e.message;
    setTimeout(() => {
      downloadZipBtn.textContent = '📦 Download Report (.zip)';
      downloadZipBtn.disabled = false;
    }, 3000);
  }
});

// ── Init ───────────────────────────────────────────────────────────
connectToServiceWorker();
loadHistory();
chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATUS' }, (res) => {
  if (res && res.recording) {
    applyStatus(true, res.currentRecording);
    startTimer();
  }
});

// Pre-populate network list from last report (so you can inspect offline)
chrome.runtime.sendMessage({ type: 'GET_LIVE_REQUESTS' }, (res) => {
  if (res && res.ok && Array.isArray(res.requests)) {
    requests.clear();
    res.requests.forEach((r) => requests.set(r.id, r));
    renderNetworkList();
  }
});