/**
 * Perf-Trace-Pulse — reportTheme.js
 * v4.6.0 — no collapse/expand; standard sections
 */
(function (root) {
  'use strict';

  /* ============================ utils ================================== */
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c];
    });
  }
  function formatDuration(ms) {
    if (ms == null || isNaN(ms) || ms <= 0) return '—';
    if (ms < 1000)  return Math.round(ms) + ' ms';
    if (ms < 60000) return (ms / 1000).toFixed(2) + ' s';
    return (ms / 60000).toFixed(2) + ' min';
  }
  function safeDurationMs(r) {
    var d = r && (r.durationMs != null ? r.durationMs : r.time);
    if (typeof d !== 'number' || !isFinite(d) || d < 0 || d > 3600000) return 0;
    return d;
  }
  function shortPath(u) {
    try { var x = new URL(u); return x.pathname.split('/').slice(-2).join('/'); }
    catch (e) { return String(u || ''); }
  }
  function bytesToKB(b) { return Math.round((b || 0) / 1024); }
  function extractHost(url) { try { return new URL(url).host; } catch (e) { return ''; } }
  function extractPath(url) {
    try { var u = new URL(url); return u.pathname + u.search; } catch (e) { return String(url || ''); }
  }

  /* ======================== data transformers ========================== */
  function normaliseTiming(t) {
    if (!t || typeof t !== 'object') return {};
    if (t.dns != null || t.connect != null || t.wait != null) return t;
    var dns     = Math.max(0, (t.dnsEnd     || 0) - (t.dnsStart     || 0));
    var connect = Math.max(0, (t.connectEnd || 0) - (t.connectStart || 0) - dns);
    var ssl     = Math.max(0, (t.sslEnd     || 0) - (t.sslStart     || 0));
    var send    = Math.max(0, (t.sendEnd    || 0) - (t.sendStart    || 0));
    var wait    = Math.max(0, (t.receiveHeadersEnd || 0) - (t.sendEnd || 0));
    var receive = Math.max(0, (t.receiveEnd || 0) - (t.receiveHeadersEnd || 0));
    return { dns: dns, connect: connect, ssl: ssl, send: send, wait: wait, receive: receive };
  }

  function transformNetworkItem(r) {
    var url  = r.url || '';
    var host = r.host || extractHost(url);
    var path = r.path || extractPath(url);
    var name = r.name;
    if (!name) {
      var parts = String(path).split('/').filter(Boolean);
      name = parts.length ? parts[parts.length - 1] : url;
    }
    return {
      name:        name,
      host:        host,
      path:        path,
      method:      String(r.method || 'GET').toUpperCase(),
      status:      r.status,
      statusText:  r.statusText || '',
      type:        r.type || 'other',
      initiator:   r.initiator || 'script',
      size:        r.size || r.encodedDataLength || 0,
      time:        r.time != null ? r.time : (r.durationMs || 0),
      fromCache:   !!r.fromCache,
      remote:      r.remote || '',
      refPolicy:   r.refPolicy || '',
      reqHeaders:  r.reqHeaders  || r.requestHeaders  || {},
      respHeaders: r.respHeaders || r.responseHeaders || {},
      timing:      normaliseTiming(r.timing),
      respBody:    r.respBody    || r.responseBody    || '',
      postData:    r.postData || ''
    };
  }

  function transformScreenshots(shots) {
    return (shots || []).map(function (s, i) {
      return {
        label:  s.label || ('frame-' + (i + 1)),
        detail: s.detail || '',
        time:   s.time || (s.timestamp ? new Date(s.timestamp).toLocaleTimeString() : ''),
        data:   (typeof s.data === 'string' && s.data.length > 0) ? s.data : null,
        url:    s.url || ''
      };
    });
  }

  function transformConsole(con) {
    return (con || []).map(function (c) {
      return {
        level:   c.level || 'log',
        message: c.message || '',
        time:    c.time || (c.timestamp ? new Date(c.timestamp).toLocaleTimeString() : '')
      };
    });
  }

  function sevFromVerdict(v) {
    if (!v) return '';
    v = String(v).toLowerCase();
    if (v === 'bad' || v === 'poor' || v === 'fail') return 'danger';
    if (v === 'warn' || v === 'needs improvement' || v === 'warning') return 'warn';
    if (v === 'good' || v === 'pass') return 'success';
    return '';
  }

  function buildRiskData(health) {
    var out = {};
    if (!health || !Array.isArray(health.factors)) return out;
    health.factors.forEach(function (f) {
      if (!f || !f.id) return;
      if (f.id === 'vitals' && Array.isArray(f.data)) {
        out.vitals = {
          title: f.name || 'Web Vitals',
          table: f.data.map(function (v) {
            return [ v.name, (v.value != null ? v.value : '—') + (v.unit || ''),
                     '≤ ' + v.good + (v.unit || ''), v.verdict || '—' ];
          }),
          severities: f.data.map(function (v) { return sevFromVerdict(v.verdict); })
        };
      } else if (f.id === 'apiSpeed' && Array.isArray(f.data)) {
        out.apiSpeed = {
          title: f.name || 'API Response Time',
          table: f.data.map(function (n) {
            return [ formatDuration(safeDurationMs(n)), n.method || 'GET',
                     n.status || '—', shortPath(n.url || '') ];
          }),
          severities: f.data.map(function (n) {
            var d = safeDurationMs(n);
            if (d >= 2000) return 'danger';
            if (d >= 1000) return 'warn';
            return 'success';
          })
        };
      } else if (f.id === 'failures' && Array.isArray(f.data)) {
        out.failures = {
          title: f.name || 'Network Failures',
          table: f.data.map(function (n) {
            var status = (n.status == null || isNaN(Number(n.status))) ? 'ERR' : String(n.status);
            return [ new Date(n.epoch || Date.now()).toLocaleTimeString(),
                     status, (n.method || 'GET') + ' ' + shortPath(n.url || ''),
                     n.errorText || '—' ];
          }),
          severities: f.data.map(function () { return 'danger'; })
        };
      } else if (f.id === 'console' && Array.isArray(f.data)) {
        out.console = {
          title: f.name || 'Console Errors',
          table: f.data.map(function (c) {
            return [ new Date(c.timestamp || Date.now()).toLocaleTimeString(),
                     c.level || 'log', String(c.message || '').slice(0, 80) ];
          }),
          severities: f.data.map(function (c) {
            var lv = String(c.level || '').toLowerCase();
            if (lv === 'error' || lv === 'uncaught') return 'danger';
            if (lv === 'warning' || lv === 'warn') return 'warn';
            return 'success';
          })
        };
      } else if (f.id === 'memory' && Array.isArray(f.data)) {
        var memRows = f.data.slice(-10);
        out.memory = {
          title: f.name || 'Memory Usage',
          table: memRows.map(function (m) {
            var mb = (m.jsHeapUsed || 0) / 1048576;
            return [ new Date(m.timestamp || Date.now()).toLocaleTimeString(),
                     mb.toFixed(1) + ' MB',
                     (m.nodes || 0).toLocaleString() + ' nodes' ];
          }),
          severities: memRows.map(function (m) {
            var mb = (m.jsHeapUsed || 0) / 1048576;
            if (mb >= 100) return 'danger';
            if (mb >= 50)  return 'warn';
            return 'success';
          })
        };
      } else if (f.id === 'dom' && Array.isArray(f.data)) {
        var domRows = f.data.slice(-10);
        out.dom = {
          title: f.name || 'DOM Complexity',
          table: domRows.map(function (m) {
            return [ new Date(m.timestamp || Date.now()).toLocaleTimeString(),
                     (m.nodes || 0).toLocaleString() + ' nodes',
                     (m.documents || 0) + ' documents' ];
          }),
          severities: domRows.map(function (m) {
            var n = m.nodes || 0;
            if (n >= 5000) return 'danger';
            if (n >= 3000) return 'warn';
            return 'success';
          })
        };
      } else if (f.id === 'longTasks') {
        out.longTasks = {
          title: f.name || 'Long Tasks',
          body: f.detail || 'No long tasks detected (> 200 ms).'
        };
      }
    });
    return out;
  }

  /* ============================== CSS ================================== */
  var CSS = '*{box-sizing:border-box;margin:0;padding:0}' +
    ':root{--bg:#f6f8fb;--surface:#fff;--surface-alt:#fafbfc;--border:#e6ebf1;--border-strong:#d1d9e6;--text:#0a2540;--text-mid:#4a5568;--text-muted:#94a3b8;--brand:#635bff;--brand-soft:#eef2ff;--success:#0e6245;--success-bg:#d1f4dd;--warn:#9a5b00;--warn-bg:#fef3d0;--danger:#b3261e;--danger-bg:#fdd;--info:#155e75;--info-bg:#cffafe;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}' +
    'html,body{max-width:100%;overflow-x:hidden}' +
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.5;font-size:13px;padding:0 24px 40px;-webkit-font-smoothing:antialiased}' +
    '.wrap{max-width:1440px;margin:0 auto}' +
    '.hero{position:relative;margin:0 -24px;overflow:hidden;background:#050f2a;line-height:0}' +
    '.hero-img{display:block;width:100%;height:auto;max-height:420px;object-fit:cover;object-position:center center;user-select:none;pointer-events:none}' +
    '@media (max-width:720px){.hero-img{max-height:260px;object-position:left top}}' +
    '.rpt-header{position:relative;z-index:5;max-width:1300px;margin:-260px auto 130px;display:flex;align-items:center;gap:24px;background:linear-gradient(135deg,#ffffff 0%,#fafbff 55%,#f5f7ff 100%);border:1px solid var(--border);border-radius:16px;padding:24px 28px 24px 32px;box-shadow:0 20px 60px rgba(10,37,64,.16),0 4px 12px rgba(10,37,64,.06);overflow:hidden}' +
    '.rpt-accent{position:absolute;left:0;top:0;bottom:0;width:5px;border-radius:16px 0 0 16px}' +
    '.rpt-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:14px}' +
    '.rpt-id{display:flex;align-items:center;gap:16px;min-width:0}' +
    '.rpt-logo{width:56px;height:56px;border-radius:14px;background:linear-gradient(135deg,#eef1ff,#e0e7ff);display:flex;align-items:center;justify-content:center;flex-shrink:0;border:1px solid #dbe3ff;box-shadow:inset 0 1px 0 rgba(255,255,255,.7),0 2px 6px rgba(99,91,255,.10)}' +
    '.rpt-titles{min-width:0;display:flex;flex-direction:column;gap:6px}' +
    '.rpt-title{font-size:22px;font-weight:800;letter-spacing:-.5px;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text)}' +
    '.rpt-host{display:flex;align-items:center;gap:8px}' +
    '.rpt-host-pill{display:inline-flex;align-items:center;padding:3px 10px;background:#eef2ff;color:#4338ca;border-radius:999px;font-size:11.5px;font-weight:600;font-family:var(--mono);letter-spacing:.2px}' +
    '.rpt-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12.5px;color:var(--text-mid)}' +
    '.rpt-meta-item{display:inline-flex;align-items:baseline;gap:4px}' +
    '.rpt-meta-item b{color:var(--text);font-weight:700;font-variant-numeric:tabular-nums}' +
    '.rpt-meta-sep{color:#cbd5e1}' +
    '.rpt-health{display:flex;align-items:center;gap:16px;flex-shrink:0;padding-left:24px;border-left:1px solid var(--border)}' +
    '.rpt-ring{position:relative;width:72px;height:72px;flex-shrink:0}' +
    '.rpt-ring svg{display:block;width:72px;height:72px}' +
    '.rpt-ring-num{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:800;letter-spacing:-1px;color:var(--text);font-variant-numeric:tabular-nums}' +
    '.rpt-health-meta{display:flex;flex-direction:column;gap:6px;align-items:flex-start}' +
    '.rpt-health-lbl{font-size:9.5px;font-weight:800;color:var(--text-muted);letter-spacing:1.4px;text-transform:uppercase}' +
    '.rpt-health-chip{padding:4px 12px;border-radius:999px;font-size:11px;font-weight:800;letter-spacing:.4px;text-transform:uppercase}' +
    '.exec{background:linear-gradient(135deg,#fef2f2 0%,#fff 60%);border:1px solid #fecaca;border-radius:14px;padding:20px 24px;margin-bottom:16px}' +
    '.exec h2{font-size:15px;font-weight:700;margin-bottom:8px;color:#991b1b;display:flex;align-items:center;gap:8px}' +
    '.exec p{font-size:13.5px;color:var(--text);line-height:1.65}' +
    '.exec p strong{color:#991b1b}' +
    '.perf-overview{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:20px 24px;margin-bottom:16px;box-shadow:0 1px 2px rgba(10,37,64,.04)}' +
    '.perf-overview h2{font-size:15px;font-weight:700;margin-bottom:14px}' +
    '.perf-bar-wrap{position:relative;height:24px;background:#eff3f9;border-radius:6px;overflow:hidden;margin-bottom:10px}' +
    '.perf-bar{height:100%;background:linear-gradient(90deg,#635bff,#0ea5e9);border-radius:6px}' +
    '.perf-pct{position:absolute;right:12px;top:50%;transform:translateY(-50%);font-family:var(--mono);font-size:12px;font-weight:700;color:var(--text)}' +
    '.perf-note{font-size:12px;color:var(--text-mid);line-height:1.5}' +
    '.perf-note strong{color:var(--text)}' +
    '.stats{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-bottom:20px}' +
    '.stat{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;position:relative;overflow:hidden}' +
    '.stat::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:#94a3b8}' +
    '.stat.warn::before{background:#ea580c}.stat.bad::before{background:#dc2626}' +
    '.stat .sl{font-size:10px;color:var(--text-mid);text-transform:uppercase;letter-spacing:.8px;font-weight:700;margin-bottom:6px}' +
    '.stat .sv{font-size:22px;font-weight:700;letter-spacing:-.5px;line-height:1.1;font-variant-numeric:tabular-nums}' +
    '.stat .ss{font-size:11px;color:var(--text-muted);margin-top:3px}' +
    '.vitals{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:20px}' +
    '.vital{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;cursor:pointer;position:relative;overflow:hidden;transition:transform .12s,box-shadow .12s}' +
    '.vital:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(10,37,64,.06)}' +
    '.vital::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:#94a3b8}' +
    '.vital.good::before{background:#16a34a}.vital.warn::before{background:#ea580c}.vital.bad::before{background:#dc2626}' +
    '.vital .vl{font-size:10px;color:var(--text-mid);text-transform:uppercase;letter-spacing:.8px;font-weight:700;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center}' +
    '.vital .vl .chev{font-size:10px;color:var(--text-muted);transition:transform .15s}' +
    '.vital.open .vl .chev{transform:rotate(90deg);color:var(--brand)}' +
    '.vital .vv{font-size:22px;font-weight:700;letter-spacing:-.5px;line-height:1.1;font-variant-numeric:tabular-nums}' +
    '.vital .vmsg{font-size:11px;margin-top:4px;color:var(--text-mid)}' +
    '.vital.good .vmsg{color:#166534}.vital.warn .vmsg{color:#9a3412}.vital.bad .vmsg{color:#991b1b}' +
    '.vital .vdetail{display:none;margin-top:12px;padding-top:12px;border-top:1px dashed var(--border);font-size:12px;color:var(--text-mid);line-height:1.6;cursor:default}' +
    '.vital.open .vdetail{display:block}' +
    '.vital.open{grid-column:span 5;transform:none;box-shadow:none}' +
    '.vital .vdetail .vlrow{display:grid;grid-template-columns:180px 1fr;gap:6px 16px;font-size:12px}' +
    '.vital .vdetail .vlrow .k{color:var(--text-muted);font-weight:500}' +
    '.vital .vdetail .vlrow .v{font-family:var(--mono);font-size:11.5px;color:var(--text);word-break:break-all}' +
    '.risk-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:16px}' +
    '.risk{background:var(--surface);border:1px solid var(--border);border-left:4px solid #94a3b8;border-radius:10px;padding:14px 16px;cursor:pointer;transition:transform .12s,box-shadow .12s}' +
    '.risk:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(10,37,64,.06)}' +
    '.risk.success{border-left-color:#16a34a}.risk.warn{border-left-color:#ea580c}.risk.danger{border-left-color:#dc2626}' +
    '.risk .rh{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:8px}' +
    '.risk .rn{font-size:13px;font-weight:600}' +
    '.risk .rw{font-size:9px;font-weight:700;padding:2px 7px;border-radius:3px;background:#f1f5f9;color:#475569;letter-spacing:.4px}' +
    '.risk.danger .rw{background:var(--danger-bg);color:var(--danger)}' +
    '.risk.warn .rw{background:var(--warn-bg);color:var(--warn)}' +
    '.risk.success .rw{background:var(--success-bg);color:var(--success)}' +
    '.risk .rd{color:var(--text-mid);font-size:12px;line-height:1.5}' +
    '.risk .rh2{margin-top:8px;font-size:10px;color:var(--brand);font-weight:700;letter-spacing:.4px;text-transform:uppercase}' +
    '.risk-drill{margin-top:14px;background:var(--surface-alt);border:1px solid var(--border);border-radius:10px;padding:16px;display:none}' +
    '.risk-drill.open{display:block}' +
    '.risk-drill h3{font-size:13px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center}' +
    '.risk-drill .close{background:#f1f5f9;border:none;padding:4px 12px;border-radius:6px;font-size:11px;cursor:pointer;font-family:inherit;color:var(--text-mid);font-weight:600}' +
    '.risk-drill table{width:100%;border-collapse:collapse;font-size:12px;border-radius:8px;overflow:hidden}' +
    '.risk-drill table td{padding:8px 12px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums}' +
    '.risk-drill table tr:last-child td{border-bottom:none}' +
    '.risk-drill table tr.sev-danger{background:#fef2f2}' +
    '.risk-drill table tr.sev-danger td:first-child{color:#991b1b;font-weight:600;border-left:3px solid #dc2626}' +
    '.risk-drill table tr.sev-warn{background:#fffbeb}' +
    '.risk-drill table tr.sev-warn td:first-child{color:#9a3412;font-weight:600;border-left:3px solid #ea580c}' +
    '.risk-drill table tr.sev-success{background:#f0fdf4}' +
    '.risk-drill table tr.sev-success td:first-child{color:#166534;font-weight:600;border-left:3px solid #16a34a}' +
    '.panel{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px 20px;margin-bottom:20px}' +
    '.section-title{font-size:11px;color:var(--text-mid);text-transform:uppercase;letter-spacing:.8px;font-weight:700;margin:0 0 12px;display:flex;align-items:center;gap:8px}' +
    '.section-title::before{content:"";width:3px;height:12px;background:var(--brand);border-radius:2px}' +
    '.timing-legend{display:flex;gap:20px;flex-wrap:wrap;font-size:11.5px;color:var(--text-mid);margin-bottom:14px;align-items:center}' +
    '.timing-legend .item{display:flex;align-items:center;gap:6px}' +
    '.timing-legend .dot{width:12px;height:12px;border-radius:3px;flex-shrink:0}' +
    '.timing-legend strong{color:var(--text);font-weight:600;margin-right:4px}' +
    '.timing-line{display:flex;align-items:center;gap:14px;padding:8px 0;border-bottom:1px solid var(--border)}' +
    '.timing-line:last-child{border-bottom:none}.timing-line:hover{background:var(--surface-alt)}' +
    '.timing-name{flex:0 0 280px;font-family:var(--mono);font-size:11.5px;color:var(--text-mid);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.timing-line:hover .timing-name{color:var(--brand);font-weight:600}' +
    '.timing-bar-container{flex:1;height:22px;border-radius:4px;overflow:hidden;position:relative;display:flex;min-width:220px;background:#f1f5f9}' +
    '.timing-seg{height:100%;position:relative;transition:filter .12s;cursor:pointer}' +
    '.timing-seg:hover{filter:brightness(1.15)}' +
    '.timing-total{flex:0 0 80px;text-align:right;font-family:var(--mono);font-size:12px;font-weight:600;color:var(--text)}' +
    '.timing-ttfb{flex:0 0 90px;text-align:right;font-family:var(--mono);font-size:11.5px;color:var(--text-muted)}' +
    '.timing-detail{font-family:var(--mono);font-size:11px}' +
    '.timing-detail-row{display:grid;grid-template-columns:150px 1fr 70px;gap:12px;align-items:center;padding:5px 0}' +
    '.timing-detail-row .tdl{color:var(--text-mid);font-family:-apple-system,sans-serif;font-size:11.5px}' +
    '.timing-detail-row .tdb{position:relative;height:16px;background:#f1f5f9;border-radius:3px;overflow:hidden}' +
    '.timing-detail-row .tdv{text-align:right;font-weight:600;color:var(--text)}' +
    '.timing-detail-row .tdb-seg{position:absolute;top:0;height:100%;border-radius:2px;transition:filter .12s;cursor:pointer}' +
    '.timing-detail-row .tdb-seg:hover{filter:brightness(1.15)}' +
    '.chart-tooltip{position:fixed;z-index:99999;background:#0f172a;color:#e2e8f0;padding:10px 14px;border-radius:8px;font-family:var(--mono);font-size:11.5px;line-height:1.5;max-width:520px;pointer-events:none;opacity:0;transition:opacity .12s;box-shadow:0 12px 28px rgba(10,37,64,.28)}' +
    '.chart-tooltip.show{opacity:1}' +
    '.chart-tooltip .tlbl{color:#94a3b8;margin-bottom:3px;font-size:11px;text-transform:uppercase;letter-spacing:.5px}' +
    '.chart-tooltip .tval{font-weight:700;font-size:13px;color:#fff}' +
    '.chart-tooltip .tctx{color:#cbd5e1;font-size:11px;margin-top:5px;line-height:1.4}' +
    '.tabs{display:flex;gap:2px;background:var(--surface);border:1px solid var(--border);border-radius:12px 12px 0 0;padding:6px;border-bottom:none;margin-top:16px;overflow-x:auto}' +
    '.tab{padding:10px 18px;border:none;background:transparent;font-family:inherit;font-size:13px;font-weight:600;color:var(--text-mid);cursor:pointer;border-radius:8px;white-space:nowrap;transition:all .15s}' +
    '.tab:hover{background:#f1f5f9;color:var(--text)}.tab.active{background:var(--brand);color:#fff}' +
    '.tab .cnt{background:rgba(0,0,0,.08);padding:1px 7px;border-radius:999px;font-size:11px;font-weight:700;margin-left:6px}' +
    '.tab.active .cnt{background:rgba(255,255,255,.25)}' +
    '.tab-panel{background:var(--surface);border:1px solid var(--border);border-radius:0 0 12px 12px;padding:20px;border-top:none;box-shadow:0 1px 2px rgba(10,37,64,.04)}' +
    '.tab-content{display:none}.tab-content.active{display:block}' +
    '.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px}' +
    '.search{position:relative;flex:1;min-width:220px;max-width:340px}' +
    '.search input{width:100%;padding:7px 10px 7px 30px;border:1px solid var(--border);border-radius:8px;font-size:12.5px;font-family:inherit;background:var(--surface);color:var(--text);outline:none}' +
    '.search input:focus{border-color:var(--brand);box-shadow:0 0 0 3px rgba(99,91,255,.12)}' +
    '.search::before{content:"";position:absolute;left:10px;top:50%;transform:translateY(-50%);width:12px;height:12px;border:1.5px solid var(--text-muted);border-radius:50%}' +
    '.search::after{content:"";position:absolute;left:19px;top:60%;width:5px;height:1.5px;background:var(--text-muted);transform:rotate(45deg);transform-origin:left}' +
    '.sel{padding:7px 26px 7px 10px;border:1px solid var(--border);border-radius:8px;font-size:12.5px;font-family:inherit;background:var(--surface) url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'10\'><path d=\'M1 3l4 4 4-4\' stroke=\'%2394a3b8\' stroke-width=\'1.5\' fill=\'none\'/></svg>") no-repeat right 8px center;color:var(--text);outline:none;appearance:none;cursor:pointer}' +
    '.stats-strip{display:flex;gap:20px;padding:10px 14px;background:var(--surface-alt);border:1px solid var(--border);border-radius:8px;margin-bottom:12px;font-size:11.5px;color:var(--text-mid);flex-wrap:wrap;align-items:center}' +
    '.stats-strip strong{color:var(--text);font-weight:600;font-variant-numeric:tabular-nums}' +
    '.stats-strip .chip{padding:2px 8px;border-radius:5px;font-size:11px;font-weight:600}' +
    '.stats-strip .chip.err{background:var(--danger-bg);color:var(--danger)}' +
    '.stats-strip .chip.warn{background:var(--warn-bg);color:var(--warn)}' +
    '.stats-strip .chip.ok{background:var(--success-bg);color:var(--success)}' +
    '.net-table{width:100%;max-width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed}' +
    '.net-table thead th{text-align:left;padding:9px 10px;font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.8px;font-weight:700;background:var(--surface-alt);border-bottom:1px solid var(--border);white-space:nowrap;position:sticky;top:0;z-index:2}' +
    '.net-table thead th.sortable{cursor:pointer}' +
    '.net-table thead th .arrow{color:var(--brand);margin-left:4px;font-size:9px}' +
    '.net-table tbody tr.net-row{border-bottom:1px solid var(--border);cursor:pointer;transition:background .1s}' +
    '.net-table tbody tr.net-row:hover{background:var(--surface-alt)}' +
    '.net-table tbody tr.net-row.open{background:var(--brand-soft)}' +
    '.net-table td{padding:8px 10px;vertical-align:middle;overflow:hidden}' +
    '.col-name{width:auto}.col-method{width:72px}.col-status{width:76px}.col-type{width:74px}.col-init{width:92px}.col-size{width:82px;text-align:right}.col-time{width:82px;text-align:right}.col-wf{width:150px}' +
    '.name-cell{display:flex;align-items:center;gap:8px;min-width:0;width:100%}' +
    '.expander{width:14px;height:14px;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:10px;transition:transform .15s}' +
    'tr.net-row.open .expander{transform:rotate(90deg);color:var(--brand)}' +
    '.icon{width:14px;height:14px;flex-shrink:0;border-radius:2px}' +
    '.icon.json,.icon.fetch{background:#fef3c7;border:1px solid #fcd34d}' +
    '.icon.js{background:#fef9c3;border:1px solid #facc15}.icon.css{background:#dbeafe;border:1px solid #93c5fd}' +
    '.icon.html{background:#fee2e2;border:1px solid #fca5a5}.icon.font{background:#f3e8ff;border:1px solid #d8b4fe}' +
    '.icon.img{background:#dcfce7;border:1px solid #86efac}.icon.other{background:#f1f5f9;border:1px solid #cbd5e1}' +
    '.name-text{flex:1;min-width:0;font-family:var(--mono);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.name-host{color:var(--text-muted)}' +
    '.pill{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:5px;font-size:11px;font-weight:600;font-variant-numeric:tabular-nums}' +
    '.pill.ok{background:var(--success-bg);color:var(--success)}.pill.warn{background:var(--warn-bg);color:var(--warn)}.pill.bad{background:var(--danger-bg);color:var(--danger)}' +
    '.pill.method{font-family:var(--mono);font-size:10px;letter-spacing:.4px}' +
    '.pill.method.get{background:#e0e7ff;color:#3730a3}.pill.method.post{background:#fef3c7;color:#92400e}' +
    '.pill.method.put{background:#ede9fe;color:#6d28d9}.pill.method.patch{background:#dbeafe;color:#1e40af}' +
    '.pill.method.delete{background:#fee2e2;color:#b3261e}' +
    '.type-text{color:var(--text-mid);font-size:11px}' +
    '.init-text{color:var(--text-muted);font-size:11px;font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.size-text,.time-text{font-family:var(--mono);font-size:11.5px;color:var(--text-mid);font-variant-numeric:tabular-nums}' +
    '.time-text.slow{color:#b3261e;font-weight:600}.time-text.warn{color:#9a5b00}' +
    '.wf-cell{position:relative;height:20px}' +
    '.wf-bar{position:absolute;height:10px;top:50%;transform:translateY(-50%);border-radius:2px;background:#22c55e;min-width:2px}' +
    '.wf-bar.warn{background:#ea580c}.wf-bar.bad{background:#dc2626}.wf-bar.cached{background:#94a3b8}' +
    '.net-detail{display:none}.net-table tr.net-row.open + tr.net-detail{display:table-row}' +
    '.net-detail td{padding:0 !important;background:var(--surface-alt) !important;border-bottom:2px solid var(--border-strong)}' +
    '.detail-inner{padding:0;border-left:3px solid var(--brand)}' +
    '.detail-tabs{display:flex;gap:2px;padding:0 16px;border-bottom:1px solid var(--border);background:var(--surface);overflow-x:auto}' +
    '.detail-tab{padding:10px 14px;background:transparent;border:none;font-family:inherit;font-size:12px;font-weight:600;color:var(--text-mid);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}' +
    '.detail-tab.active{color:var(--brand);border-bottom-color:var(--brand)}' +
    '.detail-body{padding:14px 20px;background:var(--surface);font-family:var(--mono);font-size:12px;color:var(--text-mid);line-height:1.55}' +
    '.detail-pane{display:none}.detail-pane.active{display:block}' +
    '.d-section{margin-bottom:16px}' +
    '.d-section-title{font-family:-apple-system,sans-serif;font-size:11px;font-weight:700;color:var(--text);text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px;padding-bottom:5px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:6px}' +
    '.d-section-title::before{content:"";width:5px;height:5px;background:var(--brand);border-radius:50%}' +
    '.kv{display:grid;grid-template-columns:180px 1fr;gap:4px 16px;font-size:12px}' +
    '.kv .k{color:var(--text-muted);font-family:-apple-system,sans-serif;font-weight:500;padding:3px 0}' +
    '.kv .v{color:var(--text);font-family:var(--mono);font-size:11.5px;word-break:break-all;padding:3px 0}' +
    '.kv .v .badge{display:inline-block;padding:2px 8px;border-radius:5px;font-size:11px;font-weight:600;background:var(--success-bg);color:var(--success);font-family:-apple-system,sans-serif;margin-left:6px}' +
    '.kv .v .badge.bad{background:var(--danger-bg);color:var(--danger)}.kv .v .badge.info{background:var(--info-bg);color:var(--info)}' +
    'pre.code{background:#0f172a;color:#e2e8f0;padding:14px;border-radius:8px;overflow:auto;max-height:400px;font-family:var(--mono);font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word}' +
    'pre.code .s{color:#86efac}pre.code .n{color:#fbbf24}pre.code .b{color:#c4b5fd}' +
    '.console-row{display:flex;gap:12px;padding:10px 12px;border-bottom:1px solid var(--border);font-size:12px;align-items:flex-start}' +
    '.console-row:last-child{border-bottom:none}' +
    '.console-lvl{flex:0 0 80px}.console-time{flex:0 0 90px;font-family:var(--mono);font-size:11px;color:var(--text-muted)}' +
    '.console-msg{flex:1;font-family:var(--mono);font-size:11.5px;word-break:break-word;line-height:1.5}' +
    '.lvl-error{background:var(--danger-bg);color:var(--danger);padding:2px 8px;border-radius:5px;font-size:10px;font-weight:700;text-transform:uppercase}' +
    '.lvl-warning{background:var(--warn-bg);color:var(--warn);padding:2px 8px;border-radius:5px;font-size:10px;font-weight:700;text-transform:uppercase}' +
    '.lvl-info{background:var(--info-bg);color:var(--info);padding:2px 8px;border-radius:5px;font-size:10px;font-weight:700;text-transform:uppercase}' +
    '.lvl-network{background:#e0e7ff;color:#3730a3;padding:2px 8px;border-radius:5px;font-size:10px;font-weight:700;text-transform:uppercase}' +
    '.player{background:#0a0d12;border:1px solid #1f2632;border-radius:12px;overflow:hidden;margin-bottom:20px}' +
    '.player-stage{position:relative;background:#000;display:flex;align-items:center;justify-content:center;min-height:340px;max-height:65vh;overflow:hidden}' +
    '.player-stage img{max-width:100%;max-height:65vh;display:block}' +
    '.player-overlay{position:absolute;top:12px;left:12px;right:12px;pointer-events:none;display:flex;flex-direction:column;gap:4px}' +
    '.player-label{display:inline-block;align-self:flex-start;background:rgba(99,91,255,.92);color:#fff;font-size:12px;font-weight:600;padding:5px 12px;border-radius:6px;font-family:var(--mono)}' +
    '.player-detail{display:inline-block;align-self:flex-start;background:rgba(10,13,18,.9);color:#e6edf3;font-size:12px;padding:5px 12px;border-radius:6px;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.player-controls{display:flex;align-items:center;gap:8px;padding:12px 14px;background:#12171f;flex-wrap:wrap}' +
    '.player-btn{background:#1f2632;color:#e6edf3;border:none;border-radius:6px;padding:8px 14px;font-size:14px;cursor:pointer;font-family:inherit}' +
    '.player-btn:hover{background:#2a3444}.player-btn-primary{background:#635bff;color:#fff;min-width:52px}' +
    '.player-scrubber{flex:1;min-width:180px;accent-color:#635bff}' +
    '.player-counter{font-family:var(--mono);font-size:12px;color:#8b95a5;min-width:70px;text-align:right}' +
    '.shot-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}' +
    '.shot{background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;cursor:pointer;transition:transform .12s;position:relative}' +
    '.shot:hover{border-color:var(--brand);transform:translateY(-1px)}' +
    '.shot.active{border-color:var(--brand);box-shadow:0 0 0 2px var(--brand-soft)}' +
    '.shot .shot-img{width:100%;aspect-ratio:16/10;display:block;background:linear-gradient(135deg,#f1f5f9,#e2e8f0);position:relative;overflow:hidden}' +
    '.shot .shot-info{padding:8px 10px;font-size:11px}' +
    '.shot .shot-label{font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.shot .shot-time{color:var(--text-muted);font-family:var(--mono);font-size:10px;margin-top:2px}' +
    '.shot .shot-tag{position:absolute;top:6px;left:6px;background:rgba(99,91,255,.92);color:#fff;font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;text-transform:uppercase}' +
    '@media (max-width:1100px){.stats{grid-template-columns:repeat(3,1fr)}.vitals{grid-template-columns:repeat(3,1fr)}.vital.open{grid-column:span 3}.col-wf{display:none}.timing-name{flex:0 0 200px}.timing-ttfb{display:none}}' +
    '@media (max-width:720px){.rpt-header{margin:-40px auto 24px;padding:18px 20px 18px 22px;flex-direction:column;align-items:flex-start;gap:16px}.rpt-title{font-size:16px;white-space:normal}.rpt-main{width:100%}.rpt-health{padding-left:0;border-left:none;padding-top:14px;border-top:1px solid var(--border);width:100%}.rpt-ring,.rpt-ring svg{width:64px;height:64px}.rpt-ring-num{font-size:20px}}' +
    '@media (max-width:640px){body{padding:0 12px 32px}.hero{margin:0 -12px}.stats,.vitals{grid-template-columns:repeat(2,1fr)}.vital.open{grid-column:span 2}.col-init,.col-wf{display:none}.kv{grid-template-columns:1fr}.kv .k{font-weight:700;padding-top:8px}}';

  /* ======================= HTML section builders ======================= */

  function buildHero(report) {
    return '' +
      '<div class="hero">' +
        '<img class="hero-img" src="hero-banner.png" alt="Perf-Trace-Pulse" ' +
          'onerror="this.onerror=null;this.style.display=\'none\';' +
                  'this.parentElement.style.background=\'linear-gradient(135deg,#050f2a,#153a7a)\';' +
                  'this.parentElement.style.minHeight=\'260px\'"/>' +
      '</div>';
  }

  function buildReportHeader(report, health) {
    var meta = report.meta || {};
    var name = meta.name || 'recording';
    var url  = meta.url || '';
    var startedAt  = meta.startedAt || Date.now();
    var durationMs = meta.durationMs || 0;
    var dur = Math.round(durationMs / 1000) + ' s';
    var actions  = (report.actions  || []).length;
    var netCount = (report.network  || []).length;

    var h = health || report.health || null;
    var score   = h && h.score != null ? h.score : null;
    var verdict = (h && h.verdictLabel) || 'Unknown';
    var vClass  = (h && h.verdictClass) || 'average';

    var palettes = {
      healthy:  { ring:'#0e6245', chipBg:'#d1f4dd', chipFg:'#0e6245', accent:'#0e6245' },
      good:     { ring:'#0e6245', chipBg:'#d1f4dd', chipFg:'#0e6245', accent:'#0e6245' },
      average:  { ring:'#b54708', chipBg:'#fef3d0', chipFg:'#9a5b00', accent:'#b54708' },
      warn:     { ring:'#b54708', chipBg:'#fef3d0', chipFg:'#9a5b00', accent:'#b54708' },
      high:     { ring:'#b3261e', chipBg:'#fdd',    chipFg:'#b3261e', accent:'#b3261e' },
      critical: { ring:'#b3261e', chipBg:'#fdd',    chipFg:'#b3261e', accent:'#b3261e' },
      bad:      { ring:'#b3261e', chipBg:'#fdd',    chipFg:'#b3261e', accent:'#b3261e' }
    };
    var p = palettes[vClass] || palettes.average;

    var circ = 2 * Math.PI * 28;
    var pct  = Math.max(0, Math.min(100, score == null ? 0 : score));
    var off  = circ * (1 - pct / 100);

    var host = '';
    try { host = new URL(url).host; } catch (e) { host = url; }

    return '' +
      '<div class="rpt-header">' +
        '<div class="rpt-accent" style="background:linear-gradient(180deg,' + p.accent + ' 0%,var(--brand) 100%)"></div>' +
        '<div class="rpt-main">' +
          '<div class="rpt-id">' +
            '<div class="rpt-logo">' +
              '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" width="28" height="28">' +
                '<path d="M 4 26 L 16 4 L 28 26 L 22 26 L 16 13 L 10 26 Z" fill="#635bff"/>' +
              '</svg>' +
            '</div>' +
            '<div class="rpt-titles">' +
              '<div class="rpt-title">' + escapeHtml(name) + '</div>' +
              '<div class="rpt-host"><span class="rpt-host-pill">' + escapeHtml(host || '—') + '</span></div>' +
            '</div>' +
          '</div>' +
          '<div class="rpt-meta">' +
            '<span class="rpt-meta-item"><b>' + new Date(startedAt).toLocaleString() + '</b></span>' +
            '<span class="rpt-meta-sep">·</span>' +
            '<span class="rpt-meta-item"><b>' + dur + '</b>duration</span>' +
            '<span class="rpt-meta-sep">·</span>' +
            '<span class="rpt-meta-item"><b>' + actions + '</b>actions</span>' +
            '<span class="rpt-meta-sep">·</span>' +
            '<span class="rpt-meta-item"><b>' + netCount + '</b>requests</span>' +
          '</div>' +
        '</div>' +
        '<div class="rpt-health">' +
          '<div class="rpt-ring">' +
            '<svg viewBox="0 0 72 72">' +
              '<circle cx="36" cy="36" r="28" stroke="#eef2f7" stroke-width="7" fill="none"/>' +
              '<circle cx="36" cy="36" r="28" stroke="' + p.ring + '" stroke-width="7" fill="none" ' +
                'stroke-dasharray="' + circ.toFixed(2) + '" stroke-dashoffset="' + off.toFixed(2) + '" ' +
                'stroke-linecap="round" transform="rotate(-90 36 36)"/>' +
            '</svg>' +
            '<div class="rpt-ring-num">' + (score == null ? '—' : score) + '</div>' +
          '</div>' +
          '<div class="rpt-health-meta">' +
            '<div class="rpt-health-lbl">Health Score</div>' +
            '<div class="rpt-health-chip" style="background:' + p.chipBg + ';color:' + p.chipFg + '">' + escapeHtml(verdict) + '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  function buildExecutiveSummary(report) {
    var net = report.network || [];
    if (!net.length) return '';
    var slow3 = net.slice().sort(function (a, b) { return safeDurationMs(b) - safeDurationMs(a); }).slice(0, 3);
    var worst = slow3[0];
    var totalWait = slow3.reduce(function (a, r) { return a + safeDurationMs(r); }, 0);
    var gap = totalWait - 1000;
    var totals = { dns: 0, connect: 0, ssl: 0, send: 0, wait: 0, receive: 0 };
    net.forEach(function (r) {
      var t = normaliseTiming(r.timing);
      totals.dns += t.dns || 0; totals.connect += t.connect || 0;
      totals.ssl += t.ssl || 0; totals.send += t.send || 0;
      totals.wait += t.wait || 0; totals.receive += t.receive || 0;
    });
    var keys = Object.keys(totals);
    var domKey = keys.sort(function (a, b) { return totals[b] - totals[a]; })[0];
    var domSum = keys.reduce(function (a, k) { return a + totals[k]; }, 0) || 1;
    var domPct = Math.round((totals[domKey] / domSum) * 100);
    var stageLabel = { dns:'DNS', connect:'TCP Connect', ssl:'TLS', send:'Request Send', wait:'Server TTFB', receive:'Download' }[domKey] || domKey;
    var owner = { dns:'infra / DNS team', connect:'infra / networking team',
                  ssl:'infra / networking team', send:'client / frontend team',
                  wait:'backend team', receive:'backend or CDN team' }[domKey] || 'unknown';
    var fmtD = function (ms) { return (ms / 1000).toFixed(2) + ' s'; };
    var h = '<div class="exec"><h2>⚠ Executive Summary</h2><p>';
    h += 'The slowest 3 requests consumed <strong>' + fmtD(totalWait) + '</strong> — <strong>' +
         fmtD(gap) + ' above</strong> the B2B enterprise target of 1.00 s. ';
    if (worst) h += 'The single largest cost is <span style="font-family:var(--mono);font-size:12px">' +
                     escapeHtml(shortPath(worst.url || '')) + '</span> at <strong>' +
                     formatDuration(safeDurationMs(worst)) + '</strong>. ';
    h += 'Across all requests, <strong>' + domPct + '%</strong> of time is spent in <strong>' +
         stageLabel + '</strong>, meaning the <strong>' + owner + '</strong> owns this cost.</p></div>';
    return h;
  }

  function buildPerformanceOverview(report) {
    var net = report.network || [];
    if (!net.length) return '';
    var total = net.length;
    var slow = net.filter(function (r) { return safeDurationMs(r) > 1000; }).length;
    var failed = net.filter(function (r) { return r.failed || (r.status && r.status >= 400); }).length;
    var score = 100 - Math.round((slow / total) * 60) - Math.round((failed / total) * 40);
    score = Math.max(5, Math.min(100, score));
    return '<div class="perf-overview"><h2>Performance Overview</h2>' +
      '<div class="perf-bar-wrap"><div class="perf-bar" style="width:' + score + '%"></div>' +
      '<div class="perf-pct">' + score + '%</div></div>' +
      '<div class="perf-note"><strong>Weighted score</strong> across all requests — combines response time, ' +
      'failure rate, and network efficiency. Current score reflects <strong>' + failed + ' failed request' +
      (failed !== 1 ? 's' : '') + '</strong> and <strong>' + slow + ' slow call' +
      (slow !== 1 ? 's' : '') + ' over 1 s</strong>.</div></div>';
  }

  function buildStatsStrip(report) {
    var net = report.network || [];
    var con = report.console || [];
    var totalReq = net.length;
    var slow     = net.filter(function (r) { return safeDurationMs(r) > 1000; }).length;
    var failed   = net.filter(function (r) { return r.failed || (r.status && r.status >= 400); }).length;
    var errors   = con.filter(function (c) { return c.level === 'error' || c.level === 'uncaught'; }).length;
    var transfer = net.reduce(function (a, r) { return a + (r.encodedDataLength || r.size || 0); }, 0);
    var hosts = {};
    net.forEach(function (r) { try { hosts[new URL(r.url).host] = 1; } catch (e) {} });
    var hostCount = Object.keys(hosts).length;
    var slowest = net.slice().sort(function (a, b) { return safeDurationMs(b) - safeDurationMs(a); })[0];
    var sizeStr = transfer < 1048576
      ? bytesToKB(transfer) + '<span style="font-size:13px;color:var(--text-muted);font-weight:500;margin-left:2px">KB</span>'
      : (transfer / 1048576).toFixed(1) + '<span style="font-size:13px;color:var(--text-muted);font-weight:500;margin-left:2px">MB</span>';
    var slowestStr = slowest
      ? (safeDurationMs(slowest) / 1000).toFixed(2) + '<span style="font-size:13px;color:var(--text-muted);font-weight:500;margin-left:2px">s</span>'
      : '—';
    return '<div class="stats">' +
      '<div class="stat"><div class="sl">Total Requests</div><div class="sv">' + totalReq + '</div><div class="ss">' +
        hostCount + ' unique host' + (hostCount !== 1 ? 's' : '') + '</div></div>' +
      '<div class="stat warn"><div class="sl">Slow Requests</div><div class="sv" style="color:#9a5b00">' + slow +
        '</div><div class="ss">&gt; 1 second · ' + (totalReq ? (slow / totalReq * 100).toFixed(1) : 0) + '% of total</div></div>' +
      '<div class="stat bad"><div class="sl">Failed Requests</div><div class="sv" style="color:#b3261e">' + failed +
        '</div><div class="ss">4xx + 5xx</div></div>' +
      '<div class="stat"><div class="sl">Console Errors</div><div class="sv" style="color:#b3261e">' + errors +
        '</div><div class="ss">+ ' + failed + ' network errors</div></div>' +
      '<div class="stat"><div class="sl">Transfer Size</div><div class="sv">' + sizeStr +
        '</div><div class="ss">avg ' + (totalReq ? bytesToKB(transfer / totalReq) : 0) + ' KB / request</div></div>' +
      '<div class="stat bad"><div class="sl">Slowest</div><div class="sv" style="color:#9a5b00">' + slowestStr +
        '</div><div class="ss">' + (slowest ? escapeHtml(shortPath(slowest.url || '').slice(0, 24)) : 'no requests') + '</div></div>' +
      '</div>';
  }

  function buildTimingLinesHTML() {
    return '<div class="panel">' +
      '<div class="section-title">Where the time goes — for the slowest 8 requests</div>' +
      '<div class="timing-legend">' +
        '<div class="item"><span class="dot" style="background:#94a3b8"></span><strong>DNS</strong>Lookup</div>' +
        '<div class="item"><span class="dot" style="background:#60a5fa"></span><strong>TCP</strong>Connect</div>' +
        '<div class="item"><span class="dot" style="background:#a78bfa"></span><strong>TLS</strong>Handshake</div>' +
        '<div class="item"><span class="dot" style="background:#fcd34d"></span><strong>Send</strong>Request</div>' +
        '<div class="item"><span class="dot" style="background:#fb923c"></span><strong>Server</strong>TTFB</div>' +
        '<div class="item"><span class="dot" style="background:#22c55e"></span><strong>Download</strong>Response</div>' +
        '<div class="item" style="margin-left:auto;color:var(--text-muted);font-size:11px">Hover any segment for exact timing</div>' +
      '</div>' +
      '<div id="timingLines"></div>' +
    '</div>';
  }

  function buildWebVitalsHTML(report) {
    var s = report.summary || {};
    var vitalsData = report.vitals || [];
    function getVital(name) {
      var key = name.toLowerCase();
      if (s[key] !== undefined && s[key] !== null) return s[key];
      for (var i = vitalsData.length - 1; i >= 0; i--) {
        if (vitalsData[i].name === name) return vitalsData[i].value;
      }
      return null;
    }
    var defs = [
      { name: 'LCP',  value: getVital('LCP'),  unit: 'ms', target: 2500, context: 'Largest Contentful Paint' },
      { name: 'FCP',  value: getVital('FCP'),  unit: 'ms', target: 1800, context: 'First Contentful Paint' },
      { name: 'CLS',  value: getVital('CLS'),  unit: '',   target: 0.1,  context: 'Cumulative Layout Shift' },
      { name: 'INP',  value: getVital('INP'),  unit: 'ms', target: 200,  context: 'Interaction to Next Paint' },
      { name: 'TTFB', value: getVital('TTFB'), unit: 'ms', target: 800,  context: 'Time to First Byte' }
    ];
    var h = '<div class="section-title">Web Vitals — click any card for details</div><div class="vitals" id="vitals">';
    defs.forEach(function (v) {
      var isNA = (v.value == null || isNaN(v.value));
      var cls = 'good';
      if (isNA) cls = '';
      else if (v.value > v.target * 1.6) cls = 'bad';
      else if (v.value > v.target) cls = 'warn';
      var val = isNA ? '—' : (Math.round(v.value * 100) / 100) + v.unit;
      var verdict = isNA ? 'N/A' : cls === 'good' ? 'Good' : cls === 'warn' ? 'Needs improvement' : 'Poor';
      var vc = cls === 'good' ? '#0e6245' : cls === 'warn' ? '#9a5b00' : '#b3261e';
      h += '<div class="vital ' + cls + '">' +
        '<div class="vl"><span>' + v.name + '</span><span class="chev">▶</span></div>' +
        '<div class="vv">' + val + '</div>' +
        '<div class="vmsg">' + verdict + '</div>' +
        '<div class="vdetail">' +
          '<div class="vlrow"><span class="k">Target</span><span class="v">≤ ' + v.target + v.unit + '</span></div>' +
          '<div class="vlrow"><span class="k">What it measures</span><span class="v">' + escapeHtml(v.context) + '</span></div>' +
          '<div class="vlrow"><span class="k">Verdict</span><span class="v" style="color:' + vc + '">' + verdict + '</span></div>' +
        '</div></div>';
    });
    h += '</div>';
    return h;
  }

  function buildRiskGridHTML(health) {
    if (!health || !Array.isArray(health.factors) || !health.factors.length) return '';
    var h = '<div class="section-title" style="margin-top:20px">Risk Factors — click a card to drill down</div><div class="risk-grid">';
    health.factors.forEach(function (f) {
      var cls = f.verdict === 'good' ? 'success' : f.verdict === 'warn' ? 'warn' : 'danger';
      var hasData = Array.isArray(f.data) && f.data.length > 0;
      h += '<div class="risk ' + cls + '" data-risk="' + escapeHtml(f.id) + '">' +
        '<div class="rh"><span class="rn">' + escapeHtml(f.name || '') + '</span>' +
        '<span class="rw">' + escapeHtml(String(f.weight || '').toUpperCase()) + '</span></div>' +
        '<div class="rd">' + escapeHtml(f.detail || '') + '</div>' +
        (hasData ? '<div class="rh2">Click to see details</div>' : '') +
        '</div>';
    });
    h += '</div>' +
      '<div class="risk-drill" id="riskDrill"><h3><span id="riskDrillTitle">—</span>' +
      '<button class="close" id="riskDrillClose">Close</button></h3><div id="riskDrillBody"></div></div>';
    return h;
  }

  function buildTabsHTML(report) {
    var netCount = (report.network     || []).length;
    var attCount = (report.screenshots || []).length;
    var conCount = (report.console     || []).length;
    return '<div class="tabs">' +
      '<button class="tab active" data-tab="network">Network <span class="cnt" id="tabNetCount">' + netCount + '</span></button>' +
      '<button class="tab" data-tab="attachments">Attachments <span class="cnt" id="tabAttCount">' + attCount + '</span></button>' +
      '<button class="tab" data-tab="console">Console <span class="cnt" id="tabConCount">' + conCount + '</span></button>' +
      '<button class="tab" data-tab="raw">Raw JSON</button></div>';
  }

  function buildTabPanelHTML() {
    var h = '<div class="tab-panel">';
    h += '<div id="tab-network" class="tab-content active">' +
      '<div class="toolbar">' +
        '<div class="search"><input type="text" id="searchInput" placeholder="Filter by host, path, method, status"/></div>' +
        '<select class="sel" id="methodFilter"><option value="">All methods</option><option value="GET">GET</option><option value="POST">POST</option><option value="PUT">PUT</option><option value="PATCH">PATCH</option><option value="DELETE">DELETE</option></select>' +
        '<select class="sel" id="typeFilter"><option value="">All types</option><option value="fetch">fetch / json</option><option value="js">js</option><option value="css">css</option><option value="html">html</option><option value="img">img</option><option value="font">font</option></select>' +
        '<select class="sel" id="statusFilter"><option value="">All statuses</option><option value="2xx">2xx Success</option><option value="3xx">3xx Redirect</option><option value="4xx">4xx Client Error</option><option value="5xx">5xx Server Error</option><option value="err">4xx + 5xx (all failures)</option></select>' +
      '</div>' +
      '<div class="stats-strip">' +
        '<span><strong id="statVisible">0</strong> shown</span>' +
        '<span><span class="chip ok" id="chip2xx">0 · 2xx</span></span>' +
        '<span><span class="chip warn" id="chip3xx">0 · 3xx</span></span>' +
        '<span><span class="chip err" id="chip4xx">0 · 4xx</span></span>' +
        '<span><span class="chip err" id="chip5xx">0 · 5xx</span></span>' +
        '<span style="margin-left:auto"><strong id="statSlow">0</strong> slow &gt; 1 s</span>' +
      '</div>' +
      '<table class="net-table" id="netTable"><thead><tr>' +
        '<th class="col-name sortable" data-sort="name">Name <span class="arrow" data-arrow="name"></span></th>' +
        '<th class="col-method sortable" data-sort="method">Method</th>' +
        '<th class="col-status sortable" data-sort="status">Status</th>' +
        '<th class="col-type sortable" data-sort="type">Type</th>' +
        '<th class="col-init sortable" data-sort="initiator">Initiator</th>' +
        '<th class="col-size sortable" data-sort="size">Size</th>' +
        '<th class="col-time sortable" data-sort="time">Time</th>' +
        '<th class="col-wf">Waterfall</th>' +
      '</tr></thead><tbody id="netBody"></tbody></table></div>';
    h += '<div id="tab-attachments" class="tab-content">' +
      '<div class="section-title">Frame-by-frame Player</div>' +
      '<div class="player">' +
        '<div class="player-stage"><img class="player-img" alt="frame"/>' +
        '<div class="player-overlay"><div class="player-label">frame 1</div>' +
        '<div class="player-detail">Recording started</div></div></div>' +
        '<div class="player-controls">' +
          '<button class="player-btn player-prev" type="button">⏪</button>' +
          '<button class="player-btn player-btn-primary player-play" type="button">▶</button>' +
          '<button class="player-btn player-next" type="button">⏩</button>' +
          '<input class="player-scrubber" type="range" min="0" max="4" value="0" step="1"/>' +
          '<span class="player-counter">1 / 5</span>' +
        '</div>' +
      '</div>' +
      '<div class="section-title" style="margin-top:20px">All Screenshots</div>' +
      '<div class="shot-grid" id="shotGrid"></div></div>';
    h += '<div id="tab-console" class="tab-content">' +
      '<div class="section-title">Console Output + Network Failures</div>' +
      '<div id="consoleList"></div></div>';
    h += '<div id="tab-raw" class="tab-content">' +
      '<div class="section-title">Full Report JSON</div>' +
      '<pre class="code" id="rawJson">Loading…</pre></div>';
    h += '</div>';
    return h;
  }

  /* ============================ RUNTIME ================================ */
  function Runtime(payload) {
    var DATA        = payload.network    || [];
    var SCREENSHOTS = payload.screenshots || [];
    var CONSOLE     = payload.console    || [];
    var RISK_DATA   = payload.riskData   || {};

    var TIMING_COLORS = { dns:'#94a3b8', connect:'#60a5fa', ssl:'#a78bfa', send:'#fcd34d', wait:'#fb923c', receive:'#22c55e' };

    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c];
      });
    }
    function fmtSize(b) { if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'; return (b / 1048576).toFixed(2) + ' MB'; }
    function fmtTime(ms) { if (ms < 1000) return ms + ' ms'; return (ms / 1000).toFixed(2) + ' s'; }
    function statusClass(s) {
      var n = Number(s);
      if (!isFinite(n) || n >= 400) return 'bad';
      if (n >= 300) return 'warn';
      return 'ok';
    }
    function statusText(s) {
      if (s == null || s === '' || isNaN(Number(s))) return 'ERR';
      return String(s);
    }
    function iconClass(t) { var m = { json:'json', fetch:'fetch', js:'js', css:'css', html:'html', font:'font', img:'img' }; return m[t] || 'other'; }
    function timeClass(ms, cached) { if (cached) return ''; if (ms > 1000) return 'slow'; if (ms > 500) return 'warn'; return ''; }
    function wfClass(ms, cached) { if (cached) return 'cached'; if (ms > 1000) return 'bad'; if (ms > 500) return 'warn'; return ''; }
    function highlight(s) {
      s = esc(s);
      s = s.replace(/("(?:[^"\\]|\\.)*")/g, '<span class="s">$1</span>');
      s = s.replace(/\b(true|false|null)\b/g, '<span class="b">$1</span>');
      s = s.replace(/\b(-?\d+(?:\.\d+)?)\b/g, '<span class="n">$1</span>');
      return s;
    }

    var tooltipEl = document.getElementById('chartTooltip');
    function showTip(html, e) { if (!tooltipEl) return; tooltipEl.innerHTML = html; tooltipEl.classList.add('show'); positionTip(e); }
    function positionTip(e) {
      if (!tooltipEl) return;
      var r = tooltipEl.getBoundingClientRect();
      var x = e.clientX + 16, y = e.clientY + 16;
      if (x + r.width  > window.innerWidth  - 12) x = window.innerWidth  - r.width  - 12;
      if (y + r.height > window.innerHeight - 12) y = e.clientY - r.height - 16;
      tooltipEl.style.left = x + 'px'; tooltipEl.style.top = y + 'px';
    }
    function hideTip() { if (tooltipEl) tooltipEl.classList.remove('show'); }

    var state = { search:'', method:'', type:'', status:'', sortBy:'time', sortDir:'desc' };

    function renderTimingLines() {
      var container = document.getElementById('timingLines');
      if (!container) return;
      var top8 = DATA.slice().sort(function (a, b) { return b.time - a.time; }).slice(0, 8);
      container.innerHTML = top8.map(function (r) {
        var t = r.timing || {}; var total = r.time || 1;
        var segs = [
          { key:'dns',     label:'DNS Lookup',       val: Math.max(0, t.dns     || 0), ctx:'Time spent resolving the domain name to an IP address' },
          { key:'connect', label:'TCP Connect',      val: Math.max(0, t.connect || 0), ctx:'Time spent opening the TCP connection to the server' },
          { key:'ssl',     label:'TLS Handshake',    val: Math.max(0, t.ssl     || 0), ctx:'Time spent negotiating the HTTPS certificate' },
          { key:'send',    label:'Request Sent',     val: Math.max(0, t.send    || 0), ctx:'Time spent sending the HTTP request to the server' },
          { key:'wait',    label:'Server TTFB',      val: Math.max(0, t.wait    || 0), ctx:'Time the server took to process and start responding (Time to First Byte)' },
          { key:'receive', label:'Content Download', val: Math.max(0, t.receive || 0), ctx:'Time spent downloading the response body' }
        ];
        var ttfbPct = Math.round((segs[4].val / total) * 100);
        var ttfbStyle = ttfbPct > 70 ? 'style="color:#b3261e;font-weight:600"' : ttfbPct > 40 ? 'style="color:#9a5b00;font-weight:600"' : '';
        var segments = segs.map(function (s) {
          if (s.val <= 0) return '';
          var pct = Math.max(0.6, (s.val / total) * 100);
          var tip = '<div class="tlbl">' + esc(r.method || 'GET') + ' · ' + esc(s.label) + '</div>' +
                    '<div class="tval">' + Math.round(s.val) + ' ms</div>' +
                    '<div class="tctx">' + esc(s.ctx) + '</div>' +
                    '<div class="tctx" style="margin-top:6px;color:#7dd3fc;word-break:break-all">' + esc(r.host + String(r.path).slice(0, 70)) + '</div>';
          return '<div class="timing-seg" style="width:' + pct + '%;background:' + TIMING_COLORS[s.key] + '" data-tip="' + esc(tip) + '"></div>';
        }).join('');
        return '<div class="timing-line">' +
          '<div class="timing-name" title="https://' + esc(r.host + r.path) + '">' + esc(r.name) + '</div>' +
          '<div class="timing-bar-container">' + segments + '</div>' +
          '<div class="timing-total">' + fmtTime(total) + '</div>' +
          '<div class="timing-ttfb" ' + ttfbStyle + '>' + ttfbPct + '% TTFB</div></div>';
      }).join('');
      Array.prototype.forEach.call(container.querySelectorAll('.timing-seg'), function (seg) {
        seg.addEventListener('mouseenter', function (e) { showTip(seg.getAttribute('data-tip'), e); });
        seg.addEventListener('mousemove',  function (e) { positionTip(e); });
        seg.addEventListener('mouseleave', hideTip);
      });
    }

    function applyFilters() {
      var out = DATA.slice();
      if (state.search) { var q = state.search.toLowerCase(); out = out.filter(function (r) { return (r.host + r.path + r.method + r.status).toLowerCase().indexOf(q) !== -1; }); }
      if (state.method) out = out.filter(function (r) { return r.method === state.method; });
      if (state.type)   out = out.filter(function (r) { return r.type   === state.type;   });
      if (state.status) out = out.filter(function (r) {
        var s = Number(r.status);
        if (state.status === '2xx') return s >= 200 && s < 300;
        if (state.status === '3xx') return s >= 300 && s < 400;
        if (state.status === '4xx') return s >= 400 && s < 500;
        if (state.status === '5xx') return s >= 500;
        if (state.status === 'err') return !isFinite(s) || s >= 400;
        return true;
      });
      out.sort(function (a, b) {
        var dir = state.sortDir === 'asc' ? 1 : -1;
        switch (state.sortBy) {
          case 'name':      return dir * String(a.name || '').localeCompare(String(b.name || ''));
          case 'method':    return dir * String(a.method || '').localeCompare(String(b.method || ''));
          case 'status':    return dir * ((Number(a.status) || 0) - (Number(b.status) || 0));
          case 'type':      return dir * String(a.type || '').localeCompare(String(b.type || ''));
          case 'initiator': return dir * String(a.initiator || '').localeCompare(String(b.initiator || ''));
          case 'size':      return dir * (a.size - b.size);
          case 'time':      return dir * (a.time - b.time);
          default:          return 0;
        }
      });
      return out;
    }

    function kvRow(k, v) { return '<div class="k">' + esc(k) + '</div><div class="v">' + v + '</div>'; }
    function kvTable(obj) { return Object.keys(obj || {}).map(function (k) { return '<div class="k">' + esc(k) + '</div><div class="v">' + esc(obj[k]) + '</div>'; }).join(''); }

    var TIMING_LABELS = {
      dns:     { name:'DNS Lookup',       ctx:'Time spent resolving the domain name to an IP address' },
      connect: { name:'TCP Connect',      ctx:'Time spent opening the TCP connection to the server' },
      ssl:     { name:'TLS Handshake',    ctx:'Time spent negotiating the HTTPS certificate' },
      send:    { name:'Request Sent',     ctx:'Time spent sending the HTTP request to the server' },
      wait:    { name:'Server TTFB',      ctx:'Time the server took to process and start responding (Time to First Byte)' },
      receive: { name:'Content Download', ctx:'Time spent downloading the response body' }
    };

    function detailHTML(r, idx) {
      var sCls = statusClass(r.status); var timings = r.timing || {};
      var headersPane = '<div class="d-section"><div class="d-section-title">General</div><div class="kv">' +
        kvRow('Request URL', esc(r.host + r.path)) +
        kvRow('Request Method', '<span class="pill method ' + String(r.method).toLowerCase() + '">' + esc(r.method) + '</span>') +
        kvRow('Status Code', statusText(r.status) + ' ' + esc(r.statusText || '') + '<span class="badge ' + (sCls === 'ok' ? '' : 'bad') + '">' + (sCls === 'ok' ? 'OK' : 'FAILED') + '</span>') +
        kvRow('Remote Address', esc(r.remote || '—')) +
        kvRow('Referrer Policy', esc(r.refPolicy || 'strict-origin-when-cross-origin')) +
        (r.fromCache ? kvRow('Served from', 'Cache <span class="badge info">CACHED</span>') : '') +
        '</div></div>' +
        '<div class="d-section"><div class="d-section-title">Response Headers</div><div class="kv">' + kvTable(r.respHeaders) + '</div></div>' +
        '<div class="d-section"><div class="d-section-title">Request Headers</div><div class="kv">'  + kvTable(r.reqHeaders)  + '</div></div>';
      var payloadPane = r.postData
        ? '<div class="d-section"><div class="d-section-title">Request Payload</div><div class="kv">' +
            r.postData.split('&').map(function (kv) { var p = kv.split('='); return kvRow(p[0], esc(p.slice(1).join('='))); }).join('') + '</div></div>'
        : '<div class="d-section"><div class="d-section-title">Payload</div><p style="color:var(--text-muted);font-family:-apple-system,sans-serif;font-size:12.5px">This request has no body.</p></div>';
      var responsePane = '<div class="d-section"><div class="d-section-title">Response Body</div><pre class="code">' + highlight(r.respBody || '(empty)') + '</pre></div>';
      var allKeys = ['dns', 'connect', 'ssl', 'send', 'wait', 'receive'];
      var totalSum = allKeys.reduce(function (s, k) { return s + Math.max(0, timings[k] || 0); }, 0);
      var noTiming = (totalSum === 0);
      var cumulative = 0;
      var timingRows = allKeys.map(function (key) {
        var v = timings[key]; var meta = TIMING_LABELS[key]; var bg = TIMING_COLORS[key];
        if (v == null || v < 0) {
          return '<div class="timing-detail-row"><span class="tdl">' + meta.name + '</span><div class="tdb"></div><span class="tdv" style="color:#94a3b8">—</span></div>';
        }
        var left = (cumulative / totalSum) * 100;
        var width = Math.max(0.6, (v / totalSum) * 100);
        cumulative += v;
        var pct = ((v / totalSum) * 100).toFixed(1);
        return '<div class="timing-detail-row">' +
          '<span class="tdl">' + meta.name + '</span>' +
          '<div class="tdb"><span class="tdb-seg" style="left:' + left + '%;width:' + width + '%;background:' + bg + '" data-name="' + esc(meta.name) + '" data-ms="' + Math.round(v) + '" data-pct="' + pct + '" data-ctx="' + esc(meta.ctx) + '"></span></div>' +
          '<span class="tdv">' + Math.round(v) + ' ms</span></div>';
      }).join('');
      var timingPane;
      if (noTiming) {
        var why = r.statusText ? esc(r.statusText) : 'the request failed before a response was received';
        timingPane = '<div class="d-section">' +
          '<div class="d-section-title">Timing Breakdown</div>' +
          '<p style="color:var(--text-mid);font-family:-apple-system,sans-serif;font-size:12.5px;line-height:1.6;margin:0">' +
          'No timing data was captured — ' + why + '. ' +
          'Chrome only emits DNS / TCP / TLS / TTFB / Download phases once a request starts ' +
          'traveling the network. Blocked, aborted, or pre-flight-failed requests never reach that stage.' +
          '</p></div>';
      } else {
        timingPane = '<div class="d-section"><div class="d-section-title">Timing Breakdown — ' + totalSum + ' ms total</div><div class="timing-detail">' + timingRows + '</div></div>';
      }
      var initiatorPane = '<div class="d-section"><div class="d-section-title">Initiator Chain</div><div style="font-family:var(--mono);font-size:11.5px"><div style="padding:6px 12px;border-left:3px solid var(--brand);background:var(--surface-alt);border-radius:0 6px 6px 0;margin:4px 0"><div style="color:var(--brand);font-weight:600">' + (r.initiator === 'parser' ? 'HTMLParser' : r.initiator === 'css' ? 'StyleSheet' : 'XMLHttpRequest.send') + '</div><div style="color:var(--text-muted);font-size:10.5px;margin-top:2px">' + esc(r.host) + esc(r.path) + '</div></div></div></div>';
      return '<div class="detail-inner"><div class="detail-tabs">' +
        '<button class="detail-tab active" data-pane="headers-'   + idx + '">Headers</button>' +
        '<button class="detail-tab"        data-pane="payload-'   + idx + '">Payload</button>' +
        '<button class="detail-tab"        data-pane="response-'  + idx + '">Response</button>' +
        '<button class="detail-tab"        data-pane="timing-'    + idx + '">Timing</button>' +
        '<button class="detail-tab"        data-pane="initiator-' + idx + '">Initiator</button>' +
        '</div><div class="detail-body">' +
          '<div class="detail-pane active" id="pane-headers-'   + idx + '">' + headersPane   + '</div>' +
          '<div class="detail-pane"        id="pane-payload-'   + idx + '">' + payloadPane   + '</div>' +
          '<div class="detail-pane"        id="pane-response-'  + idx + '">' + responsePane  + '</div>' +
          '<div class="detail-pane"        id="pane-timing-'    + idx + '">' + timingPane    + '</div>' +
          '<div class="detail-pane"        id="pane-initiator-' + idx + '">' + initiatorPane + '</div>' +
        '</div></div>';
    }

    function renderRow(r, idx) {
      var sCls = statusClass(r.status);
      var tCls = timeClass(r.time, r.fromCache);
      var wCls = wfClass(r.time, r.fromCache);
      var durPct = Math.min(100, (r.time / 2000) * 100);
      var mCls = String(r.method).toLowerCase();
      var stText = statusText(r.status);
      return '<tr class="net-row" data-idx="' + idx + '">' +
        '<td class="col-name"><div class="name-cell"><span class="expander">▶</span>' +
          '<span class="icon ' + iconClass(r.type) + '"></span>' +
          '<span class="name-text"><span class="name-host">' + esc(r.host) + '</span>' + esc(r.path) + '</span></div></td>' +
        '<td class="col-method"><span class="pill method ' + mCls + '">' + esc(r.method) + '</span></td>' +
        '<td class="col-status"><span class="pill ' + sCls + '">' + stText + '</span></td>' +
        '<td class="col-type"><span class="type-text">' + esc(r.type) + '</span></td>' +
        '<td class="col-init"><span class="init-text">' + esc(r.initiator) + '</span></td>' +
        '<td class="col-size"><span class="size-text">' + fmtSize(r.size) + '</span></td>' +
        '<td class="col-time"><span class="time-text ' + tCls + '">' + fmtTime(r.time) + '</span></td>' +
        '<td class="col-wf"><div class="wf-cell"><span class="wf-bar ' + wCls + '" style="left:0;width:' + durPct + '%"></span></div></td>' +
      '</tr><tr class="net-detail" data-for="' + idx + '"><td colspan="8">' + detailHTML(r, idx) + '</td></tr>';
    }

    function bindTimingDetailTooltips() {
      Array.prototype.forEach.call(document.querySelectorAll('.tdb-seg'), function (seg) {
        if (seg.dataset.bound === '1') return;
        seg.dataset.bound = '1';
        seg.addEventListener('mouseenter', function (e) {
          var html = '<div class="tlbl">' + esc(seg.getAttribute('data-name')) + '</div>' +
            '<div class="tval">' + esc(seg.getAttribute('data-ms')) + ' ms <span style="color:#94a3b8;font-weight:400;font-size:11px">· ' + esc(seg.getAttribute('data-pct')) + '% of total</span></div>' +
            '<div class="tctx">' + esc(seg.getAttribute('data-ctx')) + '</div>';
          showTip(html, e);
        });
        seg.addEventListener('mousemove', function (e) { positionTip(e); });
        seg.addEventListener('mouseleave', hideTip);
      });
    }

    function renderNetwork() {
      var filtered = applyFilters();
      document.getElementById('netBody').innerHTML = filtered.map(function (r, i) { return renderRow(r, i); }).join('');
      document.getElementById('statVisible').textContent = filtered.length;
      var c2xx = filtered.filter(function (r) { var s = Number(r.status); return s >= 200 && s < 300; }).length;
      var c3xx = filtered.filter(function (r) { var s = Number(r.status); return s >= 300 && s < 400; }).length;
      var c4xx = filtered.filter(function (r) { var s = Number(r.status); return s >= 400 && s < 500; }).length;
      var c5xx = filtered.filter(function (r) { var s = Number(r.status); return s >= 500; }).length;
      var cSlow = filtered.filter(function (r) { return r.time > 1000; }).length;
      document.getElementById('chip2xx').textContent = c2xx + ' · 2xx';
      document.getElementById('chip3xx').textContent = c3xx + ' · 3xx';
      document.getElementById('chip4xx').textContent = c4xx + ' · 4xx';
      document.getElementById('chip5xx').textContent = c5xx + ' · 5xx';
      document.getElementById('statSlow').textContent = cSlow;
      Array.prototype.forEach.call(document.querySelectorAll('.net-row'), function (row) {
        row.addEventListener('click', function () {
          var was = row.classList.contains('open');
          Array.prototype.forEach.call(document.querySelectorAll('.net-row.open'), function (r) { r.classList.remove('open'); });
          if (!was) row.classList.add('open');
        });
      });
      Array.prototype.forEach.call(document.querySelectorAll('.detail-tab'), function (tab) {
        tab.addEventListener('click', function (e) {
          e.stopPropagation();
          var pane = tab.dataset.pane;
          var parent = tab.closest('.detail-inner');
          if (!parent) return;
          Array.prototype.forEach.call(parent.querySelectorAll('.detail-tab'),  function (t) { t.classList.remove('active'); });
          Array.prototype.forEach.call(parent.querySelectorAll('.detail-pane'), function (p) { p.classList.remove('active'); });
          tab.classList.add('active');
          var target = parent.querySelector('#pane-' + pane);
          if (target) target.classList.add('active');
        });
      });
      Array.prototype.forEach.call(document.querySelectorAll('.net-table thead th.sortable'), function (th) {
        var arrow = th.querySelector('.arrow');
        if (arrow) arrow.textContent = th.dataset.sort === state.sortBy ? (state.sortDir === 'asc' ? '↑' : '↓') : '';
      });
      bindTimingDetailTooltips();
    }

    function makeFrameSvg(i, label) {
      var colors = ['#635bff', '#0ea5e9', '#16a34a', '#dc2626', '#ea580c'];
      var c = colors[i % colors.length];
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200">' +
        '<defs><linearGradient id="g' + i + '" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0%" stop-color="' + c + '" stop-opacity=".15"/>' +
        '<stop offset="100%" stop-color="' + c + '" stop-opacity=".35"/></linearGradient></defs>' +
        '<rect width="320" height="200" fill="url(#g' + i + ')"/>' +
        '<text x="160" y="100" text-anchor="middle" font-family="-apple-system" font-size="18" font-weight="700" fill="' + c + '">' + label + '</text></svg>';
      return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    }

    function frameSrc(i, s) {
      if (s && typeof s.data === 'string' && s.data.length > 64) {
        var d = s.data;
        if (d.indexOf('data:') === 0) return d;
        return 'data:image/jpeg;base64,' + d;
      }
      return makeFrameSvg(i, (s && s.label) || ('frame-' + (i + 1)));
    }

    function renderAttachments() {
      var grid = document.getElementById('shotGrid');
      if (!grid) return;
      grid.innerHTML = SCREENSHOTS.map(function (s, i) {
        return '<div class="shot' + (i === 0 ? ' active' : '') + '" data-idx="' + i + '">' +
          '<span class="shot-tag">' + esc(s.label) + '</span>' +
          '<div class="shot-img"><img src="' + frameSrc(i, s) + '" style="width:100%;height:100%;object-fit:cover" alt="" loading="lazy"/></div>' +
          '<div class="shot-info"><div class="shot-label">' + esc(s.label) + '</div>' +
          '<div class="shot-time">' + esc(s.time) + '</div></div></div>';
      }).join('');
      var img      = document.querySelector('.player-img');
      var label    = document.querySelector('.player-label');
      var detail   = document.querySelector('.player-detail');
      var counter  = document.querySelector('.player-counter');
      var scrubber = document.querySelector('.player-scrubber');
      var btnPlay  = document.querySelector('.player-play');
      if (!img || !btnPlay) return;
      scrubber.max = Math.max(0, SCREENSHOTS.length - 1);
      var idx = 0, playing = false, timer = null;
      function renderFrame() {
        var s = SCREENSHOTS[idx]; if (!s) return;
        img.src = frameSrc(idx, s);
        label.textContent   = 'frame ' + (idx + 1) + ' · ' + s.label;
        detail.textContent  = s.detail;
        counter.textContent = (idx + 1) + ' / ' + SCREENSHOTS.length;
        scrubber.value = idx;
        Array.prototype.forEach.call(document.querySelectorAll('.shot'), function (x, i) { x.classList.toggle('active', i === idx); });
      }
      function goNext() { if (idx < SCREENSHOTS.length - 1) { idx++; renderFrame(); return true; } return false; }
      function goPrev() { if (idx > 0) { idx--; renderFrame(); return true; } return false; }
      function schedule() { timer = setTimeout(function () { if (!playing) return; if (goNext()) schedule(); else stop(); }, 800); }
      function play() { if (playing) return; if (idx === SCREENSHOTS.length - 1) idx = 0; playing = true; btnPlay.textContent = '⏸'; renderFrame(); schedule(); }
      function stop() { playing = false; btnPlay.textContent = '▶'; if (timer) { clearTimeout(timer); timer = null; } }
      btnPlay.addEventListener('click', function () { playing ? stop() : play(); });
      var prevBtn = document.querySelector('.player-prev'); if (prevBtn) prevBtn.addEventListener('click', function () { stop(); goPrev(); });
      var nextBtn = document.querySelector('.player-next'); if (nextBtn) nextBtn.addEventListener('click', function () { stop(); goNext(); });
      scrubber.addEventListener('input', function (e) { stop(); idx = parseInt(e.target.value, 10) || 0; renderFrame(); });
      Array.prototype.forEach.call(document.querySelectorAll('.shot'), function (s) {
        s.addEventListener('click', function () { stop(); idx = parseInt(s.dataset.idx, 10) || 0; renderFrame(); });
      });
      renderFrame();
    }

    function renderConsole() {
      var failed = DATA.filter(function (r) { var s = Number(r.status); return !isFinite(s) || s >= 400; }).map(function (r) {
        return { level: 'network', message: 'NETWORK FAILED: HTTP ' + statusText(r.status) + ' ' + r.method + ' ' + r.path, time: '' };
      });
      var all = CONSOLE.concat(failed);
      var list = document.getElementById('consoleList');
      if (!list) return;
      list.innerHTML = all.map(function (c) {
        var lv = String(c.level || 'log').toLowerCase();
        var cls = (lv === 'error' || lv === 'uncaught') ? 'lvl-error'
                : (lv === 'warning' || lv === 'warn') ? 'lvl-warning'
                : lv === 'network'                    ? 'lvl-network'
                :                                       'lvl-info';
        return '<div class="console-row"><div class="console-lvl"><span class="' + cls + '">' + esc(c.level) + '</span></div>' +
          '<div class="console-time">' + esc(c.time || '') + '</div>' +
          '<div class="console-msg">' + esc(c.message) + '</div></div>';
      }).join('');
      var cnt = document.getElementById('tabConCount');
      if (cnt) cnt.textContent = all.length;
    }

    function renderRaw() {
      var pre = document.getElementById('rawJson'); if (!pre) return;
      var dump = {
        meta:    { name: 'Report', url: '', startedAt: Date.now(), durationMs: 0 },
        summary: { totalRequests: DATA.length },
        network: DATA.map(function (r) {
          return { id: r.name, url: r.host + r.path, method: r.method, status: r.status, durationMs: r.time, encodedDataLength: r.size };
        })
      };
      try { pre.textContent = JSON.stringify(dump, null, 2); }
      catch (e) { pre.textContent = 'Error serialising report: ' + e.message; }
      var nc = document.getElementById('tabNetCount'); if (nc) nc.textContent = DATA.length;
      var ac = document.getElementById('tabAttCount'); if (ac) ac.textContent = SCREENSHOTS.length;
    }

    function renderRiskRow(row, sev) {
      var cls = sev === 'danger' ? 'sev-danger' : sev === 'warn' ? 'sev-warn' : sev === 'success' ? 'sev-success' : '';
      return '<tr class="' + cls + '">' + row.map(function (c) {
        return '<td>' + esc(c) + '</td>';
      }).join('') + '</tr>';
    }

    function initRiskDrill() {
      Array.prototype.forEach.call(document.querySelectorAll('.risk'), function (card) {
        card.addEventListener('click', function () {
          var id = card.dataset.risk; var r = RISK_DATA[id]; if (!r) return;
          var drill = document.getElementById('riskDrill');
          document.getElementById('riskDrillTitle').textContent = r.title;
          var body = document.getElementById('riskDrillBody');
          if (r.body) {
            body.innerHTML = '<p style="color:var(--text-mid);font-size:13px;line-height:1.6">' + esc(r.body) + '</p>';
          } else {
            var rows = r.table.map(function (row, ri) {
              var sev = (r.severities && r.severities[ri]) || '';
              return renderRiskRow(row, sev);
            }).join('');
            body.innerHTML = '<table>' + rows + '</table>';
          }
          drill.classList.add('open');
          if (drill.scrollIntoView) drill.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
      });
      var riskClose = document.getElementById('riskDrillClose');
      if (riskClose) riskClose.addEventListener('click', function () { document.getElementById('riskDrill').classList.remove('open'); });
    }

    var searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.addEventListener('input', function (e) { state.search = e.target.value; renderNetwork(); });
    var methodFilter = document.getElementById('methodFilter');
    if (methodFilter) methodFilter.addEventListener('change', function (e) { state.method = e.target.value; renderNetwork(); });
    var typeFilter = document.getElementById('typeFilter');
    if (typeFilter) typeFilter.addEventListener('change', function (e) { state.type = e.target.value; renderNetwork(); });
    var statusFilter = document.getElementById('statusFilter');
    if (statusFilter) statusFilter.addEventListener('change', function (e) { state.status = e.target.value; renderNetwork(); });

    Array.prototype.forEach.call(document.querySelectorAll('.net-table thead th.sortable'), function (th) {
      th.addEventListener('click', function () {
        if (state.sortBy === th.dataset.sort) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        else { state.sortBy = th.dataset.sort; state.sortDir = 'asc'; }
        renderNetwork();
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.addEventListener('click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.tab'),         function (x) { x.classList.remove('active'); });
        Array.prototype.forEach.call(document.querySelectorAll('.tab-content'), function (x) { x.classList.remove('active'); });
        t.classList.add('active');
        var el = document.getElementById('tab-' + t.dataset.tab);
        if (el) el.classList.add('active');
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.vital'), function (v) {
      v.addEventListener('click', function (e) {
        if (e.target.closest('.vdetail')) return;
        var was = v.classList.contains('open');
        Array.prototype.forEach.call(document.querySelectorAll('.vital.open'), function (x) { x.classList.remove('open'); });
        if (!was) v.classList.add('open');
      });
    });

    function safe(fn, name) { try { fn(); } catch (e) { console.error('[ReportTheme runtime:' + name + ']', e); } }
    safe(renderTimingLines, 'timingLines');
    safe(renderNetwork,     'network');
    safe(renderAttachments, 'attachments');
    safe(renderConsole,     'console');
    safe(renderRaw,         'raw');
    safe(initRiskDrill,     'riskDrill');
  }

  /* ======================= MAIN ENTRY POINT ============================ */

  function buildSelfContainedHTML(report, health) {
    report = report || {};
    health = health || report.health || null;

    var netData     = (report.network     || []).map(transformNetworkItem);
    var screenshots = transformScreenshots(report.screenshots || []);
    var consoleData = transformConsole(report.console || []);
    var riskData    = buildRiskData(health);

    var payload = { network: netData, screenshots: screenshots, console: consoleData, riskData: riskData };

    var payloadJSON = JSON.stringify(payload).replace(/<\/(script|SCRIPT)/g, '<\\/$1');
    var runtimeSource = Runtime.toString().replace(/<\/(script|SCRIPT)/g, '<\\/$1');

    var runtimeInline =
      '(function(){try{(' + runtimeSource + ')(' + payloadJSON + ');}' +
      'catch(e){console.error("[ReportTheme runtime]",e);}})();';

    var h = '';
    h += '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>';
    h += '<title>' + escapeHtml((report.meta && report.meta.name) || 'Perf Trace Report') + ' — Perf-Trace-Pulse</title>';
    h += '<style>' + CSS + '</style>';
    h += '</head><body>';

    h += buildHero(report);
    h += buildReportHeader(report, health);

    h += '<div class="wrap">';
    h += buildExecutiveSummary(report, health);
    h += buildPerformanceOverview(report);
    h += buildStatsStrip(report);
    h += buildTimingLinesHTML(report);
    h += buildWebVitalsHTML(report);
    h += buildRiskGridHTML(health);
    h += buildTabsHTML(report);
    h += buildTabPanelHTML(report);
    h += '</div>';

    h += '<div class="chart-tooltip" id="chartTooltip"></div>';
    h += '<scr' + 'ipt>' + runtimeInline + '</scr' + 'ipt>';
    h += '</body></html>';

    return h;
  }

  function debug() {
    var info = {
      version: '4.6.0',
      hasBuild: typeof buildSelfContainedHTML === 'function',
      host: typeof window !== 'undefined' ? 'window' : typeof self !== 'undefined' ? 'self' : 'unknown'
    };
    if (typeof console !== 'undefined') {
      console.log('[ReportTheme.debug]', info);
      if (console.table) console.table(info);
    }
    return info;
  }

  var API = {
    version: '4.6.0',
    buildSelfContainedHTML: buildSelfContainedHTML,
    debug: debug,
    escapeHtml: escapeHtml,
    formatDuration: formatDuration,
    safeDurationMs: safeDurationMs,
    shortPath: shortPath,
    transformNetworkItem: transformNetworkItem,
    transformScreenshots: transformScreenshots,
    transformConsole: transformConsole
  };

  if (typeof window     !== 'undefined') window.ReportTheme     = API;
  if (typeof self       !== 'undefined' && self !== window) self.ReportTheme = API;
  if (typeof globalThis !== 'undefined') globalThis.ReportTheme = API;

  if (typeof console !== 'undefined' && console.log) {
    console.log('[ReportTheme] v' + API.version + ' loaded. buildSelfContainedHTML = ' + typeof API.buildSelfContainedHTML);
  }

})(typeof globalThis !== 'undefined' ? globalThis
   : typeof self       !== 'undefined' ? self
   : typeof window     !== 'undefined' ? window
   : this);