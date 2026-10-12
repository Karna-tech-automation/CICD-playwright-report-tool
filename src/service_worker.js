/**
 * Perf-Trace-Pulse — Service Worker v1.9.1
 * - Report history (last 20 sessions, LRU)
 * - Performance budgets (persisted)
 * - Sensitive-data redaction at capture time
 * - v1.9.0: explicit Network.getRequestPostData / Network.getResponseBody
 * - v1.9.1: Network.enable({ maxPostDataSize }) so POST bodies are delivered;
 *           live request broadcasts (REQUEST_ADDED / REQUEST_UPDATED /
 *           REQUESTS_CLEARED) and GET_LIVE_REQUESTS / GET_REQUEST_DETAIL
 *           handlers for the panel's network inspector.
 */

importScripts('redaction.js');
importScripts('health.js');

if (!self.PerfRedaction) console.error('[PTP] redaction.js failed to load — sensitive data will NOT be redacted');
if (!self.PerfHealth)    console.error('[PTP] health.js failed to load — history will not store scores');

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

let activeRecording = null;
let memoryInterval = null;

const SCREENSHOT_MIN_GAP_MS = 250;
const MAX_SCREENSHOTS = 500;
const MAX_BODY_BYTES = 100_000;
const MAX_HISTORY = 20;
let lastScreenshotAt = 0;

const panelPorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'perf-trace-panel') return;
  panelPorts.add(port);
  port.onDisconnect.addListener(() => panelPorts.delete(port));
  try {
    port.postMessage({
      type: 'RECORDING_STATUS',
      recording: !!activeRecording,
      currentRecording: activeRecording ? { name: activeRecording.name } : null
    });
  } catch (_) {}
});

function broadcastToPanel(message) {
  for (const p of panelPorts) {
    try { p.postMessage(message); } catch (_) { panelPorts.delete(p); }
  }
}

function uuid(prefix) {
  return prefix + '-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now();
}

// ── Network request summary (for live panel broadcasts) ───────────
function summarizeRequest(r) {
  return {
    id: r.id,
    url: r.url,
    method: r.method,
    status: r.status,
    statusText: r.statusText,
    durationMs: r.durationMs,
    relativeMs: r.relativeMs,
    mimeType: r.mimeType,
    encodedDataLength: r.encodedDataLength,
    failed: r.failed,
    type: r.type
  };
}

// ── Budget storage ────────────────────────────────────────────────
async function getBudget() {
  const stored = await chrome.storage.local.get('budget');
  const base = (self.PerfHealth && self.PerfHealth.BUDGET_DEFAULTS) || {};
  return Object.assign({}, base, stored.budget || {});
}

async function setBudget(partial) {
  const cur = await getBudget();
  const next = Object.assign({}, cur, partial || {});
  await chrome.storage.local.set({ budget: next });
  return next;
}

// ── History storage ───────────────────────────────────────────────
async function saveReportToHistory(report) {
  const health = report.health || null;
  const meta = {
    id: report.reportId,
    name: (report.meta && report.meta.name) || '',
    url: (report.meta && report.meta.url) || 'unknown',
    startedAt: (report.meta && report.meta.startedAt) || Date.now(),
    endedAt: (report.meta && report.meta.endedAt) || Date.now(),
    durationMs: (report.meta && report.meta.durationMs) || 0,
    score: health ? health.score : null,
    verdict: health ? health.verdictLabel : 'UNKNOWN',
    verdictClass: health ? health.verdictClass : 'average',
    counts: health ? health.counts : { critical: 0, high: 0, average: 0 },
    summary: {
      totalActions: (report.summary && report.summary.totalActions) || 0,
      totalRequests: (report.summary && report.summary.totalRequests) || 0,
      failedRequests: (report.summary && report.summary.failedRequests) || 0,
      totalErrors: (report.summary && report.summary.totalErrors) || 0,
      screenshotsCount: (report.summary && report.summary.screenshotsCount) || 0
    }
  };

  const stored = await chrome.storage.local.get('reportsIndex');
  const reportsIndex = stored.reportsIndex || [];
  const nextIndex = [meta].concat(reportsIndex.filter(r => r.id !== meta.id)).slice(0, MAX_HISTORY);

  const snapshot = JSON.parse(JSON.stringify(report));
  snapshot.screenshots = [];
  snapshot.screenshotsStripped = true;

  const key = 'report-' + meta.id;
  let indexSaved = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await chrome.storage.local.set({ [key]: snapshot, reportsIndex: nextIndex });
      indexSaved = true;
      break;
    } catch (e) {
      const oldest = nextIndex[nextIndex.length - 1];
      if (!oldest || oldest.id === meta.id) break;
      try { await chrome.storage.local.remove('report-' + oldest.id); } catch (_) {}
      nextIndex.splice(nextIndex.length - 1, 1);
    }
  }
  if (!indexSaved) {
    console.warn('[PTP] Could not persist report history snapshot (quota).');
    try { await chrome.storage.local.set({ reportsIndex: nextIndex }); } catch (_) {}
  }

  const all = await chrome.storage.local.get(null);
  const validIds = new Set(nextIndex.map(r => r.id));
  const stale = Object.keys(all).filter(k => k.startsWith('report-') && !validIds.has(k.slice(7)));
  if (stale.length) {
    try { await chrome.storage.local.remove(stale); } catch (_) {}
  }
}

