/**
 * Perf-Trace-Pulse — ZIP orchestrator
 * Thin wrapper: builds the ZIP archive using the HTML from ReportTheme.
 * All visual/theme code lives in reportTheme.js.
 */

(function () {
  'use strict';

  function safeFilenameStem(rawName) {
    var name = String(rawName == null ? '' : rawName).trim() || 'recording';
    name = name.replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    return (name || 'recording').slice(0, 60);
  }

  window.downloadZipReport = function (report, health, budgetResult) {
    if (typeof JSZip === 'undefined') { alert('Error: JSZip library is missing.'); return; }
    if (!window.ReportTheme)         { alert('Error: reportTheme.js failed to load.'); return; }

    var zip = new JSZip();
    var recName  = (report.meta && report.meta.name) || 'recording';
    var safeName = safeFilenameStem(recName);

    // 1. Main HTML report — produced entirely by reportTheme.js
    try {
      zip.file('report.html', window.ReportTheme.buildSelfContainedHTML(report, health, budgetResult));
    } catch (e) {
      zip.file('report.html', '<!DOCTYPE html><html><body><h1>Error generating report</h1><pre>' + (e && e.message) + '</pre></body></html>');
    }

    // 2. Raw data
    zip.file('report.json', JSON.stringify(report, null, 2));

    // 3. Summary text
    var summary = 'Perf-Trace-Pulse Summary\n========================\nRecording Name: ' + recName + '\nDate: ' + new Date().toLocaleString() + '\n';
    if (health) summary += 'Health Score: ' + health.score + '/100 (' + health.verdictLabel + ')\n';
    zip.file('summary.txt', summary);

    // 4. HAR file
    if (report.network && report.network.length > 0) {
      zip.file('report.har', JSON.stringify({
        log: { version: '1.2', creator: { name: 'Perf-Trace-Pulse' }, entries: report.network }
      }, null, 2));
    }

    // 5. Screenshots
    if (report.screenshots && report.screenshots.length > 0) {
      var imgFolder = zip.folder('screenshots');
      report.screenshots.forEach(function (s, i) {
        imgFolder.file('screen_' + (i + 1).toString().padStart(3, '0') + '.jpg', s.data, { base64: true });
      });
    }

    // 6. README
    zip.file('README.txt',
      'Perf-Trace-Pulse Report\n' +
      '=======================\n\n' +
      'How to view:\n' +
      '  1. Extract this ZIP file\n' +
      '  2. Open "report.html" in any modern browser\n\n' +
      'Included files:\n' +
      '  report.html       — interactive report (self-contained)\n' +
      '  report.json       — raw report data\n' +
      '  report.har        — HTTP archive (importable into DevTools)\n' +
      '  summary.txt       — plain text summary\n' +
      '  screenshots/      — captured frames\n'
    );

    // 7. Download
    zip.generateAsync({ type: 'blob' }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = safeName + '_report.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }).catch(function (err) {
      console.error('[PTP] ZIP generation failed:', err);
    });
  };

})();