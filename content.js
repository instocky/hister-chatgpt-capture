// content.js — runs at document_idle on chatgpt.com/c/*
//
// Responsibilities (per docs/PRD-chatgpt-ext.md F1-F14, docs/Handoff.md):
//   - DOM extraction via [data-message-author-role]
//   - empty-message filter
//   - extract-once: build messages[] ONCE, then derive text + hash from the same array
//   - 3s debounce after the last relevant DOM mutation
//   - chrome.runtime.sendMessage to service_worker.js
//
// Hard rules:
//   - innerText called EXACTLY once per node (F4 / §15 spike).
//   - NO network calls. NO storage. NO Origin header (MV3 forbids; Chrome sets it).
//   - MutationObserver on document.body with re-attach on root replace (F12).
//   - url = location.origin + location.pathname (F13).

(() => {
  'use strict';

  const SELECTOR = '[data-message-author-role]';
  const DEBOUNCE_MS = 3000;
  const ROLE_USER = 'user';
  const ROLE_ASSISTANT = 'assistant';

  let debounceTimer = null;
  let observer = null;
  let observedBody = null;

  /**
   * Build messages[] exactly once. innerText is called once per node.
   * Returns { messages, text, messageCount } or null when there are no usable messages.
   */
  function extractOnce() {
    const nodes = document.querySelectorAll(SELECTOR);
    if (!nodes || nodes.length === 0) return null;

    const messages = [];
    for (const el of nodes) {
      const role = el.getAttribute('data-message-author-role');
      if (role !== ROLE_USER && role !== ROLE_ASSISTANT) continue;
      const text = el.innerText.trim();
      if (text.length === 0) continue;
      messages.push({ role, text });
    }
    if (messages.length === 0) return null;

    const text = messages
      .map(m => `[${m.role.toUpperCase()}] ${m.text}`)
      .join('\n');

    return { messages, text, messageCount: messages.length };
  }

  /** SHA-256 hex via Web Crypto. Async. */
  async function sha256Hex(input) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function canonicalUrl() {
    return location.origin + location.pathname;
  }

  function conversationId() {
    // /c/<uuid> -> uuid. Fallback: 'unknown'.
    const m = location.pathname.match(/^\/c\/([0-9a-f-]+)/i);
    return m ? m[1] : 'unknown';
  }

  async function dispatchCapture(reason) {
    const ext = extractOnce();
    if (!ext) return;

    // F6: hash source = messages[].text from F4. Never re-extracts.
    const hashInput = ext.messages.map(m => `${m.role}:${m.text}`).join('\n---\n');
    const hash = await sha256Hex(hashInput);

    const payload = {
      type: 'CHATGPT_CAPTURE',
      url: canonicalUrl(),
      title: document.title,
      text: ext.text,
      label: 'chatgpt',
      metadata: {
        source: 'chatgpt',
        conversation_id: conversationId(),
        message_count: ext.messageCount,
      },
      hash,
      messageCount: ext.messageCount,
      reason,
    };

    try {
      await chrome.runtime.sendMessage(payload);
    } catch (err) {
      // SW may be inactive or unload mid-send. Next MO tick will re-fire.
      console.debug('[hister-capture] sendMessage failed:', err && err.message);
    }
  }

  function scheduleCapture(reason) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      dispatchCapture(reason).catch(err =>
        console.debug('[hister-capture] dispatch failed:', err && err.message)
      );
    }, DEBOUNCE_MS);
  }

  function attachObserver() {
    if (observer) observer.disconnect();
    if (!document.body) {
      setTimeout(attachObserver, 50);
      return;
    }
    observedBody = document.body;
    observer = new MutationObserver(() => {
      // F12: re-attach if document.body was replaced by SPA navigation.
      if (document.body !== observedBody) {
        attachObserver();
        return;
      }
      scheduleCapture('mutation');
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function init() {
    attachObserver();
    // Initial settle capture (covers page load before any MO tick).
    scheduleCapture('initial');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