// ── Screenshot ────────────────────────────────────────────────────
async function captureScreenshot(tabId, label, meta, force) {
  if (!activeRecording || !tabId) return null;
  if (!force && activeRecording.settleUntil && Date.now() < activeRecording.settleUntil) return null;

  const now = Date.now();
  const important = ['start', 'stop', 'navigate', 'error', 'dialog', 'modal', 'dropdown'].includes(label);
  if (!important && now - lastScreenshotAt < SCREENSHOT_MIN_GAP_MS) return null;
  if (activeRecording.screenshots.length >= MAX_SCREENSHOTS) return null;

  lastScreenshotAt = now;

  try {
    const { data } = await chrome.debugger.sendCommand(
      { tabId }, 'Page.captureScreenshot',
      { format: 'jpeg', quality: 50, fromSurface: true, captureBeyondViewport: false }
    );
    if (!data) return null;

    const idx = activeRecording.screenshots.length;
    const shot = {
      id: 'shot-' + String(idx).padStart(4, '0'),
      label, timestamp: now,
      relativeMs: now - activeRecording.startTime,
      url: activeRecording.url || '',
      duration: (meta && meta.duration) || 0,
      detail: (meta && meta.detail) || '',
      data
    };
    activeRecording.screenshots.push(shot);
    broadcastToPanel({ type: 'SHOT', count: activeRecording.screenshots.length });
    return shot;
  } catch (e) {
    console.warn('Screenshot failed:', e.message);
    return null;
  }
}

function waitForLoad(tabId, timeoutMs) {
  timeoutMs = timeoutMs || 8000;
  return new Promise((resolve) => {
    let done = false;
    const onEvent = (source, method) => {
      if (source.tabId === tabId && method === 'Page.loadEventFired') {
        if (!done) {
          done = true;
          try { chrome.debugger.onEvent.removeListener(onEvent); } catch (_) {}
          resolve(true);
        }
      }
    };
    chrome.debugger.onEvent.addListener(onEvent);
    setTimeout(() => {
      if (!done) {
        done = true;
        try { chrome.debugger.onEvent.removeListener(onEvent); } catch (_) {}
        resolve(false);
      }
    }, timeoutMs);
  });
}

// ── Helper: enable Network with body buffering ─────────────────────
async function enableNetwork(tabId) {
  // maxPostDataSize is what makes Chrome include request.postData on the
  // requestWillBeSent event. Without it, POST bodies are silently omitted.
  try {
    await chrome.debugger.sendCommand(
      { tabId },
      'Network.enable',
      { maxPostDataSize: MAX_BODY_BYTES }
    );
  } catch (_) {
    try { await chrome.debugger.sendCommand({ tabId }, 'Network.enable'); } catch (_) {}
  }
}

