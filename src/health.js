/**
 * Perf-Trace-Pulse — Health + Budget engine (shared)
 * Used by both the service worker (for history storage) and the ZIP builder.
 */

(function (global) {
  'use strict';

  const BUDGET_DEFAULTS = {
    enabled: false,
    lcp: 2500,
    fcp: 1800,
    cls: 0.1,
    inp: 200,
    ttfb: 800,
    p95ApiMs: 1000,
    maxFailedRequests: 0,
    maxConsoleErrors: 0,
    maxDomNodes: 3000
  };

  function shortPath(u) {
    try { var url = new URL(u); return url.pathname.split('/').slice(-2).join('/'); }
    catch (e) { return u; }
  }

  // ============================================================
  //  HEALTH SCORE — with N/A handling for missing metrics
  // ============================================================
  function computeHealth(report) {
    var s = report.summary || {};
    var memory = report.memory || [];
    var net = report.network || [];
    var console_ = report.console || [];
    var vitalsEvents = report.vitalsEvents || [];

    var score = 100;
    var factors = [];
    var recommendations = [];
    var missingMetrics = [];

    // ── 1. Web Vitals ────────────────────────────────────────
    var vitalsIssues = 0;
    var vitalsVerdict = 'good';
    function vital(name, val, good, warn) {
      if (val == null || isNaN(val)) {
        missingMetrics.push(name);
        return null; // N/A — do NOT penalise
      }
      if (val > warn) { vitalsIssues += 2; vitalsVerdict = 'bad'; return 'bad'; }
      if (val > good) { vitalsIssues += 1; if (vitalsVerdict !== 'bad') vitalsVerdict = 'warn'; return 'warn'; }
      return 'good';
    }
    var vitalData = [
      { name: 'LCP',  value: s.lcp,  unit: 'ms', good: 2500, warn: 4000, verdict: vital('LCP', s.lcp, 2500, 4000) },
      { name: 'FCP',  value: s.fcp,  unit: 'ms', good: 1800, warn: 3000, verdict: vital('FCP', s.fcp, 1800, 3000) },
      { name: 'CLS',  value: s.cls,  unit: '',   good: 0.1,  warn: 0.25, verdict: vital('CLS', s.cls, 0.1, 0.25) },
      { name: 'INP',  value: s.inp,  unit: 'ms', good: 200,  warn: 500,  verdict: vital('INP', s.inp, 200, 500) },
      { name: 'TTFB', value: s.ttfb, unit: 'ms', good: 800,  warn: 1800, verdict: vital('TTFB', s.ttfb, 800, 1800) }
    ];

    if (vitalsIssues >= 4) score -= 30;
    else if (vitalsIssues >= 2) score -= 15;
    else if (vitalsIssues === 1) score -= 6;

    factors.push({
      id: 'vitals',
      name: 'Web Vitals',
      verdict: vitalsVerdict,
      detail: vitalsIssues === 0
        ? (missingMetrics.length ? 'All captured in good range (' + missingMetrics.length + ' N/A)' : 'All in good range')
        : vitalsIssues + ' metric' + (vitalsIssues > 1 ? 's' : '') + ' outside target',
      weight: vitalsIssues >= 2 ? 'HIGH' : vitalsIssues === 1 ? 'AVERAGE' : 'GOOD',
      data: vitalData
    });

    // ── 2. Slow APIs ─────────────────────────────────────────
    var slowAPIs = net.filter(function (r) { return r.durationMs >= 1000; })
      .sort(function (a, b) { return b.durationMs - a.durationMs; });
    var slow1s = slowAPIs.filter(function (r) { return r.durationMs < 2000; }).length;
    var slow2s = slowAPIs.filter(function (r) { return r.durationMs >= 2000; }).length;
    var slowTotal = slow1s + slow2s;
    var apiVerdict = 'good';
    var apiRisk = 'GOOD';

    if (slow2s >= 3) { score -= 25; apiVerdict = 'bad'; apiRisk = 'CRITICAL'; }
    else if (slow2s >= 1) { score -= 15; apiVerdict = 'bad'; apiRisk = 'HIGH'; }
    else if (slow1s >= 5) { score -= 15; apiVerdict = 'warn'; apiRisk = 'HIGH'; }
    else if (slow1s >= 2) { score -= 8; apiVerdict = 'warn'; apiRisk = 'AVERAGE'; }
    else if (slow1s === 1) { score -= 3; apiVerdict = 'warn'; apiRisk = 'AVERAGE'; }

    factors.push({
      id: 'apiSpeed',
      name: 'API Response Time',
      verdict: apiVerdict,
      detail: slowTotal === 0 ? 'No slow calls detected' : slowTotal + ' call' + (slowTotal > 1 ? 's' : '') + ' over 1s' + (slow2s ? ' (' + slow2s + ' over 2s)' : ''),
      weight: apiRisk,
      data: slowAPIs.slice(0, 30)
    });
    if (slow2s > 0 && slowAPIs[0]) recommendations.push('Investigate ' + shortPath(slowAPIs[0].url) + ' — takes ' + slowAPIs[0].durationMs + ' ms');

    // ── 3. Network Failures ─────────────────────────────────
    var failedList = net.filter(function (r) { return r.failed || (r.status && r.status >= 400); });
    var failed = failedList.length;
    var failVerdict = 'good';
    var failRisk = 'GOOD';
    if (failed >= 5) { score -= 30; failVerdict = 'bad'; failRisk = 'CRITICAL'; }
    else if (failed >= 2) { score -= 20; failVerdict = 'bad'; failRisk = 'HIGH'; }
    else if (failed === 1) { score -= 10; failVerdict = 'warn'; failRisk = 'AVERAGE'; }

    factors.push({
      id: 'failures',
      name: 'Network Failures',
      verdict: failVerdict,
      detail: failed === 0 ? 'No failed requests' : failed + ' request' + (failed > 1 ? 's' : '') + ' failed (4xx/5xx)',
      weight: failRisk,
      data: failedList
    });
    if (failed > 0) recommendations.push('Fix ' + failed + ' failing API' + (failed > 1 ? 's' : '') + ' — see drill-down');

    // ── 4. Console Errors ───────────────────────────────────
    var errList = console_.filter(function (c) { return c.level === 'error' || c.level === 'uncaught'; });
    var errs = errList.length;
    var errVerdict = 'good';
    var errRisk = 'GOOD';
    if (errs >= 10) { score -= 25; errVerdict = 'bad'; errRisk = 'CRITICAL'; }
    else if (errs >= 4) { score -= 15; errVerdict = 'bad'; errRisk = 'HIGH'; }
    else if (errs >= 1) { score -= 6; errVerdict = 'warn'; errRisk = 'AVERAGE'; }

    factors.push({
      id: 'console',
      name: 'Console Errors',
      verdict: errVerdict,
      detail: errs === 0 ? 'Clean console' : errs + ' error' + (errs > 1 ? 's' : '') + ' logged',
      weight: errRisk,
      data: errList.slice(0, 30)
    });
    if (errs > 0) recommendations.push('Review ' + errs + ' console error' + (errs > 1 ? 's' : ''));

    // ── 5. Memory ───────────────────────────────────────────
    var peakHeapMB = 0;
    if (memory.length) peakHeapMB = Math.max.apply(null, memory.map(function (m) { return m.jsHeapUsed || 0; })) / 1048576;
    var memVerdict = 'good';
    var memRisk = 'GOOD';
    if (peakHeapMB >= 200) { score -= 20; memVerdict = 'bad'; memRisk = 'HIGH'; }
    else if (peakHeapMB >= 100) { score -= 10; memVerdict = 'warn'; memRisk = 'AVERAGE'; }
    else if (peakHeapMB >= 50) { score -= 4; memVerdict = 'warn'; memRisk = 'AVERAGE'; }

    factors.push({
      id: 'memory',
      name: 'Memory Usage',
      verdict: memVerdict,
      detail: peakHeapMB > 0 ? 'Peak: ' + peakHeapMB.toFixed(1) + ' MB JS heap' : 'Not sampled',
      weight: memRisk,
      data: memory.map(function (m) {
        return { timestamp: m.timestamp, heapMB: (m.jsHeapUsed || 0) / 1048576, nodes: m.nodes, documents: m.documents };
      })
    });
    if (peakHeapMB >= 100) recommendations.push('Memory peak is high (' + peakHeapMB.toFixed(0) + ' MB) — check for leaks');

    // ── 6. DOM Complexity ───────────────────────────────────
    var peakNodes = 0;
    if (memory.length) peakNodes = Math.max.apply(null, memory.map(function (m) { return m.nodes || 0; }));
    var domVerdict = 'good';
    var domRisk = 'GOOD';
    if (peakNodes >= 5000) { score -= 12; domVerdict = 'bad'; domRisk = 'HIGH'; }
    else if (peakNodes >= 3000) { score -= 6; domVerdict = 'warn'; domRisk = 'AVERAGE'; }
    else if (peakNodes >= 1500) { score -= 2; domVerdict = 'warn'; domRisk = 'AVERAGE'; }

    factors.push({
      id: 'dom',
      name: 'DOM Complexity',
      verdict: domVerdict,
      detail: peakNodes > 0 ? 'Peak: ' + peakNodes.toLocaleString() + ' nodes' : 'Not sampled',
      weight: domRisk,
      data: memory.map(function (m) {
        return { timestamp: m.timestamp, nodes: m.nodes, documents: m.documents };
      })
    });
    if (peakNodes >= 5000) recommendations.push('Page has ' + peakNodes.toLocaleString() + ' DOM nodes — consider virtualization');

    // ── 7. Long Tasks ───────────────────────────────────────
    var longTaskList = vitalsEvents.filter(function (v) { return v.name === 'LONGTASK'; })
      .sort(function (a, b) { return b.value - a.value; });
    var longestTask = 0;
    if (longTaskList.length) longestTask = longTaskList[0].value;
    var ltVerdict = 'good';
    var ltRisk = 'GOOD';
    if (longestTask >= 500) { score -= 15; ltVerdict = 'bad'; ltRisk = 'HIGH'; }
    else if (longestTask >= 200) { score -= 6; ltVerdict = 'warn'; ltRisk = 'AVERAGE'; }

    factors.push({
      id: 'longTasks',
      name: 'Long Tasks',
      verdict: ltVerdict,
      detail: longTaskList.length === 0 ? 'None detected' : longTaskList.length + ' task' + (longTaskList.length > 1 ? 's' : '') + ' (>50 ms); longest ' + Math.round(longestTask) + ' ms',
      weight: ltRisk,
      data: longTaskList.slice(0, 30).map(function (t) {
        return { timestamp: t.timestamp, epoch: t.epoch, duration: t.value };
      })
    });
    if (longestTask >= 200) recommendations.push('Main thread blocked for ' + Math.round(longestTask) + ' ms — break up long tasks');

    // ── Final verdict ───────────────────────────────────────
    if (score < 0) score = 0;
    if (score > 100) score = 100;

    var verdictClass, verdictLabel;
    if (score >= 85) { verdictClass = 'healthy'; verdictLabel = 'HEALTHY'; }
    else if (score >= 65) { verdictClass = 'average'; verdictLabel = 'AVERAGE'; }
    else if (score >= 40) { verdictClass = 'high'; verdictLabel = 'HIGH RISK'; }
    else { verdictClass = 'critical'; verdictLabel = 'CRITICAL'; }

    var criticalCount = factors.filter(function (f) { return f.weight === 'CRITICAL'; }).length;
    var highCount = factors.filter(function (f) { return f.weight === 'HIGH'; }).length;
    var avgCount = factors.filter(function (f) { return f.weight === 'AVERAGE'; }).length;
    var issueCount = criticalCount + highCount + avgCount;

    var sentence;
    if (verdictClass === 'healthy') sentence = 'All monitored factors are within healthy thresholds. This session passed the performance sanity check.';
    else if (verdictClass === 'average') sentence = issueCount + ' minor issue' + (issueCount > 1 ? 's' : '') + ' detected. No user-facing impact, but worth monitoring.';
    else if (verdictClass === 'high') sentence = issueCount + ' significant issue' + (issueCount > 1 ? 's' : '') + ' affect user experience. Fix before release.';
    else sentence = issueCount + ' critical issue' + (issueCount > 1 ? 's' : '') + ' found. This session does not meet performance targets.';

    if (missingMetrics.length) {
      sentence += ' Note: ' + missingMetrics.join(', ') + ' not captured this session.';
    }

    return {
      score: score,
      verdict: verdictClass,
      verdictClass: verdictClass,
      verdictLabel: verdictLabel,
      sentence: sentence,
      factors: factors,
      recommendations: recommendations.slice(0, 8),
      counts: { critical: criticalCount, high: highCount, average: avgCount },
      missingMetrics: missingMetrics
    };
  }

  // ============================================================
  //  BUDGET EVALUATION — PASS / FAIL
  // ============================================================
  function evaluateBudget(report, health, budget) {
    if (!budget || !budget.enabled) return { enabled: false, pass: null, checks: [], failed: [], missing: [] };

    var s = report.summary || {};
    var memory = report.memory || [];
    var checks = [];

    function check(id, label, actual, limit, unit) {
      if (actual == null || isNaN(actual)) {
        checks.push({ id: id, label: label, actual: null, limit: limit, unit: unit, pass: null, reason: 'not captured' });
        return;
      }
      var ok = actual <= limit;
      checks.push({ id: id, label: label, actual: actual, limit: limit, unit: unit, pass: ok });
    }

    check('lcp', 'LCP', s.lcp, budget.lcp, 'ms');
    check('fcp', 'FCP', s.fcp, budget.fcp, 'ms');
    check('cls', 'CLS', s.cls, budget.cls, '');
    check('inp', 'INP', s.inp, budget.inp, 'ms');
    check('ttfb', 'TTFB', s.ttfb, budget.ttfb, 'ms');
    check('p95ApiMs', 'API p95', s.p95, budget.p95ApiMs, 'ms');
    check('maxFailedRequests', 'Failed requests', s.failedRequests || 0, budget.maxFailedRequests, '');
    check('maxConsoleErrors', 'Console errors', s.totalErrors || 0, budget.maxConsoleErrors, '');

    var peakNodes = 0;
    if (memory.length) peakNodes = Math.max.apply(null, memory.map(function (m) { return m.nodes || 0; }));
    if (peakNodes > 0) check('maxDomNodes', 'DOM nodes', peakNodes, budget.maxDomNodes, '');

    var failed = checks.filter(function (c) { return c.pass === false; });
    var missing = checks.filter(function (c) { return c.pass === null; });

    return {
      enabled: true,
      pass: failed.length === 0,
      checks: checks,
      failed: failed,
      missing: missing
    };
  }

  global.PerfHealth = {
    computeHealth: computeHealth,
    evaluateBudget: evaluateBudget,
    shortPath: shortPath,
    BUDGET_DEFAULTS: BUDGET_DEFAULTS
  };
})(typeof self !== 'undefined' ? self : this);