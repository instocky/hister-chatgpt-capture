// service_worker.js — MV3 background script
//
// Responsibilities (per docs/PRD-chatgpt-ext.md §5 + docs/Handoff.md):
//   - network I/O to Hister POST /api/add
//   - retry 3x with 2s backoff within SW lifetime (F11)
//   - chrome.storage.local dedupe keyed by URL (F10)
//   - per-tab action badge (idle / capturing / OK / ERR) (F15)
//
// Hard rules:
//   - Do NOT set Origin header manually (MV3 forbids; Chrome sets chrome-extension://<id>).
//   - SW lifetime is not guaranteed by MV3. Full persistent retry via chrome.alarms is v2.
//   - hash dedupe uses content-supplied hash (F6). SW does not re-extract from DOM.

(() => {
  'use strict';

  const HISTER_ADD_URL = 'http://127.0.0.1:4433/api/add';
  const MAX_RETRIES = 3;
  const RETRY_BACKOFF_MS = 2000;

  const BADGE_COLOR_OK = '#3a3';
  const BADGE_COLOR_ERR = '#d33';
  const BADGE_COLOR_CAPTURING = '#fa3';

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return false;

    if (msg.type === 'CHATGPT_CAPTURE') {
      handleCapture(msg, sender)
        .then(result => sendResponse({ ok: true, ...result }))
        .catch(err => sendResponse({ ok: false, error: err && err.message || String(err) }));
      return true; // async response
    }

    if (msg.type === 'GET_STATUS') {
      getStatus(msg.url).then(sendResponse);
      return false;
    }

    return false;
  });

  async function handleCapture(msg, sender) {
    const { url, hash, messageCount, title, text, label, metadata } = msg;

    if (!url || !hash) {
      setBadge(sender && sender.tab && sender.tab.id, '!', BADGE_COLOR_ERR);
      throw new Error('missing url or hash');
    }

    // F10: dedupe by URL.
    const stored = await chrome.storage.local.get([url]);
    if (stored[url] && stored[url].hash === hash) {
      setBadge(sender && sender.tab && sender.tab.id, 'OK', BADGE_COLOR_OK);
      return { skipped: true, reason: 'hash-unchanged' };
    }

    setBadge(sender && sender.tab && sender.tab.id, '...', BADGE_COLOR_CAPTURING);

    // F8: POST body shape, explicit Content-Type. NO Origin header.
    const body = JSON.stringify({ url, title, text, label, metadata });

    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(HISTER_ADD_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body,
        });
        if (res.status >= 200 && res.status < 300) {
          await chrome.storage.local.set({
            [url]: {
              hash,
              updatedAt: Date.now(),
              messageCount,
              conversationId: metadata && metadata.conversation_id,
            },
          });
          setBadge(sender && sender.tab && sender.tab.id, 'OK', BADGE_COLOR_OK);
          return { ok: true, attempt };
        }
        lastErr = new Error('HTTP ' + res.status);
      } catch (err) {
        lastErr = err;
      }
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF_MS);
      }
    }

    setBadge(sender && sender.tab && sender.tab.id, 'ERR', BADGE_COLOR_ERR);
    throw lastErr || new Error('capture failed after retries');
  }

  async function getStatus(url) {
    if (!url) return { state: 'idle' };
    const stored = await chrome.storage.local.get([url]);
    const entry = stored[url];
    if (!entry) return { state: 'idle', url };
    return {
      state: 'OK',
      url,
      hash: entry.hash,
      updatedAt: entry.updatedAt,
      messageCount: entry.messageCount,
      conversationId: entry.conversationId,
    };
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function setBadge(tabId, text, color) {
    if (typeof tabId !== 'number') return;
    try {
      chrome.action.setBadgeText({ tabId, text });
      chrome.action.setBadgeBackgroundColor({ tabId, color });
    } catch (_) {
      // Tab may be gone; ignore.
    }
  }
})();