// ── Start ────────────────────────────────────────────────────────
async function startRecording(name, tabId) {
  if (activeRecording) throw new Error('Already recording');

  activeRecording = {
    id: uuid('r'), name: name || '',
    startTime: Date.now(), endedAt: null,
    debuggeeTabId: tabId || null, url: null,
    network: { requests: {} }, console: { entries: [] },
    vitals: { events: [] }, actions: { entries: [] },
    memory: { samples: [] }, navigations: [], screenshots: [],
    tabs: [{ tabId, openerTabId: null, createdAt: Date.now(), event: 'root' }],
    settleUntil: Date.now() + 600000
  };

  if (tabId) {
    try { await chrome.debugger.attach({ tabId }, '1.3'); }
    catch (e) { console.warn('Debugger attach failed:', e.message); activeRecording.debuggeeTabId = null; }

    if (activeRecording.debuggeeTabId) {
      for (const d of ['Page', 'Runtime', 'Log', 'Performance']) {
        try { await chrome.debugger.sendCommand({ tabId }, d + '.enable'); } catch (_) {}
      }
      await enableNetwork(tabId);

      try {
        const res = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: '({ url: location.href, viewport: { width: innerWidth, height: innerHeight } })',
          returnByValue: true
        });
        if (res && res.result && res.result.value) {
          activeRecording.url = res.result.value.url;
          activeRecording.viewport = res.result.value.viewport;
        }
      } catch (_) {}

      broadcastToPanel({ type: 'RELOADING' });
      try {
        const loadPromise = waitForLoad(tabId, 6000);
        await chrome.debugger.sendCommand({ tabId }, 'Page.reload', { ignoreCache: false });
        await loadPromise;
        await new Promise((r) => setTimeout(r, 1200));
      } catch (e) { console.warn('Reload failed:', e.message); }

      for (const d of ['Runtime', 'Log']) {
        try { await chrome.debugger.sendCommand({ tabId }, d + '.enable'); } catch (_) {}
      }
      await enableNetwork(tabId);
    }

    try { await chrome.tabs.sendMessage(tabId, { target: 'content', type: 'RECORDING_STARTED' }); } catch (_) {}
    await new Promise((r) => setTimeout(r, 300));

    activeRecording.settleUntil = Date.now() + 2000;
    await captureScreenshot(tabId, 'start', { detail: 'Recording started' }, true);
  }

  startMemorySampling(tabId);
  broadcastToPanel({ type: 'RECORDING_STARTED' });
  return { ok: true };
}

// ── Stop ─────────────────────────────────────────────────────────
async function stopRecording() {
  if (!activeRecording) throw new Error('Not recording');

  if (memoryInterval) { clearInterval(memoryInterval); memoryInterval = null; }
  const tabId = activeRecording.debuggeeTabId;

  if (tabId) await captureScreenshot(tabId, 'stop', { detail: 'Recording stopped' }, true);

  if (tabId) {
    try { await chrome.tabs.sendMessage(tabId, { target: 'content', type: 'RECORDING_STOPPED' }); } catch (_) {}
    await new Promise((r) => setTimeout(r, 400));
  }
  if (tabId) { try { await chrome.debugger.detach({ tabId }); } catch (_) {} }

  activeRecording.endedAt = Date.now();
  const report = buildPerformanceReport(activeRecording);

  if (self.PerfHealth) {
    try { report.health = self.PerfHealth.computeHealth(report); } catch (e) { console.warn('Health failed:', e); }
  }

  await chrome.storage.local.set({ lastReport: report });
  try { await saveReportToHistory(report); } catch (e) { console.warn('History save failed:', e); }

  broadcastToPanel({ type: 'RECORDING_STOPPED' });
  broadcastToPanel({ type: 'REPORT_READY', reportId: report.reportId });
  broadcastToPanel({ type: 'REQUESTS_CLEARED' });
  activeRecording = null;
  return { ok: true, report: report };
}

async function cancelRecording() {
  if (memoryInterval) { clearInterval(memoryInterval); memoryInterval = null; }
  if (activeRecording && activeRecording.debuggeeTabId) {
    try { await chrome.debugger.detach({ tabId: activeRecording.debuggeeTabId }); } catch (_) {}
  }
  activeRecording = null;
  broadcastToPanel({ type: 'RECORDING_STOPPED' });
  broadcastToPanel({ type: 'REQUESTS_CLEARED' });
  return { ok: true };
}

