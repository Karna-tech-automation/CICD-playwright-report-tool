/**
 * Perf-Trace-Pulse — Redaction utility
 * Removes sensitive headers, URL params, and body fields before storage/export.
 * Works both in the MV3 service worker (self) and in the panel (window).
 */

(function (global) {
  'use strict';

  const DEFAULT_SENSITIVE_HEADERS = [
    'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
    'x-api-key', 'api-key', 'apikey', 'x-auth-token', 'auth-token',
    'x-access-token', 'access-token', 'x-csrf-token', 'x-xsrf-token',
    'x-session-token', 'session-token', 'x-amz-security-token', 'private-token'
  ];

  const DEFAULT_SENSITIVE_QUERY = [
    'token', 'access_token', 'refresh_token', 'id_token',
    'api_key', 'apikey', 'key', 'secret',
    'password', 'passwd', 'pwd',
    'auth', 'authorization',
    'session', 'sessionid', 'sid'
  ];

  const DEFAULT_SENSITIVE_BODY_KEYS = [
    'password', 'passwd', 'pwd',
    'token', 'access_token', 'refresh_token', 'id_token',
    'api_key', 'apikey', 'secret',
    'authorization', 'auth',
    'credit_card', 'creditcard', 'cvv', 'ssn'
  ];

  const REDACTED = '[REDACTED]';
  const REDACTED_ENCODED = /%5BREDACTED%5D/gi;

  const config = {
    headers: DEFAULT_SENSITIVE_HEADERS.slice(),
    query: DEFAULT_SENSITIVE_QUERY.slice(),
    bodyKeys: DEFAULT_SENSITIVE_BODY_KEYS.slice(),
    redactBodies: true
  };

  function setConfig(next) {
    if (!next || typeof next !== 'object') return;
    if (Array.isArray(next.headers)) config.headers = next.headers.map(s => String(s).toLowerCase());
    if (Array.isArray(next.query)) config.query = next.query.map(s => String(s).toLowerCase());
    if (Array.isArray(next.bodyKeys)) config.bodyKeys = next.bodyKeys.map(s => String(s).toLowerCase());
    if (typeof next.redactBodies === 'boolean') config.redactBodies = next.redactBodies;
  }

  function getConfig() {
    return {
      headers: config.headers.slice(),
      query: config.query.slice(),
      bodyKeys: config.bodyKeys.slice(),
      redactBodies: config.redactBodies
    };
  }

  function isSensitiveHeader(name) {
    if (!name) return false;
    return config.headers.indexOf(String(name).toLowerCase()) !== -1;
  }

  function redactHeaders(headers) {
    if (!headers || typeof headers !== 'object') return headers;
    const out = {};
    for (const k of Object.keys(headers)) {
      out[k] = isSensitiveHeader(k) ? REDACTED : headers[k];
    }
    return out;
  }

  function redactUrl(url) {
    if (!url || typeof url !== 'string') return url;
    try {
      const u = new URL(url);
      let changed = false;
      for (const key of Array.from(u.searchParams.keys())) {
        if (config.query.indexOf(key.toLowerCase()) !== -1) {
          u.searchParams.set(key, REDACTED);
          changed = true;
        }
      }
      return changed ? u.toString().replace(REDACTED_ENCODED, REDACTED) : url;
    } catch (_) {
      return url;
    }
  }

  function redactJsonValue(value, depth) {
    if (depth > 8) return value;
    if (Array.isArray(value)) return value.map(v => redactJsonValue(v, depth + 1));
    if (value && typeof value === 'object') {
      const out = {};
      for (const k of Object.keys(value)) {
        if (config.bodyKeys.indexOf(k.toLowerCase()) !== -1) out[k] = REDACTED;
        else out[k] = redactJsonValue(value[k], depth + 1);
      }
      return out;
    }
    return value;
  }

  function redactBody(text) {
    if (!config.redactBodies) return text;
    if (!text || typeof text !== 'string') return text;
    const trimmed = text.trim();
    if (!trimmed) return text;

    // JSON body
    if (trimmed[0] === '{' || trimmed[0] === '[') {
      try {
        const parsed = JSON.parse(trimmed);
        return JSON.stringify(redactJsonValue(parsed, 0));
      } catch (_) {
        return text;
      }
    }

    // x-www-form-urlencoded body — handles single-field bodies too
    if (trimmed.indexOf('=') !== -1) {
      try {
        const params = new URLSearchParams(trimmed);
        let changed = false;
        for (const key of Array.from(params.keys())) {
          if (config.bodyKeys.indexOf(key.toLowerCase()) !== -1) {
            params.set(key, REDACTED);
            changed = true;
          }
        }
        if (!changed) return text;
        return params.toString().replace(REDACTED_ENCODED, REDACTED);
      } catch (_) {
        return text;
      }
    }

    return text;
  }

  /**
   * Applies all redactions to a network request object in place.
   * Safe to call multiple times (idempotent).
   */
  function redactRequest(req) {
    if (!req || typeof req !== 'object') return req;
    if (req.url) req.url = redactUrl(req.url);
    if (req.requestHeaders) req.requestHeaders = redactHeaders(req.requestHeaders);
    if (req.responseHeaders) req.responseHeaders = redactHeaders(req.responseHeaders);
    if (req.postData) req.postData = redactBody(req.postData);
    if (req.responseBody) req.responseBody = redactBody(req.responseBody);
    return req;
  }

  global.PerfRedaction = {
    setConfig: setConfig,
    getConfig: getConfig,
    redactHeaders: redactHeaders,
    redactUrl: redactUrl,
    redactBody: redactBody,
    redactRequest: redactRequest,
    REDACTED: REDACTED,
    DEFAULT_SENSITIVE_HEADERS: DEFAULT_SENSITIVE_HEADERS,
    DEFAULT_SENSITIVE_QUERY: DEFAULT_SENSITIVE_QUERY,
    DEFAULT_SENSITIVE_BODY_KEYS: DEFAULT_SENSITIVE_BODY_KEYS
  };
})(typeof self !== 'undefined' ? self : this);