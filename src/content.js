/**
 * Perf-Lens — Content Script v1.13.1
 * - Fixed Resource Timing to use PerformanceObserver
 * - Filtered out internal extension marks from Custom Marks
 */

(() => {
  if (window !== window.top) return;
  if (window.__perfTraceInjected) return;
  window.__perfTraceInjected = true;

  let isRecording = false;
  let actionBuffer = [];
  let vitalsBuffer = [];
  let fpsBuffer = [];
  let customMarksBuffer = [];
  let resourcesBuffer = [];

  let mutationDebounce = null;
  let lastMutationAlert = 0;

  const recentClicks = new WeakMap();
  const recentInputs = new WeakMap();
  let inputDebounceTimer = null;
  let pendingInput = null;

  let fpsFrameCount = 0;
  let fpsLastSample = performance.now();
  let fpsRafId = null;

  function isContextAlive() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }
  function safeSendMessage(msg, cb) {
    if (!isContextAlive()) return;
    try { chrome.runtime.sendMessage(msg, cb); } catch (_) {}
  }

  function uuid() {
    return 'a-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now();
  }

  // ── FPS sampling ─────────────────────────────────────────────────
  function fpsTick() {
    if (!isRecording) { fpsRafId = null; return; }
    fpsFrameCount++;
    const now = performance.now();
    const elapsed = now - fpsLastSample;
    if (elapsed >= 1000) {
      fpsBuffer.push({
        timestamp: now, epoch: Date.now(),
        fps: Math.round((fpsFrameCount / elapsed) * 1000), url: location.href
      });
      fpsFrameCount = 0;
      fpsLastSample = now;
    }
    fpsRafId = requestAnimationFrame(fpsTick);
  }

  function startFPS() {
    if (fpsRafId) return;
    fpsFrameCount = 0;
    fpsLastSample = performance.now();
    fpsRafId = requestAnimationFrame(fpsTick);
  }

  function stopFPS() {
    if (fpsRafId) { cancelAnimationFrame(fpsRafId); fpsRafId = null; }
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && fpsRafId) {
      fpsFrameCount = 0;
      fpsLastSample = performance.now();
    }
  });

  // ── Selectors ─────────────────────────────────────────────────────
  function getCssSelector(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) return '#' + CSS.escape(el.id);
    const testId = el.getAttribute && el.getAttribute('data-testid');
    if (testId) return '[data-testid="' + testId + '"]';
    const name = el.getAttribute && el.getAttribute('name');
    if (name) return el.tagName.toLowerCase() + '[name="' + name + '"]';
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 5) {
      let seg = cur.tagName.toLowerCase();
      if (typeof cur.className === 'string' && cur.className.trim()) {
        seg += '.' + cur.className.trim().split(/\s+/).slice(0, 2).join('.');
      }
      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.prototype.slice.call(parent.children).filter(function (c) {
          return c.tagName === cur.tagName;
        });
        if (siblings.length > 1) seg += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
      }
      parts.unshift(seg);
      cur = parent;
    }
    return parts.join(' > ');
  }

  function getXPath(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) return '//*[@id="' + el.id + '"]';
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1) {
      let idx = 1;
      let sib = cur.previousElementSibling;
      while (sib) { if (sib.tagName === cur.tagName) idx++; sib = sib.previousElementSibling; }
      parts.unshift(cur.tagName.toLowerCase() + '[' + idx + ']');
      cur = cur.parentElement;
    }
    return '/' + parts.join('/');
  }

  function describe(el) {
    if (!el || el.nodeType !== 1) return {};
    
    let tag = el.tagName.toLowerCase();
    let idStr = el.id ? `#${el.id}` : '';
    let classStr = (typeof el.className === 'string' && el.className.trim()) 
                    ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') 
                    : '';
    let textStr = (el.innerText || '').slice(0, 30).replace(/\s+/g, ' ').trim();
    let valStr = (el.value !== undefined && el.value !== null && String(el.value).trim() !== '') 
                  ? `[val: ${String(el.value).slice(0, 20)}]` : '';
    let nameStr = (el.getAttribute && el.getAttribute('name')) ? `[name="${el.getAttribute('name')}"]` : '';

    let displayName = `${tag}${idStr}${classStr}`;
    if (valStr) displayName += ` ${valStr}`;
    else if (textStr) displayName += ` [${textStr}]`;
    else if (nameStr) displayName += `${nameStr}`;

    return {
      tag: el.tagName,
      id: el.id || null,
      name: (el.getAttribute && el.getAttribute('name')) || null,
      ariaLabel: (el.getAttribute && el.getAttribute('aria-label')) || null,
      role: (el.getAttribute && el.getAttribute('role')) || null,
      text: (el.innerText || '').slice(0, 80).replace(/\s+/g, ' ').trim(),
      value: (el.value !== undefined && el.value !== null) ? String(el.value).slice(0, 100) : null,
      selector: getCssSelector(el),
      xpath: getXPath(el),
      displayName: displayName
    };
  }

  function recordAction(type, evt, extra) {
    if (!isRecording) return;
    const el = evt.composedPath ? evt.composedPath()[0] : evt.target;
    const perfNow = performance.now();
    const epoch = Date.now();

    const targetDescription = describe(el);

    const entry = {
      id: uuid(),
      type: type,
      timestamp: perfNow,
      epoch: epoch,
      url: location.href,
      target: targetDescription,
      targetName: targetDescription.displayName || 'Unknown'
    };
    if (extra) {
      for (const k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) entry[k] = extra[k];
      }
    }

    const markId = 'action-' + entry.id;
    try { performance.mark(markId + '-start'); } catch (_) {}
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        try {
          performance.mark(markId + '-end');
          const m = performance.measure(markId, markId + '-start', markId + '-end');
          entry.duration = Math.round(m.duration);
          entry.paintLatency = Math.round(m.duration);
        } catch (_) {}
      });
    });

    actionBuffer.push(entry);
    if (actionBuffer.length > 60) flush();
  }

  function flush() {
    if (!actionBuffer.length && !vitalsBuffer.length && !fpsBuffer.length && !customMarksBuffer.length && !resourcesBuffer.length) return;
    if (!isContextAlive()) {
      actionBuffer = []; vitalsBuffer = []; fpsBuffer = []; customMarksBuffer = []; resourcesBuffer = [];
      return;
    }
    const payload = { 
      actions: actionBuffer, 
      vitals: vitalsBuffer, 
      fps: fpsBuffer,
      customMarks: customMarksBuffer,
      resources: resourcesBuffer
    };
    safeSendMessage({ target: 'content', type: 'CONTENT_BATCH', payload: payload });
    actionBuffer = [];
    vitalsBuffer = [];
    fpsBuffer = [];
    customMarksBuffer = [];
    resourcesBuffer = [];
  }

  function flushPendingInput() {
    if (!pendingInput) return;
    const el = pendingInput.target;
    const value = pendingInput.value;
    pendingInput = null;
    if (!el) return;
    recentInputs.set(el, Date.now());
    recordAction('INPUT', { composedPath: () => [el], target: el }, { value: value });
  }

  setInterval(flush, 150);
  window.addEventListener('beforeunload', function () {
    clearTimeout(inputDebounceTimer);
    flushPendingInput();
    flush();
  });
    // ── Observers for Custom Marks & Resource Timing ────────────────
   // ── Observers for Custom Marks & Resource Timing ────────────────
  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.entryType === 'mark') {
          customMarksBuffer.push({ name: e.name, startTime: e.startTime, type: 'mark' });
        } else if (e.entryType === 'measure') {
          customMarksBuffer.push({ name: e.name, startTime: e.startTime, duration: e.duration, type: 'measure' });
        }
      }
    }).observe({ entryTypes: ['mark', 'measure'] });
  } catch (_) {}

  function captureResources() {
    try {
      const entries = performance.getEntriesByType('resource');
      const existingNames = new Set(resourcesBuffer.map(r => r.name));
      
      entries.forEach(e => {
        const isCSS = e.initiatorType === 'link' || e.name.includes('.css');
        const isJS = e.initiatorType === 'script' || e.name.includes('.js');
        
        if ((isCSS || isJS) && !existingNames.has(e.name)) {
          resourcesBuffer.push({
            name: e.name,
            type: isCSS ? 'link' : 'script',
            startTime: e.startTime || 0,
            duration: e.duration || 0,
            transferSize: e.transferSize || 0
          });
        }
      });
    } catch (_) {}
  }

  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const isCSS = e.initiatorType === 'link' || e.name.includes('.css');
        const isJS = e.initiatorType === 'script' || e.name.includes('.js');
        
        if (isCSS || isJS) {
          resourcesBuffer.push({
            name: e.name,
            type: isCSS ? 'link' : 'script',
            startTime: e.startTime || 0,
            duration: e.duration || 0,
            transferSize: e.transferSize || 0
          });
        }
      }
    }).observe({ type: 'resource', buffered: true });
  } catch (_) {}
  // ── User action listeners ─────────────────────────────────────────
  const EVENTS = [
    'click', 'dblclick', 'contextmenu',
    'mousedown', 'mouseup',
    'input', 'change', 'submit',
    'keydown', 'focusin', 'focusout',
    'paste', 'copy', 'cut',
    'dragstart', 'dragend', 'drop'
  ];

  const SKIP_KEYDOWN_KEYS = ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock'];
  const MEANINGFUL_KEYS = ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete'];
  const INPUT_TAGS = { INPUT: 1, TEXTAREA: 1, SELECT: 1 };

  function isInputElement(el) {
    if (!el || el.nodeType !== 1) return false;
    if (INPUT_TAGS[el.tagName]) return true;
    return !!el.isContentEditable;
  }

  EVENTS.forEach(function (evt) {
    document.addEventListener(evt, function (e) {
      if (!isRecording) return;

      if (evt === 'keydown') {
        if (SKIP_KEYDOWN_KEYS.indexOf(e.key) !== -1) return;
        if (e.ctrlKey || e.metaKey) return;
        if (MEANINGFUL_KEYS.indexOf(e.key) === -1) return;
        recordAction(e.key.toUpperCase(), e);
        return;
      }

      if (evt === 'input') {
        const el = e.target;
        pendingInput = { target: el, value: el.value };
        clearTimeout(inputDebounceTimer);
        inputDebounceTimer = setTimeout(flushPendingInput, 500);
        return;
      }

      if (evt === 'change') {
        const el = e.target;
        const lastInput = recentInputs.get(el);
        if (lastInput && Date.now() - lastInput < 1500) return;
        recordAction('CHANGE', e);
        return;
      }

      if (evt === 'focusin') {
        const el = e.target;
        if (!isInputElement(el)) return;
        const lastClick = recentClicks.get(el);
        if (lastClick && Date.now() - lastClick < 300) return;
        recordAction('FOCUSIN', e);
        return;
      }

      if (evt === 'focusout') {
        const el = e.target;
        if (!isInputElement(el)) return;
        if (pendingInput && pendingInput.target === el) {
          clearTimeout(inputDebounceTimer);
          flushPendingInput();
        }
        recordAction('FOCUSOUT', e);
        return;
      }

      if (evt === 'mousedown' || evt === 'mouseup') {
        if (e.target.tagName !== 'SELECT') return;
        recordAction(evt.toUpperCase(), e);
        return;
      }

      if (evt === 'click') {
        recentClicks.set(e.target, Date.now());
        recordAction('CLICK', e);
        return;
      }

      recordAction(evt.toUpperCase(), e);
    }, { capture: true, passive: true });
  });

  let lastScroll = 0;
  document.addEventListener('scroll', function (e) {
    const now = performance.now();
    if (now - lastScroll < 200) return;
    lastScroll = now;
    recordAction('SCROLL', e, { scrollY: window.scrollY, scrollX: window.scrollX });
  }, { capture: true, passive: true });

  // ── SPA route changes ─────────────────────────────────────────────
  ['pushState', 'replaceState'].forEach(function (fn) {
    const orig = history[fn];
    history[fn] = function () {
      const result = orig.apply(this, arguments);
      if (isRecording) {
        recordAction('SPA_ROUTE_CHANGE',
          { target: null, composedPath: function () { return [null]; } },
          { newUrl: location.href });
        flush();
      }
      return result;
    };
  });
  window.addEventListener('popstate', function () {
    if (isRecording) {
      recordAction('NAV_BACK',
        { target: null, composedPath: function () { return [null]; } },
        { newUrl: location.href });
      flush();
    }
  });

  // ── Web Vitals ────────────────────────────────────────────────────
  function emitVital(name, value, extra) {
    if (!isRecording) return;
    const entry = {
      name: name, value: value, url: location.href,
      timestamp: performance.now(), epoch: Date.now()
    };
    if (extra) {
      for (const k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) entry[k] = extra[k];
      }
    }
    vitalsBuffer.push(entry);
  }

  try {
    new PerformanceObserver(function (list) {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) emitVital('LCP', last.startTime, { element: describe(last.element) });
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (_) {}

  try {
    new PerformanceObserver(function (list) {
      const entries = list.getEntries();
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].name === 'first-paint') emitVital('FP', entries[i].startTime);
        if (entries[i].name === 'first-contentful-paint') emitVital('FCP', entries[i].startTime);
      }
    }).observe({ type: 'paint', buffered: true });
  } catch (_) {}

  try {
    let cls = 0;
    new PerformanceObserver(function (list) {
      const entries = list.getEntries();
      for (let i = 0; i < entries.length; i++) {
        if (!entries[i].hadRecentInput) cls += entries[i].value;
      }
      emitVital('CLS', cls);
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (_) {}

  try {
    new PerformanceObserver(function (list) {
      const entries = list.getEntries();
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const attrs = e.attribution || [];
        const a0 = attrs[0] || {};
        emitVital('LONGTASK', e.duration, {
          startTime: e.startTime,
          name: e.name,
          attribution: {
            containerType: a0.containerType || '',
            containerName: a0.containerName || '',
            containerSrc: a0.containerSrc || '',
            containerId: a0.containerId || ''
          }
        });
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch (_) {}

  try {
    new PerformanceObserver(function (list) {
      const entries = list.getEntries();
      for (let i = 0; i < entries.length; i++) {
        emitVital('INP_EVENT', entries[i].duration, { name: entries[i].name });
      }
    }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
  } catch (_) {}

  try {
    new PerformanceObserver(function (list) {
      const entries = list.getEntries();
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        emitVital('ELEMENT_TIMING', e.duration, {
          identifier: e.identifier || 'unnamed',
          renderTime: e.renderTime, loadTime: e.loadTime,
          url: e.url ? e.url.slice(0, 150) : '', element: e.element ? e.element.tagName : 'Unknown'
        });
      }
    }).observe({ type: 'element', buffered: true });
  } catch (_) {}

  window.addEventListener('load', function () {
    setTimeout(function () {
      const nav = performance.getEntriesByType('navigation')[0];
      if (!nav) return;
      emitVital('TTFB', nav.responseStart);
      emitVital('DOM_INTERACTIVE', nav.domInteractive);
      emitVital('DOM_CONTENT_LOADED', nav.domContentLoadedEventEnd);
      emitVital('LOAD_COMPLETE', nav.loadEventEnd);
    }, 0);
  });

  // ── MutationObserver ──────────────────────────────────────────────
  function describeMutation(mutations) {
    let hasDialog = false, hasDropdown = false, addedNodes = 0;
    let biggest = null, biggestSize = 0;

    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i];
      addedNodes += m.addedNodes ? m.addedNodes.length : 0;
      if (!m.addedNodes) continue;
      for (let j = 0; j < m.addedNodes.length; j++) {
        const n = m.addedNodes[j];
        if (n.nodeType !== 1) continue;
        const el = n;
        const role = el.getAttribute && el.getAttribute('role');
        const cls = (el.className && typeof el.className === 'string') ? el.className.toLowerCase() : '';

        if (role === 'dialog' || role === 'alertdialog' || role === 'alert' ||
            (el.hasAttribute && el.hasAttribute('aria-modal')) ||
            cls.indexOf('modal') !== -1 || cls.indexOf('dialog') !== -1 ||
            cls.indexOf('popup') !== -1 || cls.indexOf('overlay') !== -1) {
          hasDialog = true;
          if (biggestSize < 10000) biggestSize = 10000;
        }

        if (role === 'listbox' || role === 'menu' || role === 'option' ||
            cls.indexOf('dropdown') !== -1 || cls.indexOf('menu') !== -1 ||
            cls.indexOf('autocomplete') !== -1 || cls.indexOf('select-') !== -1 ||
            cls.indexOf('typeahead') !== -1) {
          hasDropdown = true;
        }

        const childCount = el.querySelectorAll ? el.querySelectorAll('*').length : 1;
        if (childCount > biggestSize) { biggestSize = childCount; biggest = el; }
      }
    }

    if (hasDialog) {
      const txt = biggest ? (biggest.innerText || '').slice(0, 120).replace(/\s+/g, ' ').trim() : '';
      return { kind: 'modal', detail: txt ? 'Modal: ' + txt : 'Modal appeared' };
    }
    if (hasDropdown) return { kind: 'dropdown', detail: 'Dropdown opened' };
    if (addedNodes > 5) {
      const txt = biggest ? (biggest.innerText || '').slice(0, 120).replace(/\s+/g, ' ').trim() : '';
      return { kind: 'dom-change', detail: txt ? 'DOM update: ' + txt : 'Page content updated' };
    }
    return null;
  }

  try {
    const observer = new MutationObserver(function (mutations) {
      if (!isRecording) return;
      const info = describeMutation(mutations);
      if (!info) return;
      const now = Date.now();
      if (now - lastMutationAlert < 5000) return;
      lastMutationAlert = now;
      clearTimeout(mutationDebounce);
      mutationDebounce = setTimeout(function () {
        safeSendMessage({
          target: 'content', type: 'MUTATION_ALERT',
          kind: info.kind, detail: info.detail
        });
      }, 250);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}

  // ── Listen for recording state ────────────────────────────────────
  if (isContextAlive()) {
    try {
      chrome.runtime.onMessage.addListener(function (msg) {
        if (!msg || msg.target !== 'content') return;
        if (msg.type === 'RECORDING_STARTED') {
          isRecording = true;
          startFPS();
          captureResources();
        } else if (msg.type === 'RECORDING_STOPPED') {
          clearTimeout(inputDebounceTimer);
          stopFPS();
          flushPendingInput();
          flush();
          isRecording = false;
        }
      });
    } catch (_) {}
  }

  if (isContextAlive()) {
    try {
      chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATUS' }, function (res) {
        if (isContextAlive() && res && res.recording) {
          isRecording = true;
          startFPS();
        }
      });
    } catch (_) {}
  }

  setInterval(function () {
    if (!isContextAlive()) {
      actionBuffer = []; vitalsBuffer = []; fpsBuffer = []; customMarksBuffer = []; resourcesBuffer = [];
      isRecording = false;
      stopFPS();
    }
  }, 5000);

})();