function startMemorySampling(tabId) {
  if (memoryInterval) clearInterval(memoryInterval);
  memoryInterval = setInterval(async () => {
    if (!activeRecording || !tabId) return;
    try {
      const { metrics } = await chrome.debugger.sendCommand({ tabId }, 'Performance.getMetrics');
      const get = (n) => { const m = metrics.find((x) => x.name === n); return m ? m.value : undefined; };
      activeRecording.memory.samples.push({
        timestamp: Date.now(),
        relativeMs: Date.now() - activeRecording.startTime,
        jsHeapUsed: get('JSHeapUsedSize'),
        jsHeapTotal: get('JSHeapTotalSize'),
        nodes: get('Nodes'),
        documents: get('Documents'),
        layoutCount: get('LayoutCount'),
        recalcStyleCount: get('RecalcStyleCount'),
        taskDuration: get('TaskDuration')
      });
    } catch (_) {}
  }, 2000);
}

// ── CDP events ────────────────────────────────────────────────────
chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (!activeRecording) return;
  const tabId = source.tabId;

  switch (method) {
    case 'Network.requestWillBeSent': {
      const req = {
        id: params.requestId,
        url: params.request.url,
        method: params.request.method,
        requestHeaders: params.request.headers,
        postData: params.request.postData,
        hasPostData: params.request.hasPostData === true,
        startTime: params.timestamp * 1000,
        epoch: Date.now(),
        relativeMs: Date.now() - activeRecording.startTime,
        tabId, type: params.type
      };
      if (self.PerfRedaction) self.PerfRedaction.redactRequest(req);
      activeRecording.network.requests[params.requestId] = req;

      // Broadcast to panel
      broadcastToPanel({ type: 'REQUEST_ADDED', request: summarizeRequest(req) });

      // Fallback for body-carrying methods (only when postData wasn't already
      // delivered via the event). hasPostData alone is unreliable — Chrome
      // sets it true for some GETs — so we gate strictly on the method.
      const m = (params.request.method || '').toUpperCase();
      const bodyMethod = m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
      if (bodyMethod && !req.postData) {
        chrome.debugger
          .sendCommand({ tabId }, 'Network.getRequestPostData', { requestId: params.requestId })
          .then((res) => {
            const rec = activeRecording && activeRecording.network.requests[params.requestId];
            if (!rec) return;
            if (res && typeof res.postData === 'string') {
              rec.postData = res.postData.length < MAX_BODY_BYTES
                ? res.postData
                : res.postData.slice(0, MAX_BODY_BYTES) + '\n…[truncated]';
              if (self.PerfRedaction) {
                if (self.PerfRedaction.redactBody) rec.postData = self.PerfRedaction.redactBody(rec.postData);
                else self.PerfRedaction.redactRequest(rec);
              }
            }
          })
          .catch(() => {});
      }
      break;
    }

    case 'Network.responseReceived': {
      const req = activeRecording.network.requests[params.requestId];
      if (req) {
        req.status = params.response.status;
        req.statusText = params.response.statusText;
        req.mimeType = params.response.mimeType;
        req.responseHeaders = params.response.headers;
        req.timing = params.response.timing;
        req.fromCache = params.response.fromDiskCache || params.response.fromServiceWorker;
        req.protocol = params.response.protocol;
        if (self.PerfRedaction) req.responseHeaders = self.PerfRedaction.redactHeaders(req.responseHeaders);

        broadcastToPanel({ type: 'REQUEST_UPDATED', request: summarizeRequest(req) });
      }
      break;
    }

    case 'Network.loadingFinished': {
      const req = activeRecording.network.requests[params.requestId];
      if (req) {
        req.endTime = params.timestamp * 1000;
        req.encodedDataLength = params.encodedDataLength;
        req.durationMs = Math.round(req.endTime - req.startTime);

        const mt = (req.mimeType || '').toLowerCase();
        const isBinary =
          mt.indexOf('image/') === 0 ||
          mt.indexOf('video/') === 0 ||
          mt.indexOf('audio/') === 0 ||
          mt.indexOf('font') !== -1 ||
          mt.indexOf('octet-stream') !== -1 ||
          mt.indexOf('pdf') !== -1 ||
          mt.indexOf('zip') !== -1 ||
          mt.indexOf('gzip') !== -1 ||
          mt.indexOf('wasm') !== -1 ||
          mt.indexOf('protobuf') !== -1 ||
          mt.indexOf('event-stream') !== -1;

        const sizeOk = (params.encodedDataLength || 0) < MAX_BODY_BYTES;

        if (!isBinary && sizeOk) {
          try {
            const body = await chrome.debugger.sendCommand(
              { tabId }, 'Network.getResponseBody', { requestId: params.requestId }
            );
            if (body && typeof body.body === 'string') {
              const base64 = !!body.base64Encoded;
              let raw = body.body;
              if (raw.length > MAX_BODY_BYTES) raw = raw.slice(0, MAX_BODY_BYTES) + '\n…[truncated]';

              if (base64) {
                req.responseBody = '[base64]';
                req.responseBodyBase64 = true;
              } else {
                req.responseBody = raw;
                req.responseBodyBase64 = false;
                if (self.PerfRedaction && self.PerfRedaction.redactBody) {
                  req.responseBody = self.PerfRedaction.redactBody(req.responseBody);
                }
              }
            }
          } catch (_) {}
        }

        broadcastToPanel({ type: 'REQUEST_UPDATED', request: summarizeRequest(req) });
      }
      break;
    }

    case 'Network.loadingFailed': {
      const req = activeRecording.network.requests[params.requestId];
      if (req) { req.failed = true; req.errorText = params.errorText; req.blockedReason = params.blockedReason; }
      activeRecording.console.entries.push({
        id: uuid('c'), level: 'network-error',
        message: 'NETWORK FAILED: ' + params.errorText + ' (' + ((req && req.url) || 'unknown') + ')',
        timestamp: Date.now(), relativeMs: Date.now() - activeRecording.startTime, tabId
      });
      if (req) broadcastToPanel({ type: 'REQUEST_UPDATED', request: summarizeRequest(req) });
      break;
    }

    case 'Runtime.consoleAPICalled': {
      const message = params.args.map((a) => {
        if (a.value !== undefined) return String(a.value);
        if (a.description) return a.description;
        try { return JSON.stringify(a.preview || a); } catch (e) { return '[Unserializable]'; }
      }).join(' ');
      activeRecording.console.entries.push({
        id: uuid('c'), level: params.type, message: message.slice(0, 2000),
        timestamp: Date.now(), relativeMs: Date.now() - activeRecording.startTime, tabId
      });
      break;
    }

    case 'Runtime.exceptionThrown': {
      const d = params.exceptionDetails;
      activeRecording.console.entries.push({
        id: uuid('e'), level: 'uncaught',
        message: (d.exception && d.exception.description) || d.text,
        stack: d.stackTrace && d.stackTrace.callFrames
          ? d.stackTrace.callFrames.map((f) => (f.functionName || '(anon)') + ' @ ' + f.url + ':' + (f.lineNumber + 1) + ':' + f.columnNumber).join('\n')
          : '',
        timestamp: Date.now(), relativeMs: Date.now() - activeRecording.startTime, tabId
      });
      if (tabId) captureScreenshot(tabId, 'error', { detail: 'Uncaught: ' + (d.text || '') });
      break;
    }

    case 'Log.entryAdded': {
      activeRecording.console.entries.push({
        id: uuid('c'), level: params.entry.level, message: params.entry.text,
        source: params.entry.source, timestamp: Date.now(),
        relativeMs: Date.now() - activeRecording.startTime, tabId
      });
      break;
    }

    case 'Page.javascriptDialogOpening': {
      activeRecording.console.entries.push({
        id: uuid('d'), level: 'dialog',
        message: '[' + params.type + '] ' + params.message,
        timestamp: Date.now(), relativeMs: Date.now() - activeRecording.startTime, tabId
      });
      if (tabId) captureScreenshot(tabId, 'dialog', { detail: '[' + params.type + '] ' + (params.message || '').slice(0, 80) });
      break;
    }
  }
});

