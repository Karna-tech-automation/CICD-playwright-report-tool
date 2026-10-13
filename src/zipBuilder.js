/**
 * Perf-Trace-Pulse — ZIP orchestrator
 * v2.0.0 — fixed scope + async download
 */

(function () {
  'use strict';

  function safeFilenameStem(rawName) {
    var name = String(rawName == null ? '' : rawName).trim() || 'recording';
    name = name.replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    return (name || 'recording').slice(0, 60);
  }

  // ─────────────────────────────────────────────────────────
  //  HAR 1.2 transformer
  // ─────────────────────────────────────────────────────────

  function headersToArray(h) {
    if (!h) return [];
    if (Array.isArray(h)) {
      return h.map(function (x) {
        return { name: String(x.name || ''), value: String(x.value == null ? '' : x.value) };
      });
    }
    return Object.keys(h).map(function (k) {
      return { name: k, value: String(h[k] == null ? '' : h[k]) };
    });
  }

  function parseQuery(url) {
    var qs = [];
    try {
      var u = new URL(url);
      u.searchParams.forEach(function (v, k) { qs.push({ name: k, value: v }); });
    } catch (e) {}
    return qs;
  }

  function pickHeader(headers, name) {
    if (!headers) return '';
    var lower = name.toLowerCase();
    if (Array.isArray(headers)) {
      for (var i = 0; i < headers.length; i++) {
        if ((headers[i].name || '').toLowerCase() === lower) return headers[i].value || '';
      }
      return '';
    }
    var keys = Object.keys(headers);
    for (var j = 0; j < keys.length; j++) {
      if (keys[j].toLowerCase() === lower) return headers[keys[j]] || '';
    }
    return '';
  }

  function toHarEntry(n) {
    var startedMs = n.epoch;
    if (typeof startedMs !== 'number' || startedMs < 1e12) {
      if (typeof n.startTime === 'number' && n.startTime > 1e12) startedMs = n.startTime;
      else startedMs = Date.now();
    }
    var startedIso = new Date(startedMs).toISOString();

    var total = (typeof n.durationMs === 'number' && n.durationMs >= 0 && n.durationMs < 3600000) ? n.durationMs : 0;

    var t = n.timing || {};
    var dns      = Math.max(0, (t.dnsEnd       || 0) - (t.dnsStart       || 0));
    var connect  = Math.max(0, (t.connectEnd   || 0) - (t.connectStart   || 0));
    var ssl      = Math.max(0, (t.sslEnd       || 0) - (t.sslStart       || 0));
    var send     = Math.max(0, (t.sendEnd      || 0) - (t.sendStart      || 0));
    var wait     = Math.max(0, (t.receiveHeadersEnd || 0) - (t.sendEnd   || 0));
    var receive  = Math.max(0, total - (dns + connect + send + wait));

    var bodySize  = n.encodedDataLength || 0;
    var contentSize = n.responseBody && !n.responseBodyBase64 ? n.responseBody.length : bodySize;
    var mimeType  = n.mimeType || 'application/octet-stream';

    var postDataObj = null;
    if (n.postData) {
      var ct = pickHeader(n.requestHeaders, 'content-type') || 'application/x-www-form-urlencoded';
      postDataObj = { mimeType: ct, text: String(n.postData) };
    }

    var content = { size: contentSize, mimeType: mimeType };
    if (n.responseBody) {
      if (n.responseBodyBase64) {
        content.text = String(n.responseBody);
        content.encoding = 'base64';
      } else {
        content.text = String(n.responseBody);
      }
    }

    var redirectURL = pickHeader(n.responseHeaders, 'location') || '';

    var status = n.failed ? 0 : (n.status || 0);
    var statusText = n.failed ? (n.errorText || 'Failed') : (n.statusText || '');

    var cache = {};
    if (n.fromCache) {
      cache.beforeRequest = { comment: 'Served from cache (disk or service worker)' };
    }

    return {
      startedDateTime: startedIso,
      time: total,
      request: {
        method: n.method || 'GET',
        url: n.url || '',
        httpVersion: n.protocol || 'HTTP/1.1',
        headers: headersToArray(n.requestHeaders),
        queryString: parseQuery(n.url),
        cookies: [],
        headersSize: -1,
        bodySize: postDataObj ? postDataObj.text.length : -1,
        postData: postDataObj || undefined
      },
      response: {
        status: status,
        statusText: statusText,
        httpVersion: n.protocol || 'HTTP/1.1',
        headers: headersToArray(n.responseHeaders),
        cookies: [],
        content: content,
        redirectURL: redirectURL,
        headersSize: -1,
        bodySize: bodySize
      },
      cache: cache,
      timings: {
        blocked: 0,
        dns:      dns     > 0 ? dns     : -1,
        connect:  connect > 0 ? connect : -1,
        send:     send,
        wait:     wait,
        receive:  receive,
        ssl:      ssl     > 0 ? ssl     : -1
      },
      serverIPAddress: n.serverIPAddress || '',
      connection:      n.connection      || '',
      _ptp: {
        type: n.type || '',
        tabId: n.tabId,
        relativeMs: n.relativeMs,
        failed: !!n.failed,
        errorText: n.errorText || '',
        blockedReason: n.blockedReason || ''
      }
    };
  }

  function buildHar(network) {
    return {
      log: {
        version: '1.2',
        creator: { name: 'Perf-Trace-Pulse', version: '2.0.0' },
        browser: { name: 'Chrome', version: '' },
        pages: [],
        entries: (network || []).map(toHarEntry)
      }
    };
  }

  // ─────────────────────────────────────────────────────────
  //  Main download
  // ─────────────────────────────────────────────────────────

  window.downloadZipReport = async function (report, health, budgetResult) {
    if (typeof JSZip === 'undefined') {
      alert('Error: JSZip library is missing.');
      return;
    }

    var RT = (typeof window !== 'undefined' && window.ReportTheme)
          || (typeof self   !== 'undefined' && self.ReportTheme)
          || null;

    if (!RT || typeof RT.buildSelfContainedHTML !== 'function') {
      console.error('[PTP] ReportTheme missing or incomplete:', RT);
      alert('Error: reportTheme.js is loaded but buildSelfContainedHTML is missing. See console for details.');
      return;
    }

    var zip = new JSZip();
    var recName  = (report.meta && report.meta.name) || 'recording';
    var safeName = safeFilenameStem(recName);

    // 1. HTML report
    try {
      zip.file('report.html', RT.buildSelfContainedHTML(report, health));
    } catch (e) {
      console.error('[PTP] Report generation threw:', e);
      zip.file('report.html',
        '<!DOCTYPE html><html><body><h1>Error generating report</h1>' +
        '<pre>' + (e && e.stack ? e.stack : e && e.message) + '</pre></body></html>');
    }

    // 1b. Embed hero-banner.png so the report can load it from the ZIP folder.
    try {
      var heroUrl = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
        ? chrome.runtime.getURL('src/hero-banner.png')
        : 'hero-banner.png';
      var heroResp = await fetch(heroUrl);
      if (heroResp.ok) {
        var heroBlob = await heroResp.blob();
        zip.file('hero-banner.png', heroBlob);
      } else {
        console.warn('[PTP] hero-banner.png not found at', heroUrl);
      }
    } catch (e) {
      console.warn('[PTP] Could not embed hero-banner.png:', e);
    }

    // 2. Raw JSON
    zip.file('report.json', JSON.stringify(report, null, 2));

    // 3. Summary text
    var summary = 'Perf-Trace-Pulse Summary\n' +
                  '========================\n' +
                  'Recording Name: ' + recName + '\n' +
                  'Date: ' + new Date().toLocaleString() + '\n';
    if (health) summary += 'Health Score: ' + health.score + '/100 (' + health.verdictLabel + ')\n';
    zip.file('summary.txt', summary);

    // 4. HAR 1.2
    if (report.network && report.network.length > 0) {
      try {
        zip.file('report.har', JSON.stringify(buildHar(report.network), null, 2));
      } catch (e) {
        console.warn('[PTP] HAR export failed:', e);
      }
    }

    // 5. Screenshots
    if (report.screenshots && report.screenshots.length > 0) {
      var imgFolder = zip.folder('screenshots');
      report.screenshots.forEach(function (s, i) {
        if (s && s.data) {
          imgFolder.file('screen_' + (i + 1).toString().padStart(3, '0') + '.jpg', s.data, { base64: true });
        }
      });
    }

    // 6. README
    zip.file('README.txt',
      'Perf-Trace-Pulse Report\n' +
      '=======================\n\n' +
      'Files:\n' +
      '  report.html     — interactive report (open in any browser)\n' +
      '  report.json     — raw report data\n' +
      '  report.har      — standard HAR 1.2 (DevTools / HAR Analyzer compatible)\n' +
      '  summary.txt     — plain text summary\n' +
      '  hero-banner.png — report banner image\n' +
      '  screenshots/    — captured frames\n'
    );

    // 7. Download — stays INSIDE the async function.
    try {
      var blob = await zip.generateAsync({ type: 'blob' });
      var url  = URL.createObjectURL(blob);
      var a    = document.createElement('a');
      a.href = url;
      a.download = safeName + '_report.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (err) {
      console.error('[PTP] ZIP generation failed:', err);
      alert('ZIP generation failed: ' + err.message);
    }
  };

  window.ReportTheme_buildHar = buildHar;

})();