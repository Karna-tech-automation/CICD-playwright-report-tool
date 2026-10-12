/**
 * Perf-Trace-Pulse — Report Theme
 * ─────────────────────────────────────────────────────────
 * Standalone renderer for the self-contained ZIP report.
 * Edit THIS file to change the report's look, layout, or charts.
 *
 * Public API:
 *   window.ReportTheme.buildSelfContainedHTML(report, health, budget) → string
 *   window.ReportTheme.version
 */

(function () {
  'use strict';

  // ══════════════════════════════════════════════════════════
  //  UTILITIES
  // ══════════════════════════════════════════════════════════
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function formatDuration(ms) {
    if (ms == null || isNaN(ms) || ms <= 0) return '—';
    if (ms < 1000)  return Math.round(ms) + ' ms';
    if (ms < 60000) return (ms / 1000).toFixed(2) + ' s';
    return (ms / 60000).toFixed(2) + ' min';
  }
  function safeDurationMs(r) {
    var d = r.durationMs;
    if (typeof d !== 'number' || !isFinite(d) || d < 0 || d > 3600000) return 0;
    return d;
  }
  function safeRelativeMs(r) {
    var v = r.relativeMs;
    if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > 3600000) return 0;
    return v;
  }
  function shortPath(u) {
    try { var url = new URL(u); return url.pathname.split('/').slice(-2).join('/'); }
    catch (e) { return u; }
  }
  function formatData(data) {
    if (!data) return 'Not captured';
    if (typeof data === 'string') {
      try { return JSON.stringify(JSON.parse(data), null, 2); } catch (e) { return data; }
    }
    return JSON.stringify(data, null, 2);
  }
  function safeFilenameStem(rawName) {
    var name = String(rawName == null ? '' : rawName).trim() || 'recording';
    name = name.replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    return (name || 'recording').slice(0, 60);
  }
  function bytesToKB(b) { return Math.round((b || 0) / 1024); }

  // ══════════════════════════════════════════════════════════
  //  CORRELATION
  // ══════════════════════════════════════════════════════════
  var CORR_WINDOW_MS = 4000;
  var CORR_GRACE_MS  = 200;
  var EPOCH_MIN      = 1e12;

  function verdictFor(ms) {
    if (ms == null) return { label: 'Local',    cls: 'local' };
    if (ms < 200)   return { label: 'Instant',  cls: 'instant' };
    if (ms < 600)   return { label: 'Fast',     cls: 'fast' };
    if (ms < 1500)  return { label: 'Moderate', cls: 'moderate' };
    return                 { label: 'Slow',     cls: 'slow' };
  }
  function actionTargetString(a) {
    return a.targetName
        || (a.target && a.target.displayName)
        || (a.target && a.target.text)
        || (a.target && a.target.selector)
        || a.selector
        || '-';
  }
  function normalizeTimings(report) {
    var candidates = [];
    if (report.meta && typeof report.meta.startedAt === 'number' && report.meta.startedAt > EPOCH_MIN) {
      candidates.push(report.meta.startedAt);
    }
    (report.actions || []).forEach(function (a) {
      if (typeof a.timestamp === 'number' && a.timestamp > EPOCH_MIN) candidates.push(a.timestamp);
    });
    (report.network || []).forEach(function (r) {
      if (typeof r.epoch === 'number' && r.epoch > EPOCH_MIN) candidates.push(r.epoch);
      else if (typeof r.startTime === 'number' && r.startTime > EPOCH_MIN) candidates.push(r.startTime);
    });
    var baseTime = candidates.length ? Math.min.apply(null, candidates) : 0;

    if (baseTime > 0) {
      (report.actions || []).forEach(function (a) {
        if (typeof a.timestamp === 'number' && a.timestamp > EPOCH_MIN) a.relativeMs = a.timestamp - baseTime;
      });
      (report.network || []).forEach(function (r) {
        if (typeof r.epoch === 'number' && r.epoch > EPOCH_MIN) r.relativeMs = r.epoch - baseTime;
        else if (typeof r.startTime === 'number' && r.startTime > EPOCH_MIN) r.relativeMs = r.startTime - baseTime;
      });
    }
    (report.actions || []).forEach(function (a) { a.relativeMs = safeRelativeMs(a); });
    (report.network || []).forEach(function (r) {
      r.relativeMs = safeRelativeMs(r);
      r.durationMs = safeDurationMs(r);
    });
    return baseTime;
  }
  function makeBucketRow(type, label, requests) {
    var settleMs = 0, primary = null, earliest = null;
    requests.forEach(function (r) {
      var rEnd = safeRelativeMs(r) + safeDurationMs(r);
      if (rEnd > settleMs) settleMs = rEnd;
      if (earliest == null || safeRelativeMs(r) < earliest) earliest = safeRelativeMs(r);
      var pEnd = primary ? (safeRelativeMs(primary) + safeDurationMs(primary)) : -Infinity;
      if (!primary || rEnd > pEnd) primary = r;
    });
    return {
      action: { type: type, target: { displayName: label }, relativeMs: earliest == null ? 0 : earliest, duration: settleMs },
      requests: requests.slice().sort(function (a, b) { return safeRelativeMs(a) - safeRelativeMs(b); }),
      settleMs: settleMs, primaryRequest: primary, verdict: verdictFor(settleMs),
      synthetic: true, earliestMs: earliest
    };
  }
  function correlateActions(report) {
    var actions = (report.actions || []).slice().sort(function (a, b) { return safeRelativeMs(a) - safeRelativeMs(b); });
    var requests = (report.network || []).slice();
    if (!requests.length) {
      return actions.map(function (a) {
        return { action: a, requests: [], settleMs: null, primaryRequest: null, verdict: verdictFor(null) };
      });
    }
    var usedIds = {};
    var firstActionTime = actions.length ? safeRelativeMs(actions[0]) : Infinity;
    var preLoad = requests.filter(function (r) { return safeRelativeMs(r) < firstActionTime; });
    preLoad.forEach(function (r) { usedIds[r.id] = true; });

    var slots = actions.map(function (a) {
      return { action: a, requests: [], settleMs: null, primaryRequest: null, verdict: verdictFor(null) };
    });
    requests.forEach(function (r) {
      if (usedIds[r.id]) return;
      var rTime = safeRelativeMs(r);
      var owner = -1;
      for (var i = 0; i < actions.length; i++) {
        if (safeRelativeMs(actions[i]) <= rTime + CORR_GRACE_MS) owner = i;
        else break;
      }
      if (owner < 0) return;
      if (rTime - safeRelativeMs(actions[owner]) > CORR_WINDOW_MS) return;
      slots[owner].requests.push(r);
      usedIds[r.id] = true;
    });
    var orphans = requests.filter(function (r) { return !usedIds[r.id]; });

    slots.forEach(function (c) {
      var tA = safeRelativeMs(c.action);
      var settleMs = null, primary = null;
      c.requests.forEach(function (r) {
        var rEnd = safeRelativeMs(r) + safeDurationMs(r);
        var delta = Math.max(0, rEnd - tA);
        if (settleMs == null || delta > settleMs) settleMs = delta;
        var pEnd = primary ? (safeRelativeMs(primary) + safeDurationMs(primary)) : -Infinity;
        if (!primary || rEnd > pEnd) primary = r;
      });
      c.settleMs = settleMs; c.primaryRequest = primary; c.verdict = verdictFor(settleMs);
    });

    var out = [];
    if (preLoad.length) out.push(makeBucketRow('PAGE_LOAD', 'Initial page load + auto-reload', preLoad));
    out = out.concat(slots);
    if (orphans.length) out.push(makeBucketRow('BACKGROUND', 'Background traffic (polling, keepalive, post-action)', orphans));
    return out;
  }

  // ══════════════════════════════════════════════════════════
  //  SVG CHART BUILDERS
  // ══════════════════════════════════════════════════════════
  function buildWaterfallSVG(report) {
    var net = (report.network || []).slice()
      .filter(function (r) { return safeRelativeMs(r) > 0 || safeDurationMs(r) > 0; })
      .sort(function (a, b) { return safeRelativeMs(a) - safeRelativeMs(b); })
      .slice(0, 15);
    if (!net.length) return '<p class="empty-note">No requests to plot.</p>';

    var maxT = Math.max.apply(null, net.map(function (r) { return (safeRelativeMs(r) + safeDurationMs(r)) / 1000; })) || 1;
    var W = 720, labelW = 160, chartX0 = 170, chartW = 520, rowH = 22, top = 34;
    var H = top + net.length * rowH + 20;

    var h = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" class="chart-waterfall">';
    // grid lines
    for (var i = 0; i <= 4; i++) {
      var gx = chartX0 + (i / 4) * chartW;
      h += '<line x1="' + gx + '" y1="' + top + '" x2="' + gx + '" y2="' + (top + net.length * rowH) + '" stroke="#eef2f7"/>';
      h += '<text x="' + gx + '" y="' + (top - 8) + '" font-size="10" fill="#94a3b8" text-anchor="middle">' + ((i / 4) * maxT).toFixed(1) + 's</text>';
    }
    net.forEach(function (r, i) {
      var startS = safeRelativeMs(r) / 1000;
      var durS = safeDurationMs(r) / 1000;
      var x = chartX0 + (startS / maxT) * chartW;
      var w = Math.max(2, (durS / maxT) * chartW);
      var y = top + i * rowH;
      var color = durS > 1 ? '#dc2626' : durS > 0.5 ? '#ea580c' : '#16a34a';
      var label = (r.method || 'GET') + ' ' + shortPath(r.url).slice(0, 22);
      var tip = (r.method || 'GET') + ' ' + escapeHtml(r.url) + ' — ' + formatDuration(safeDurationMs(r)) + ' (+' + Math.round(safeRelativeMs(r)) + ' ms)';
      h += '<g class="wf-row" data-tip="' + tip + '">';
      h += '<text x="0" y="' + (y + 14) + '" font-size="11" fill="#334155" font-family="ui-monospace,monospace">' + escapeHtml(label) + '</text>';
      h += '<rect x="' + x + '" y="' + (y + 2) + '" width="' + w + '" height="14" rx="3" fill="' + color + '" opacity="0.9"/>';
      h += '</g>';
    });
    h += '</svg>';
    return h;
  }

  function buildDonutSVG(report) {
    var net = report.network || [];
    if (!net.length) return '';
    var counts = { GET: 0, POST: 0, PUT: 0, DELETE: 0, PATCH: 0, OTHER: 0 };
    net.forEach(function (r) {
      var m = (r.method || 'OTHER').toUpperCase();
      if (counts[m] === undefined) counts.OTHER++;
      else counts[m]++;
    });
    var colors = { GET: '#635bff', POST: '#f59e0b', PUT: '#a855f7', DELETE: '#dc2626', PATCH: '#ec4899', OTHER: '#94a3b8' };
    var data = Object.keys(counts)
      .filter(function (k) { return counts[k] > 0; })
      .map(function (k) { return { label: k, value: counts[k], color: colors[k] }; });
    var total = net.length;
    var cx = 80, cy = 80, r = 60, sw = 22, a0 = -Math.PI / 2;
    var h = '<svg viewBox="0 0 160 160" class="chart-donut">';
    data.forEach(function (d) {
      var a1 = a0 + (d.value / total) * Math.PI * 2;
      var large = (a1 - a0) > Math.PI ? 1 : 0;
      var x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
      var x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      var pct = (d.value / total * 100).toFixed(1);
      var tip = d.label + ': ' + d.value + ' requests (' + pct + '%)';
      h += '<path d="M ' + x0 + ' ' + y0 + ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + x1 + ' ' + y1 + '" fill="none" stroke="' + d.color + '" stroke-width="' + sw + '" class="donut-arc" data-tip="' + tip + '"/>';
      a0 = a1;
    });
    h += '</svg>';
    return h;
  }

  function buildDonutLegend(report) {
    var net = report.network || [];
    var counts = {};
    net.forEach(function (r) {
      var m = (r.method || 'OTHER').toUpperCase();
      counts[m] = (counts[m] || 0) + 1;
    });
    var colors = { GET: '#635bff', POST: '#f59e0b', PUT: '#a855f7', DELETE: '#dc2626', PATCH: '#ec4899', OTHER: '#94a3b8' };
    var h = '<div class="legend">';
    Object.keys(counts).sort().forEach(function (k) {
      h += '<div class="row"><span class="dot" style="background:' + (colors[k] || '#94a3b8') + '"></span><span class="lbl">' + escapeHtml(k) + '</span><span class="val">' + counts[k] + '</span></div>';
    });
    h += '</div>';
    return h;
  }

  function buildSparklineSVG(report) {
    var samples = report.memory || [];
    if (samples.length < 2) return '<p class="empty-note">Not enough memory samples.</p>';
    var heap = samples.map(function (s) { return (s.jsHeapUsed || 0) / 1048576; });
    var W = 360, H = 140, pad = 12;
    var max = Math.max.apply(null, heap) * 1.1;
    var min = Math.min.apply(null, heap) * 0.9;
    var pts = heap.map(function (v, i) {
      return [
        pad + (i / (heap.length - 1)) * (W - pad * 2),
        H - pad - ((v - min) / (max - min || 1)) * (H - pad * 2),
        v
      ];
    });
    var line = pts.map(function (p, i) { return (i === 0 ? 'M' : 'L') + p[0] + ' ' + p[1]; }).join(' ');
    var area = line + ' L' + pts[pts.length - 1][0] + ' ' + (H - pad) + ' L' + pts[0][0] + ' ' + (H - pad) + ' Z';
    var h = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart-sparkline">';
    h += '<defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#635bff" stop-opacity=".25"/><stop offset="100%" stop-color="#635bff" stop-opacity="0"/></linearGradient></defs>';
    h += '<path d="' + area + '" fill="url(#sg)"/>';
    h += '<path d="' + line + '" fill="none" stroke="#635bff" stroke-width="2" stroke-linejoin="round"/>';
    pts.forEach(function (p, i) {
      var tip = heap[i].toFixed(1) + ' MB at sample #' + (i + 1);
      h += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="4" fill="#fff" stroke="#635bff" stroke-width="2" class="spark-dot" data-tip="' + tip + '"/>';
    });
    h += '</svg>';
    return h;
  }

  function buildTop5SVG(report) {
    var net = (report.network || []).slice().sort(function (a, b) { return safeDurationMs(b) - safeDurationMs(a); }).slice(0, 5);
    if (!net.length) return '';
    var maxDur = Math.max.apply(null, net.map(safeDurationMs)) || 1;
    var W = 720, labelW = 300, chartW = 340, rowH = 32, top = 20, barH = 20;
    var H = top + net.length * rowH + 10;
    var h = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" class="chart-top5">';
    net.forEach(function (r, i) {
      var y = top + i * rowH;
      var w = (safeDurationMs(r) / maxDur) * chartW;
      var color = safeDurationMs(r) > 1500 ? '#dc2626' : safeDurationMs(r) > 1000 ? '#ea580c' : '#16a34a';
      var label = shortPath(r.url).slice(0, 42);
      var tip = escapeHtml(r.url) + ' — ' + formatDuration(safeDurationMs(r));
      h += '<g class="wf-row" data-tip="' + tip + '">';
      h += '<text x="0" y="' + (y + 15) + '" font-size="11.5" fill="#334155" font-family="ui-monospace,monospace">' + escapeHtml(label) + '</text>';
      h += '<rect x="' + labelW + '" y="' + y + '" width="' + w + '" height="' + barH + '" rx="4" fill="' + color + '" opacity="0.9"/>';
      h += '<text x="' + (labelW + w + 8) + '" y="' + (y + 15) + '" font-size="11.5" fill="#334155" font-family="ui-monospace,monospace">' + formatDuration(safeDurationMs(r)) + '</text>';
      h += '</g>';
    });
    h += '</svg>';
    return h;
  }

  // ══════════════════════════════════════════════════════════
  //  HTML SECTION BUILDERS
  // ══════════════════════════════════════════════════════════
  function buildHeader(report, health) {
    var name = (report.meta && report.meta.name) || 'recording';
    var url = (report.meta && report.meta.url) || 'Unknown URL';
    var startedAt = (report.meta && report.meta.startedAt) || Date.now();
    var durationMs = (report.meta && report.meta.durationMs) || 0;
    var dur = Math.round(durationMs / 1000) + ' s';

    var score = health ? health.score : null;
    var verdict = health ? health.verdictLabel : 'Unknown';
    var vClass = health ? (health.verdictClass || 'average') : 'average';

    // Ring math
    var circumference = 2 * Math.PI * 32;   // r=32
    var pct = Math.max(0, Math.min(100, score == null ? 0 : score));
    var offset = circumference * (1 - pct / 100);
    var ringColor = vClass === 'good' ? '#0e6245' : vClass === 'warn' ? '#b54708' : '#b3261e';

    var h = '<div class="top">';
    h += '<div class="brand">';
    h += '<div class="brand-mark">PTP</div>';
    h += '<div style="min-width:0">';
    h += '<h1>' + escapeHtml(name) + '</h1>';
    h += '<div class="meta">';
    h += '<a href="' + escapeHtml(url) + '" target="_blank">' + escapeHtml(url) + '</a>';
    h += '<span class="dot">·</span>' + new Date(startedAt).toLocaleString();
    h += '<span class="dot">·</span>' + dur;
    h += '<span class="dot">·</span>' + (report.actions || []).length + ' actions';
    h += '<span class="dot">·</span>' + (report.network || []).length + ' requests';
    h += '</div></div></div>';

    h += '<div class="health">';
    h += '<div class="ring">';
    h += '<svg viewBox="0 0 76 76">';
    h += '<circle cx="38" cy="38" r="32" stroke="#e6ebf1" stroke-width="6" fill="none"/>';
    h += '<circle cx="38" cy="38" r="32" stroke="' + ringColor + '" stroke-width="6" fill="none" stroke-dasharray="' + circumference.toFixed(2) + '" stroke-dashoffset="' + offset.toFixed(2) + '" stroke-linecap="round" transform="rotate(-90 38 38)"/>';
    h += '</svg>';
    h += '<div class="ring-num">' + (score == null ? '—' : score) + '</div>';
    h += '</div>';
    h += '<div class="health-text">';
    h += '<div class="lbl">Health Score</div>';
    h += '<div class="badge ' + (vClass === 'good' ? '' : vClass === 'warn' ? 'warn' : 'bad') + '">' + escapeHtml(verdict) + '</div>';
    h += '</div></div></div>';
    return h;
  }

  function buildStatCards(report) {
    var net = report.network || [];
    var con = report.console || [];
    var totalReq = net.length;
    var failed = net.filter(function (r) { return r.failed || (r.status && r.status >= 400); }).length;
    var errors = con.filter(function (c) { return c.level === 'error' || c.level === 'uncaught'; }).length;
    var transfer = net.reduce(function (a, r) { return a + (r.encodedDataLength || 0); }, 0);
    var hosts = {};
    net.forEach(function (r) { try { hosts[new URL(r.url).host] = 1; } catch (e) {} });
    var hostCount = Object.keys(hosts).length;
    var slowest = net.slice().sort(function (a, b) { return safeDurationMs(b) - safeDurationMs(a); })[0];

    var h = '<div class="grid">';
    h += '<div class="panel col-3 stat"><div class="ptitle">Total Requests</div><div class="val">' + totalReq + '</div><div class="sub">' + hostCount + ' unique host' + (hostCount !== 1 ? 's' : '') + '</div></div>';
    h += '<div class="panel col-3 stat"><div class="ptitle">Transfer Size</div><div class="val">' + (transfer < 1048576 ? bytesToKB(transfer) + '<span class="u">KB</span>' : (transfer / 1048576).toFixed(1) + '<span class="u">MB</span>') + '</div><div class="sub">avg ' + (totalReq ? bytesToKB(transfer / totalReq) : 0) + ' KB / request</div></div>';
    h += '<div class="panel col-3 stat ' + (slowest && safeDurationMs(slowest) > 1000 ? 'warn' : '') + '"><div class="ptitle">Slowest Request</div><div class="val">' + (slowest ? (safeDurationMs(slowest) / 1000).toFixed(2) + '<span class="u">s</span>' : '—') + '</div><div class="sub">' + (slowest ? escapeHtml(shortPath(slowest.url)).slice(0, 30) : 'no requests') + '</div></div>';
    h += '<div class="panel col-3 stat ' + (failed || errors ? 'danger' : 'success') + '"><div class="ptitle">Failed / Errors</div><div class="val">' + failed + '<span class="u">/</span>' + errors + '</div><div class="sub">HTTP + console</div></div>';
    h += '</div>';
    return h;
  }

  function buildWebVitalsHTML(report) {
    var s = report.summary || {};
    var vitalsData = report.vitals || [];
    function getVital(name) {
      if (s[name.toLowerCase()] !== undefined && s[name.toLowerCase()] !== null) return s[name.toLowerCase()];
      for (var i = vitalsData.length - 1; i >= 0; i--) if (vitalsData[i].name === name) return vitalsData[i].value;
      return null;
    }
    var vitals = [
      { name: 'LCP',  value: getVital('LCP'),  unit: 'ms', target: 2500 },
      { name: 'FCP',  value: getVital('FCP'),  unit: 'ms', target: 1800 },
      { name: 'CLS',  value: getVital('CLS'),  unit: '',   target: 0.1  },
      { name: 'INP',  value: getVital('INP'),  unit: 'ms', target: 200  },
      { name: 'TTFB', value: getVital('TTFB'), unit: 'ms', target: 800  }
    ];
    var h = '<div class="grid">';
    vitals.forEach(function (v) {
      var isNA = (v.value == null || isNaN(v.value));
      var cls = 'success';
      if (isNA) cls = '';
      else if (v.value > v.target * 1.6) cls = 'danger';
      else if (v.value > v.target) cls = 'warn';
      var val = isNA ? '—' : (Math.round(v.value * 100) / 100) + v.unit;
      h += '<div class="panel col-3 stat ' + cls + '" style="grid-column:span 2.4">';
      h += '<div class="ptitle">' + v.name + '</div>';
      h += '<div class="val">' + val + '</div>';
      h += '<div class="sub">target ≤ ' + v.target + v.unit + '</div>';
      h += '</div>';
    });
    h += '</div>';
    return h;
  }

  function buildActionsHTML(report, baseTime) {
    var actions = report.actions || [];
    var netCount = (report.network || []).length;
    if (!actions.length && !netCount) return '<p class="empty-note">No actions or network requests recorded.</p>';
    var correlated = correlateActions(report);

    var h = '<div class="table-title">Actions &amp; Correlated Requests</div>';
    h += '<table><thead><tr>';
    h += '<th>Time</th><th>Action</th><th>Target</th><th style="text-align:right">Duration</th><th style="text-align:right">Requests</th><th style="text-align:right">Settle</th><th>Verdict</th>';
    h += '</tr></thead><tbody>';

    correlated.forEach(function (c, i) {
      var a = c.action;
      var timeStr = c.synthetic
        ? (a.type === 'PAGE_LOAD' ? '0.0 s' : '+' + (c.earliestMs / 1000).toFixed(1) + ' s')
        : new Date(baseTime + safeRelativeMs(a)).toLocaleTimeString();
      var typeClass = (a.type || 'action').toLowerCase();
      var target = actionTargetString(a);
      var reqCls = c.requests.length ? 'get' : 'local';
      var settle = c.settleMs != null ? formatDuration(c.settleMs) : '—';
      var durTxt = (typeof a.duration === 'number' && a.duration > 0 && a.duration < 3600000) ? formatDuration(a.duration) : '—';

      h += '<tr class="action-row" data-idx="' + i + '">';
      h += '<td class="mono">' + timeStr + '</td>';
      h += '<td><span class="tag ' + typeClass + '">' + escapeHtml((a.type || '').toUpperCase().replace('_', ' ')) + '</span></td>';
      h += '<td class="mono" style="word-break:break-all">' + escapeHtml(String(target).slice(0, 100)) + '</td>';
      h += '<td style="text-align:right" class="num">' + durTxt + '</td>';
      h += '<td style="text-align:right"><span class="tag ' + reqCls + '">' + c.requests.length + '</span></td>';
      h += '<td style="text-align:right" class="num">' + settle + '</td>';
      h += '<td><span class="tag ' + c.verdict.cls + '">' + c.verdict.label + '</span></td>';
      h += '</tr>';

      // Detail row (hidden by default)
      h += '<tr class="action-detail-row" data-for="' + i + '"><td colspan="7">';
      h += '<div class="action-detail-inner">';
      if (!c.requests.length) {
        h += '<div class="settle-summary">No network requests were triggered by this <strong>' + escapeHtml((a.type || 'action').toUpperCase()) + '</strong> action. The UI responded locally.</div>';
      } else {
        h += '<div class="settle-summary">This <strong>' + escapeHtml((a.type || 'action').toUpperCase()) + '</strong> triggered <strong>' + c.requests.length + '</strong> request(s). Network idle at <strong>' + formatDuration(c.settleMs) + '</strong> — classified as <strong>' + c.verdict.label + '</strong>.</div>';
        h += '<div class="req-table">';
        h += '<div class="req-header"><span>Method</span><span>Status</span><span>URL</span><span style="text-align:right">Duration</span><span style="text-align:right">Delay</span></div>';
        c.requests.slice().sort(function (x, y) { return safeRelativeMs(x) - safeRelativeMs(y); }).forEach(function (r) {
          var m = (r.method || 'GET').toUpperCase();
          var statusCls = r.failed ? 'slow' : (r.status >= 400 ? 'slow' : 'ok');
          var statusTxt = r.failed ? 'ERR' : (r.status || '—');
          var delta = Math.max(0, Math.round(safeRelativeMs(r) - safeRelativeMs(a)));
          if (c.synthetic) delta = Math.round(safeRelativeMs(r));
          h += '<div class="req-item">';
          h += '<span class="tag ' + m.toLowerCase() + '">' + escapeHtml(m) + '</span>';
          h += '<span class="tag ' + statusCls + '">' + escapeHtml(String(statusTxt)) + '</span>';
          h += '<span class="url" title="' + escapeHtml(r.url) + '">' + escapeHtml(r.url) + '</span>';
          h += '<span class="duration ' + (safeDurationMs(r) > 1000 ? 'slow' : '') + '">' + formatDuration(safeDurationMs(r)) + '</span>';
          h += '<span class="delta">+' + delta + ' ms</span>';
          h += '</div>';
        });
        h += '</div>';
      }
      h += '</div></td></tr>';
    });
    h += '</tbody></table>';
    return h;
  }

  function buildNetworkHTML(report) {
    var net = report.network || [];
    if (!net.length) return '<p class="empty-note">No network requests recorded.</p>';
    var h = '<div class="table-title">All Requests (Top 50 by duration)</div>';
    h += '<table><thead><tr><th>Time</th><th>Method</th><th>Status</th><th>URL</th><th style="text-align:right">Duration</th><th style="text-align:right">Size</th></tr></thead><tbody>';
    net.slice().sort(function (a, b) { return safeDurationMs(b) - safeDurationMs(a); }).slice(0, 50).forEach(function (n) {
      var statusCls = n.failed ? 'slow' : (n.status >= 400 ? 'slow' : 'ok');
      var statusTxt = n.failed ? 'ERR' : (n.status || '—');
      var durCls = safeDurationMs(n) > 1000 ? 'slow' : '';
      h += '<tr>';
      h += '<td class="mono">' + new Date(n.epoch || Date.now()).toLocaleTimeString() + '</td>';
      h += '<td><span class="tag ' + (n.method || 'get').toLowerCase() + '">' + escapeHtml(n.method || 'GET') + '</span></td>';
      h += '<td><span class="tag ' + statusCls + '">' + escapeHtml(String(statusTxt)) + '</span></td>';
      h += '<td class="mono" style="word-break:break-all"><a href="' + escapeHtml(n.url) + '" target="_blank" style="color:#635bff;text-decoration:none">' + escapeHtml(shortPath(n.url)) + '</a></td>';
      h += '<td style="text-align:right" class="num ' + durCls + '">' + formatDuration(safeDurationMs(n)) + '</td>';
      h += '<td style="text-align:right" class="num">' + bytesToKB(n.encodedDataLength) + ' KB</td>';
      h += '</tr>';
    });
    h += '</tbody></table>';
    return h;
  }

  function buildConsoleHTML(report) {
    var c = report.console || [];
    if (!c.length) return '<p class="empty-note">No console logs recorded.</p>';
    var h = '<div class="table-title">Console Output (' + c.length + ' entries)</div>';
    h += '<table><thead><tr><th>Time</th><th>Level</th><th>Message</th></tr></thead><tbody>';
    c.forEach(function (log) {
      var cls = log.level === 'error' || log.level === 'uncaught' ? 'slow' : (log.level === 'warning' ? 'moderate' : 'ok');
      h += '<tr>';
      h += '<td class="mono">' + new Date(log.timestamp).toLocaleTimeString() + '</td>';
      h += '<td><span class="tag ' + cls + '">' + escapeHtml(log.level) + '</span></td>';
      h += '<td class="mono" style="word-break:break-word">' + escapeHtml((log.message || '').slice(0, 400)) + '</td>';
      h += '</tr>';
    });
    h += '</tbody></table>';
    return h;
  }

  function buildMemoryHTML(report) {
    var m = report.memory || [];
    if (!m.length) return '<p class="empty-note">No memory samples recorded.</p>';
    var h = '<div class="table-title">Memory Samples (last 50)</div>';
    h += '<table><thead><tr><th>Time</th><th style="text-align:right">JS Heap (MB)</th><th style="text-align:right">Nodes</th><th style="text-align:right">Documents</th></tr></thead><tbody>';
    m.slice(-50).forEach(function (s) {
      var heap = (s.jsHeapUsed || 0) / 1048576;
      var cls = heap > 100 ? 'slow' : heap > 50 ? 'moderate' : 'ok';
      h += '<tr>';
      h += '<td class="mono">' + new Date(s.timestamp).toLocaleTimeString() + '</td>';
      h += '<td style="text-align:right" class="num ' + cls + '">' + heap.toFixed(1) + '</td>';
      h += '<td style="text-align:right" class="num">' + (s.nodes || 0).toLocaleString() + '</td>';
      h += '<td style="text-align:right" class="num">' + (s.documents || 0) + '</td>';
      h += '</tr>';
    });
    h += '</tbody></table>';
    return h;
  }

  function buildAttachmentsHTML(report) {
    var shots = report.screenshots || [];
    if (!shots.length) return '<p class="empty-note">No screenshots captured.</p>';
    var h = '<div class="table-title">Screenshots (' + shots.length + ')</div>';
    h += '<div class="screenshots-grid">';
    shots.forEach(function (s, i) {
      h += '<div class="thumb" data-idx="' + i + '" data-src="data:image/jpeg;base64,' + s.data + '">';
      h += '<img src="data:image/jpeg;base64,' + s.data + '" alt="' + escapeHtml(s.label || '') + '" loading="lazy"/>';
      h += '<div class="thumb-info"><div class="thumb-label">' + escapeHtml(s.label || '') + '</div><div class="thumb-time">' + new Date(s.timestamp).toLocaleTimeString() + '</div></div>';
      h += '</div>';
    });
    h += '</div>';
    h += '<div class="lightbox" id="lb"><div class="lb-bar"><span id="lb-title"></span><button id="lb-close">Close</button></div><img id="lb-img" alt=""/></div>';
    return h;
  }

  function buildRawJSONHTML(report) {
    return '<div class="table-title">Full Report JSON</div><pre>' + escapeHtml(JSON.stringify(report, null, 2)) + '</pre>';
  }

  function buildHealthHTML(health) {
    if (!health) return '';
    var h = '<div class="panel" style="grid-column:span 12">';
    h += '<div class="table-title">Risk Factors</div>';
    h += '<div class="risk-grid">';
    (health.factors || []).forEach(function (f) {
      var cls = f.verdict === 'good' ? 'success' : f.verdict === 'warn' ? 'warn' : 'danger';
      h += '<div class="risk-card ' + cls + '">';
      h += '<div class="risk-head"><span class="risk-name">' + escapeHtml(f.name) + '</span><span class="risk-weight">' + escapeHtml(f.weight || '') + '</span></div>';
      h += '<div class="risk-detail">' + escapeHtml(f.detail || '') + '</div>';
      h += '</div>';
    });
    h += '</div>';
    if (health.recommendations && health.recommendations.length) {
      h += '<div class="table-title" style="margin-top:24px">Recommendations</div>';
      h += '<ol class="recommendations">';
      health.recommendations.forEach(function (r) { h += '<li>' + escapeHtml(r) + '</li>'; });
      h += '</ol>';
    }
    h += '</div>';
    return h;
  }

  // ══════════════════════════════════════════════════════════
  //  CSS
  // ══════════════════════════════════════════════════════════
  var CSS = [
    '*{box-sizing:border-box;margin:0;padding:0}',
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f6f8fb;color:#0a2540;padding:32px 24px;line-height:1.5;-webkit-font-smoothing:antialiased;font-size:14px}',
    '.wrap{max-width:1320px;margin:0 auto}',
    // Header
    '.top{display:flex;justify-content:space-between;align-items:center;gap:24px;background:#fff;border:1px solid #e6ebf1;border-radius:16px;padding:22px 26px;margin-bottom:20px;box-shadow:0 1px 2px rgba(10,37,64,.04),0 8px 24px -8px rgba(10,37,64,.06);position:relative;overflow:hidden}',
    '.top::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:linear-gradient(180deg,#635bff,#0ea5e9)}',
    '.brand{display:flex;align-items:center;gap:16px;min-width:0}',
    '.brand-mark{width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,#635bff,#0ea5e9);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;letter-spacing:-.5px;flex-shrink:0;box-shadow:0 6px 14px -4px rgba(99,91,255,.4)}',
    '.brand h1{font-size:21px;font-weight:700;letter-spacing:-.4px;color:#0a2540;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.brand .meta{font-size:12.5px;color:#697386}',
    '.brand .meta a{color:#635bff;text-decoration:none;font-weight:500}',
    '.brand .meta .dot{color:#cbd5e1;margin:0 6px}',
    '.health{display:flex;align-items:center;gap:16px;flex-shrink:0}',
    '.ring{position:relative;width:76px;height:76px}',
    '.ring svg{display:block;width:76px;height:76px}',
    '.ring .ring-num{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:#0a2540;letter-spacing:-.8px;font-variant-numeric:tabular-nums}',
    '.health-text .lbl{font-size:10px;color:#697386;text-transform:uppercase;letter-spacing:1px;font-weight:600;margin-bottom:5px}',
    '.health-text .badge{display:inline-block;padding:3px 11px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.3px;background:#d1f4dd;color:#0e6245}',
    '.health-text .badge.warn{background:#fef3d0;color:#9a5b00}',
    '.health-text .badge.bad{background:#fdd;color:#b3261e}',
    // Grid
    '.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:16px;margin-bottom:20px}',
    '.panel{background:#fff;border:1px solid #e6ebf1;border-radius:12px;padding:18px 20px;box-shadow:0 1px 2px rgba(10,37,64,.04)}',
    '.col-3{grid-column:span 3}.col-4{grid-column:span 4}.col-6{grid-column:span 6}.col-8{grid-column:span 8}.col-12{grid-column:span 12}',
    '.stat{padding:14px 16px;min-height:88px;display:flex;flex-direction:column;justify-content:center;gap:2px}',
    '.stat .ptitle{font-size:10px;color:#697386;text-transform:uppercase;letter-spacing:.8px;font-weight:600;margin-bottom:6px}',
    '.stat .val{font-size:22px;font-weight:700;letter-spacing:-.5px;font-variant-numeric:tabular-nums;color:#0a2540;line-height:1.05}',
    '.stat .val .u{font-size:13px;color:#697386;font-weight:500;margin-left:2px}',
    '.stat .sub{font-size:11px;color:#8b95a5;line-height:1.3}',
    '.stat.danger .val{color:#df1b41}',
    '.stat.warn .val{color:#9a5b00}',
    '.stat.success .val{color:#0e6245}',
    // Panel titles
    '.ptitle{font-size:11px;color:#697386;text-transform:uppercase;letter-spacing:.8px;font-weight:600;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center}',
    // Tables
    '.table-title{font-size:11px;color:#697386;text-transform:uppercase;letter-spacing:.8px;font-weight:600;margin-bottom:12px;padding-top:8px}',
    'table{width:100%;border-collapse:collapse;font-size:13px;background:#fff;border:1px solid #e6ebf1;border-radius:12px;overflow:hidden}',
    'th{text-align:left;padding:10px 12px;font-size:10px;color:#697386;text-transform:uppercase;letter-spacing:.8px;font-weight:600;background:#fafbfc;border-bottom:1px solid #e6ebf1}',
    'td{padding:11px 12px;border-bottom:1px solid #eef2f6;color:#0a2540}',
    'tr:last-child td{border-bottom:none}',
    'tr:hover td{background:#fafbfc}',
    // Tags
    '.tag{display:inline-block;padding:2px 8px;border-radius:5px;font-size:11px;font-weight:600;letter-spacing:.2px}',
    '.tag.get{background:#e0e7ff;color:#3730a3}',
    '.tag.post{background:#fef3c7;color:#92400e}',
    '.tag.put{background:#ede9fe;color:#6d28d9}',
    '.tag.delete{background:#fee2e2;color:#b3261e}',
    '.tag.patch{background:#fce7f3;color:#9d174d}',
    '.tag.ok{background:#d1f4dd;color:#0e6245}',
    '.tag.slow{background:#fee2e2;color:#b3261e}',
    '.tag.moderate{background:#fef3c7;color:#92400e}',
    '.tag.local{background:#f0f3f7;color:#697386}',
    '.tag.instant{background:#e0f2fe;color:#0369a1}',
    '.tag.fast{background:#d1f4dd;color:#0e6245}',
    '.tag.page_load{background:#cffafe;color:#155e75}',
    '.tag.background{background:#e2e8f0;color:#475569}',
    '.tag.focusin,.tag.focusout,.tag.tab,.tag.keydown,.tag.keyup{background:#f1f5f9;color:#475569}',
    '.tag.scroll{background:#ede9fe;color:#6d28d9}',
    '.tag.click,.tag.submit,.tag.dblclick{background:#ffedd5;color:#9a3412}',
    '.tag.change,.tag.input{background:#d1f4dd;color:#0e6245}',
    // Action rows
    '.action-row{cursor:pointer;transition:background .12s}',
    '.action-row:hover td{background:#f0f4fa}',
    '.action-row.open td{background:#eef2ff}',
    '.action-detail-row{display:none}',
    '.action-row.open + .action-detail-row{display:table-row}',
    '.action-detail-row td{padding:0 !important;background:#fafbfc !important;border-bottom:1px solid #e6ebf1}',
    '.action-detail-inner{padding:16px 20px;border-left:3px solid #635bff}',
    '.settle-summary{background:#fff;border:1px solid #e6ebf1;border-radius:8px;padding:12px 16px;font-size:13px;color:#475569;margin-bottom:14px;line-height:1.6}',
    '.settle-summary strong{color:#0a2540;font-weight:700}',
    // Request sub-table
    '.req-table{background:#fff;border:1px solid #e6ebf1;border-radius:8px;overflow:hidden}',
    '.req-header{display:grid;grid-template-columns:80px 90px 1fr 100px 100px;gap:16px;padding:10px 16px;background:#fafbfc;font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:.8px;font-weight:700;border-bottom:1px solid #e6ebf1}',
    '.req-item{display:grid;grid-template-columns:80px 90px 1fr 100px 100px;gap:16px;padding:11px 16px;align-items:center;font-size:12px;border-bottom:1px solid #eef2f6}',
    '.req-item:last-child{border-bottom:none}',
    '.req-item:hover{background:#fafbfc}',
    '.req-item .url{font-family:ui-monospace,monospace;font-size:12px;color:#334155;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.req-item .duration,.req-item .delta{text-align:right;font-variant-numeric:tabular-nums;font-family:ui-monospace,monospace}',
    '.req-item .duration.slow{color:#dc2626;font-weight:700}',
    '.req-item .delta{color:#94a3b8}',
    // Charts
    '.chart-waterfall,.chart-top5{width:100%;height:auto;overflow:visible}',
    '.chart-donut{width:140px;flex-shrink:0}',
    '.chart-sparkline{width:100%;height:auto}',
    '.donut-wrap{display:flex;align-items:center;gap:24px}',
    '.legend{display:flex;flex-direction:column;gap:8px;font-size:12px}',
    '.legend .row{display:flex;align-items:center;gap:8px}',
    '.legend .dot{width:10px;height:10px;border-radius:3px;flex-shrink:0}',
    '.legend .lbl{flex:1;color:#334155}',
    '.legend .val{font-family:ui-monospace,monospace;color:#697386;font-variant-numeric:tabular-nums}',
    '.wf-row{cursor:pointer}',
    '.wf-row:hover rect{filter:brightness(1.15)}',
    '.wf-row:hover text{fill:#635bff;font-weight:600}',
    '.donut-arc{cursor:pointer;transition:opacity .15s}',
    '.donut-arc:hover{opacity:.8}',
    '.spark-dot{cursor:pointer}',
    // Misc
    '.mono{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:12px;color:#334155}',
    '.num{font-variant-numeric:tabular-nums;font-family:ui-monospace,monospace}',
    '.num.slow{color:#dc2626;font-weight:600}',
    '.num.moderate{color:#b54708}',
    '.num.ok{color:#0e6245}',
    '.empty-note{color:#94a3b8;font-style:italic;font-size:12px;padding:8px 0}',
    'pre{background:#fff;border:1px solid #e6ebf1;border-radius:12px;padding:16px;font-size:12px;font-family:ui-monospace,monospace;overflow:auto;max-height:600px;white-space:pre-wrap;word-break:break-all;color:#334155}',
    // Health / risk
    '.risk-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}',
    '.risk-card{background:#fff;border:1px solid #e6ebf1;border-left:4px solid #94a3b8;border-radius:10px;padding:14px 16px}',
    '.risk-card.success{border-left-color:#16a34a}',
    '.risk-card.warn{border-left-color:#ea580c}',
    '.risk-card.danger{border-left-color:#dc2626}',
    '.risk-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:8px}',
    '.risk-name{font-size:13px;font-weight:600;color:#0a2540}',
    '.risk-weight{font-size:9px;font-weight:700;padding:2px 7px;border-radius:3px;background:#f1f5f9;color:#475569;letter-spacing:.4px}',
    '.risk-detail{color:#697386;font-size:12px;line-height:1.5}',
    '.recommendations{background:#fff;border:1px solid #e6ebf1;border-radius:12px;padding:16px 16px 16px 36px}',
    '.recommendations li{color:#0a2540;font-size:13px;padding:6px 0}',
    '.recommendations li::marker{color:#635bff;font-weight:700}',
    // Screenshots
    '.screenshots-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}',
    '.thumb{background:#fff;border:1px solid #e6ebf1;border-radius:10px;overflow:hidden;cursor:zoom-in;transition:transform .12s}',
    '.thumb:hover{border-color:#635bff;transform:translateY(-1px)}',
    '.thumb img{width:100%;aspect-ratio:16/10;object-fit:cover;display:block;background:#000}',
    '.thumb-info{padding:8px 10px;font-size:11px}',
    '.thumb-label{font-weight:600;color:#0a2540;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.thumb-time{color:#94a3b8;font-family:ui-monospace,monospace;font-size:10px;margin-top:2px}',
    // Lightbox
    '.lightbox{display:none;position:fixed;inset:0;background:rgba(15,23,42,.92);z-index:9999;align-items:center;justify-content:center;flex-direction:column}',
    '.lightbox.open{display:flex}',
    '.lightbox img{max-width:90%;max-height:80%;object-fit:contain}',
    '.lb-bar{position:absolute;top:0;left:0;right:0;padding:12px 24px;display:flex;justify-content:space-between;background:rgba(0,0,0,.6);color:#fff}',
    '#lb-close{background:#dc2626;color:#fff;border:none;border-radius:6px;padding:6px 14px;cursor:pointer;font-family:inherit}',
    // Tabs
    '.tabs{display:flex;gap:2px;background:#fff;border:1px solid #e6ebf1;border-radius:12px 12px 0 0;padding:6px;border-bottom:none;margin-bottom:0;overflow-x:auto}',
    '.tab{padding:10px 20px;border:none;background:transparent;font-family:inherit;font-size:13px;font-weight:600;color:#697386;cursor:pointer;border-radius:8px;transition:all .15s;white-space:nowrap}',
    '.tab:hover{background:#f1f5f9;color:#0a2540}',
    '.tab.active{background:#635bff;color:#fff;box-shadow:0 2px 8px -2px rgba(99,91,255,.4)}',
    '.tab .tab-count{background:rgba(0,0,0,.08);padding:1px 7px;border-radius:999px;font-size:11px;font-weight:700;margin-left:6px}',
    '.tab.active .tab-count{background:rgba(255,255,255,.25)}',
    '.tab-panel{background:transparent;border-radius:0 0 12px 12px;padding:20px 0}',
    '.tab-content{display:none}',
    '.tab-content.active{display:block}',
    // Tooltip
    '.tt{position:fixed;pointer-events:none;background:#0a2540;color:#fff;padding:8px 12px;border-radius:8px;font-size:12px;line-height:1.5;box-shadow:0 8px 24px rgba(10,37,64,.2);opacity:0;transition:opacity .12s;z-index:99999;max-width:400px;font-family:ui-monospace,monospace}',
    '.tt.show{opacity:1}',
    // Responsive
    '@media (max-width:1000px){.grid{grid-template-columns:repeat(4,1fr)}.col-3,.col-4,.col-6,.col-8{grid-column:span 2}.col-8,.col-12{grid-column:span 4}}',
    '@media (max-width:640px){body{padding:20px 14px}.top{padding:16px 18px;flex-direction:column;align-items:flex-start}.brand h1{font-size:18px;white-space:normal}.grid{grid-template-columns:repeat(2,1fr);gap:12px}.col-3,.col-4,.col-6,.col-8{grid-column:span 1}.col-8,.col-12{grid-column:span 2}.req-header,.req-item{grid-template-columns:60px 70px 1fr 80px}.req-header > *:last-child,.req-item > *:last-child{display:none}}',
    // Print
    '@media print{body{background:#fff;padding:0;font-size:12px}.tabs{display:none}.tab-content{display:block !important;page-break-inside:avoid;margin-bottom:24px}.tab-content::before{content:attr(data-title);display:block;font-size:14px;font-weight:700;margin-bottom:12px;padding-bottom:8px;border-bottom:2px solid #0a2540}.panel,.top{box-shadow:none}.action-row.open + .action-detail-row{display:table-row}}'
  ].join('');

  // ══════════════════════════════════════════════════════════
  //  MAIN ENTRY
  // ══════════════════════════════════════════════════════════
  function buildSelfContainedHTML(report, health, budgetResult) {
    var baseTime = normalizeTimings(report);
    var netCount = (report.network || []).length;

    var h = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>';
    h += '<title>' + escapeHtml((report.meta && report.meta.name) || 'Perf Trace Report') + ' — Perf-Trace-Pulse</title>';
    h += '<style>' + CSS + '</style></head><body><div class="wrap">';

    // 1. Header with health ring
    h += buildHeader(report, health);

    // 2. Health risk factors + recommendations (top priority for managers)
    h += buildHealthHTML(health);

    // 3. Stat cards
    h += buildStatCards(report);

    // 4. Web Vitals
    if (report.summary && (report.summary.lcp || report.summary.fcp || report.summary.cls)) {
      h += '<div style="margin-bottom:20px"><div class="table-title">Web Vitals</div></div>';
      h += buildWebVitalsHTML(report);
    }

    // 5. Charts row
    if (netCount > 0) {
      h += '<div class="grid">';
      h += '<div class="panel col-8"><div class="ptitle"><span>Network Waterfall</span><span style="font-size:11px;color:#94a3b8;text-transform:none;letter-spacing:0">hover for details</span></div>' + buildWaterfallSVG(report) + '</div>';
      h += '<div class="panel col-4"><div class="ptitle"><span>Requests by Type</span></div><div class="donut-wrap">' + buildDonutSVG(report) + buildDonutLegend(report) + '</div></div>';
      h += '</div>';
      h += '<div class="grid">';
      h += '<div class="panel col-8"><div class="ptitle"><span>Top 5 Slowest Requests</span></div>' + buildTop5SVG(report) + '</div>';
      if ((report.memory || []).length > 2) {
        h += '<div class="panel col-4"><div class="ptitle"><span>JS Heap Over Time</span></div>' + buildSparklineSVG(report) + '</div>';
      }
      h += '</div>';
    }

    // 6. Tabs
    h += '<div class="tabs">';
    h += '<button class="tab active" data-target="tab-actions">Actions <span class="tab-count">' + (report.actions || []).length + '</span></button>';
    h += '<button class="tab" data-target="tab-network">Network <span class="tab-count">' + netCount + '</span></button>';
    h += '<button class="tab" data-target="tab-console">Console <span class="tab-count">' + (report.console || []).length + '</span></button>';
    h += '<button class="tab" data-target="tab-memory">Memory</button>';
    h += '<button class="tab" data-target="tab-attachments">Attachments <span class="tab-count">' + (report.screenshots || []).length + '</span></button>';
    h += '<button class="tab" data-target="tab-json">Raw JSON</button>';
    h += '</div>';

    h += '<div class="tab-panel">';
    h += '<div id="tab-actions" class="tab-content active" data-title="Actions">' + buildActionsHTML(report, baseTime) + '</div>';
    h += '<div id="tab-network" class="tab-content" data-title="Network">' + buildNetworkHTML(report) + '</div>';
    h += '<div id="tab-console" class="tab-content" data-title="Console">' + buildConsoleHTML(report) + '</div>';
    h += '<div id="tab-memory" class="tab-content" data-title="Memory">' + buildMemoryHTML(report) + '</div>';
    h += '<div id="tab-attachments" class="tab-content" data-title="Attachments">' + buildAttachmentsHTML(report) + '</div>';
    h += '<div id="tab-json" class="tab-content" data-title="Raw JSON">' + buildRawJSONHTML(report) + '</div>';
    h += '</div>';

    h += '</div>';

    // Tooltip element
    h += '<div class="tt" id="tt"></div>';

    // ═══ Runtime JS ═══
    h += '<script>(function(){';
    h += 'try{';
    h += 'var tt=document.getElementById("tt");';
    h += 'function showTT(t,x,y){tt.textContent=t;tt.classList.add("show");var r=tt.getBoundingClientRect();tt.style.left=Math.min(x+14,window.innerWidth-r.width-10)+"px";tt.style.top=Math.min(y+14,window.innerHeight-r.height-10)+"px";}';
    h += 'function hideTT(){tt.classList.remove("show");}';
    h += 'document.querySelectorAll("[data-tip]").forEach(function(el){el.addEventListener("mouseenter",function(e){showTT(this.getAttribute("data-tip"),e.clientX,e.clientY);});el.addEventListener("mousemove",function(e){showTT(this.getAttribute("data-tip"),e.clientX,e.clientY);});el.addEventListener("mouseleave",hideTT);});';
    h += 'document.querySelectorAll(".tab").forEach(function(t){t.addEventListener("click",function(){document.querySelectorAll(".tab").forEach(function(x){x.classList.remove("active");});document.querySelectorAll(".tab-content").forEach(function(x){x.classList.remove("active");});this.classList.add("active");var target=document.getElementById(this.dataset.target);if(target)target.classList.add("active");});});';
    h += 'document.querySelectorAll(".action-row").forEach(function(row){row.addEventListener("click",function(){var wasOpen=this.classList.contains("open");document.querySelectorAll(".action-row.open").forEach(function(r){r.classList.remove("open");});if(!wasOpen)this.classList.add("open");});});';
    h += 'var lb=document.getElementById("lb");if(lb){document.querySelectorAll(".thumb").forEach(function(t){t.addEventListener("click",function(){document.getElementById("lb-img").src=this.dataset.src;lb.classList.add("open");});});document.getElementById("lb-close").addEventListener("click",function(){lb.classList.remove("open");});lb.addEventListener("click",function(e){if(e.target===lb)lb.classList.remove("open");});}';
    h += '}catch(e){console.error("Report init error:",e);}';
    h += '})();<\/script>';

    h += '</body></html>';
    return h;
  }

  // ══════════════════════════════════════════════════════════
  //  EXPORT
  // ══════════════════════════════════════════════════════════
  window.ReportTheme = {
    version: '2.0.0',
    buildSelfContainedHTML: buildSelfContainedHTML,
    // Expose helpers for reuse elsewhere
    escapeHtml: escapeHtml,
    formatDuration: formatDuration,
    safeDurationMs: safeDurationMs,
    safeRelativeMs: safeRelativeMs,
    correlateActions: correlateActions,
    verdictFor: verdictFor,
    safeFilenameStem: safeFilenameStem
  };

})();