chrome.debugger.onDetach.addListener(async (source) => {
  if (!activeRecording) return;
  if (source.tabId && source.tabId === activeRecording.debuggeeTabId) {
    setTimeout(async () => {
      try {
        await chrome.debugger.attach({ tabId: source.tabId }, '1.3');
        for (const d of ['Page', 'Runtime', 'Log', 'Performance']) {
          try { await chrome.debugger.sendCommand({ tabId: source.tabId }, d + '.enable'); } catch (_) {}
        }
        await enableNetwork(source.tabId);
      } catch (_) {}
    }, 300);
  }
});

// ── Tab lifecycle ─────────────────────────────────────────────────
chrome.tabs.onCreated.addListener((tab) => {
  if (!activeRecording) return;
  activeRecording.tabs.push({
    tabId: tab.id, openerTabId: tab.openerTabId, createdAt: Date.now(),
    url: tab.pendingUrl || tab.url, event: 'created'
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!activeRecording) return;
  const t = activeRecording.tabs.find((x) => x.tabId === tabId && !x.closedAt);
  if (t) t.closedAt = Date.now();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!activeRecording || tabId !== activeRecording.debuggeeTabId) return;

  if (changeInfo.status === 'loading') {
    activeRecording.navigations.push({
      id: uuid('n'), tabId, url: tab.url, event: 'start',
      timestamp: Date.now(), relativeMs: Date.now() - activeRecording.startTime
    });
    activeRecording.url = tab.url;
  } else if (changeInfo.status === 'complete') {
    activeRecording.url = tab.url;
    activeRecording.navigations.push({
      id: uuid('n'), tabId, url: tab.url, event: 'complete',
      timestamp: Date.now(), relativeMs: Date.now() - activeRecording.startTime
    });

    if (activeRecording.settleUntil && Date.now() < activeRecording.settleUntil) return;

    const tabIdSnap = tabId;
    const urlSnap = tab.url;
    await waitForLoad(tabIdSnap, 5000);
    await new Promise((r) => setTimeout(r, 700));
    if (activeRecording && activeRecording.debuggeeTabId === tabIdSnap) {
      captureScreenshot(tabIdSnap, 'navigate', { detail: 'Navigated to ' + (urlSnap || '').slice(0, 90) });
    }
  }
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (!activeRecording || details.tabId !== activeRecording.debuggeeTabId) return;
  activeRecording.navigations.push({
    id: uuid('n'), tabId: details.tabId, url: details.url,
    transitionType: details.transitionType, event: 'committed',
    timestamp: Date.now(), relativeMs: Date.now() - activeRecording.startTime
  });
});

// ── Messages ──────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'offscreen') return false;
  handleMessage(msg, sender).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'START_RECORDING': return startRecording(msg.name, msg.tabId);
    case 'STOP_RECORDING': return stopRecording();
    case 'CANCEL_RECORDING': return cancelRecording();

    case 'GET_RECORDING_STATUS':
      return { recording: !!activeRecording, currentRecording: activeRecording ? { name: activeRecording.name } : null };

    case 'GET_BUDGET': return { ok: true, budget: await getBudget() };
    case 'SET_BUDGET': return { ok: true, budget: await setBudget(msg.budget) };

    case 'GET_REPORTS_INDEX': {
      const stored = await chrome.storage.local.get('reportsIndex');
      return { ok: true, reports: stored.reportsIndex || [] };
    }
    case 'GET_REPORT_BY_ID': {
      if (!msg.id) return { ok: false, error: 'Missing id' };
      const key = 'report-' + msg.id;
      const stored = await chrome.storage.local.get([key, 'lastReport']);
      if (stored.lastReport && stored.lastReport.reportId === msg.id) {
        return { ok: true, report: stored.lastReport, full: true };
      }
      if (stored[key]) return { ok: true, report: stored[key], full: false };
      return { ok: false, error: 'Report not found' };
    }
    case 'DELETE_REPORT': {
      if (!msg.id) return { ok: false, error: 'Missing id' };
      const stored = await chrome.storage.local.get('reportsIndex');
      const reportsIndex = (stored.reportsIndex || []).filter(r => r.id !== msg.id);
      await chrome.storage.local.set({ reportsIndex });
      try { await chrome.storage.local.remove('report-' + msg.id); } catch (_) {}
      return { ok: true };
    }
    case 'CLEAR_HISTORY': {
      const stored = await chrome.storage.local.get(null);
      const keys = Object.keys(stored).filter(k => k.startsWith('report-'));
      keys.push('reportsIndex');
      try { await chrome.storage.local.remove(keys); } catch (_) {}
      return { ok: true };
    }

    case 'CONTENT_BATCH': {
      if (!activeRecording) return { ok: false };
      if (activeRecording.settleUntil && Date.now() < activeRecording.settleUntil) return { ok: true };

      const { actions, vitals } = msg.payload || { actions: [], vitals: [] };

      if (actions.length > 0 && activeRecording.debuggeeTabId) {
        const interactive = actions.find((a) => ['CLICK','SUBMIT','DBLCLICK','CHANGE','SPA_ROUTE_CHANGE','NAV_BACK'].indexOf(a.type) !== -1);
        if (interactive) {
          const first = interactive;
          const target = (first.target && (first.target.text || first.target.selector)) || '';
          const tabIdSnap = activeRecording.debuggeeTabId;
          const label = 'action-' + first.type.toLowerCase();
          const detail = first.type + ' -> ' + target.slice(0, 70);
          setTimeout(() => {
            if (activeRecording && activeRecording.debuggeeTabId === tabIdSnap) {
              captureScreenshot(tabIdSnap, label, { duration: first.duration || 0, detail });
            }
          }, 500);
        }
      }

      for (let i = 0; i < actions.length; i++) {
        const a = actions[i];
        a.frameUrl = sender.url;
        if (self.PerfRedaction) {
          if (a.url) a.url = self.PerfRedaction.redactUrl(a.url);
          if (a.frameUrl) a.frameUrl = self.PerfRedaction.redactUrl(a.frameUrl);
        }
        activeRecording.actions.entries.push(a);
      }
      for (let i = 0; i < vitals.length; i++) {
        vitals[i].frameUrl = sender.url;
        activeRecording.vitals.events.push(vitals[i]);
      }

      if (activeRecording.actions.entries.length > 10000)
        activeRecording.actions.entries = activeRecording.actions.entries.slice(-10000);
      return { ok: true };
    }

    case 'MUTATION_ALERT': {
      if (!activeRecording || !activeRecording.debuggeeTabId) return { ok: false };
      if (activeRecording.settleUntil && Date.now() < activeRecording.settleUntil) return { ok: true };
      const tabIdSnap = activeRecording.debuggeeTabId;
      const kind = msg.kind || 'change';
      const detail = msg.detail || '';
      setTimeout(() => {
        if (activeRecording && activeRecording.debuggeeTabId === tabIdSnap) {
          captureScreenshot(tabIdSnap, kind, { detail });
        }
      }, 300);
      return { ok: true };
    }

    case 'GET_LIVE_REQUESTS': {
      let list = [];
      if (activeRecording) {
        list = Object.values(activeRecording.network.requests).map(summarizeRequest);
      } else {
        const { lastReport } = await chrome.storage.local.get('lastReport');
        if (lastReport && Array.isArray(lastReport.network)) {
          list = lastReport.network.map(summarizeRequest);
        }
      }
      list.sort((a, b) => (a.relativeMs || 0) - (b.relativeMs || 0));
      return { ok: true, requests: list };
    }

    case 'GET_REQUEST_DETAIL': {
      if (!msg.id) return { ok: false, error: 'Missing id' };
      let req = null;
      if (activeRecording && activeRecording.network.requests[msg.id]) {
        req = activeRecording.network.requests[msg.id];
      } else {
        const { lastReport } = await chrome.storage.local.get('lastReport');
        if (lastReport && Array.isArray(lastReport.network)) {
          req = lastReport.network.find(r => r.id === msg.id) || null;
        }
      }
      if (!req) return { ok: false, error: 'Request not found' };
      return { ok: true, request: req };
    }

    case 'GET_LAST_REPORT': {
      const { lastReport } = await chrome.storage.local.get('lastReport');
      if (!lastReport) return { ok: false, error: 'No report' };
      return { ok: true, report: lastReport };
    }

    case 'GET_LIVE_STATS': {
      if (!activeRecording) return { ok: false };
      return {
        ok: true,
        actions: activeRecording.actions.entries.length,
        requests: Object.keys(activeRecording.network.requests).length,
        errors: activeRecording.console.entries.filter((c) => c.level === 'error' || c.level === 'uncaught').length,
        duration: Date.now() - activeRecording.startTime,
        screenshots: activeRecording.screenshots.length
      };
    }
  }
  return { ok: false, error: 'Unknown message type' };
}

// ── Build report ─────────────────────────────────────────────────
function buildPerformanceReport(s) {
  const requests = Object.values(s.network.requests);
  const failedRequests = requests.filter((r) => r.failed || (r.status && r.status >= 400));
  const errors = s.console.entries.filter((c) => c.level === 'error' || c.level === 'uncaught');

  const vitalsByName = {};
  for (const v of s.vitals.events) {
    if (v.name === 'LCP') vitalsByName.LCP = v.value;
    else if (v.name === 'FCP') vitalsByName.FCP = v.value;
    else if (v.name === 'CLS') vitalsByName.CLS = v.value;
    else if (v.name === 'TTFB') vitalsByName.TTFB = v.value;
    else if (v.name === 'INP_EVENT') vitalsByName.INP = Math.max(vitalsByName.INP || 0, v.value);
  }

  const durations = requests.map((r) => r.durationMs).filter(Boolean).sort((a, b) => a - b);
  const pct = (p) => durations.length ? durations[Math.floor(durations.length * p)] : 0;

  const report = {
    reportId: s.id,
    meta: {
      name: s.name || '',
      url: s.url || (s.tabs[0] && s.tabs[0].url) || 'unknown',
      startedAt: s.startTime, endedAt: s.endedAt,
      durationMs: s.endedAt - s.startTime,
      extensionVersion: '1.9.1'
    },
    summary: {
      totalActions: s.actions.entries.length,
      totalRequests: requests.length,
      failedRequests: failedRequests.length,
      totalTransferBytes: requests.reduce((a, r) => a + (r.encodedDataLength || 0), 0),
      lcp: vitalsByName.LCP, fcp: vitalsByName.FCP, cls: vitalsByName.CLS,
      inp: vitalsByName.INP, ttfb: vitalsByName.TTFB,
      p50: pct(0.5), p90: pct(0.9), p95: pct(0.95), p99: pct(0.99),
      totalErrors: errors.length,
      screenshotsCount: (s.screenshots || []).length
    },
    tabs: s.tabs,
    actions: s.actions.entries,
    network: requests,
    console: s.console.entries,
    navigations: s.navigations,
    webVitals: vitalsByName,
    vitalsEvents: s.vitals.events,
    memory: s.memory.samples,
    screenshots: s.screenshots || []
  };

  if (self.PerfRedaction) {
    const R = self.PerfRedaction;
    if (report.meta && report.meta.url) report.meta.url = R.redactUrl(report.meta.url);
    (report.tabs || []).forEach((t) => { if (t.url) t.url = R.redactUrl(t.url); });
    (report.navigations || []).forEach((n) => { if (n.url) n.url = R.redactUrl(n.url); });
    (report.actions || []).forEach((a) => {
      if (a.url) a.url = R.redactUrl(a.url);
      if (a.frameUrl) a.frameUrl = R.redactUrl(a.frameUrl);
    });
    (report.network || []).forEach((r) => {
      R.redactRequest(r);
      if (r.postData && R.redactBody) r.postData = R.redactBody(r.postData);
      if (r.responseBody && !r.responseBodyBase64 && R.redactBody) r.responseBody = R.redactBody(r.responseBody);
    });
  }

  return report;
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('Perf-Trace-Pulse v1.9.1 installed');
});