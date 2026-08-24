// content.js — runs at document_idle on chatgpt.com/c/*
//
// Responsibilities (per docs/PRD-chatgpt-ext.md F1-F14, docs/Handoff.md):
//   - DOM extraction via [data-message-author-role]
//   - empty-message filter
//   - extract-once: build messages[] ONCE, then derive text + hash from the same array
//   - chrome.runtime.sendMessage to service_worker.js
//   - manual capture (scroll-march) triggered by popup click
//
// Hard rules:
//   - innerText called EXACTLY once per node (F4 / §15 spike).
//   - NO network calls. NO storage. NO Origin header (MV3 forbids; Chrome sets it).
//   - url = location.origin + location.pathname (F13).
//
// v0.2 — capture strategy changed from auto-on-mutation to manual-only
// (with single-shot initial settle). Reason: scroll-induced DOM materialization
// on long ChatGPT threads causes the lazy-loaded messages to be re-hashed on
// every scroll tick, which overwrites the Hister doc with intermediate state
// instead of a settled snapshot. Manual trigger from popup forces a full
// scroll-march first, then captures the complete message set. See
// docs/Handoff.md "Capture strategy" for the design rationale.

(() => {
  'use strict';

  const SELECTOR = '[data-message-author-role]';
  const ROLE_USER = 'user';
  const ROLE_ASSISTANT = 'assistant';

  let autoCaptureDone = false;

  /**
   * Build messages[] exactly once. innerText is called once per node.
   * Returns { messages, text, messageCount } or null when there are no usable messages.
   */
  function extractOnce() {
    const nodes = document.querySelectorAll(SELECTOR);
    const totalNodes = nodes ? nodes.length : 0;
    if (!nodes || totalNodes === 0) {
      console.log('[hister-capture] extractOnce: 0 nodes for selector', SELECTOR);
      return null;
    }

    const messages = [];
    let skippedRole = 0;
    let skippedEmpty = 0;
    for (const el of nodes) {
      const role = el.getAttribute('data-message-author-role');
      if (role !== ROLE_USER && role !== ROLE_ASSISTANT) { skippedRole++; continue; }
      const text = el.innerText.trim();
      if (text.length === 0) { skippedEmpty++; continue; }
      messages.push({ role, text });
    }
    console.log('[hister-capture] extractOnce:', {
      totalNodes, kept: messages.length, skippedRole, skippedEmpty,
    });
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
    // Strip trailing slash so canonicalization is stable across chatgpt
    // redirects that may or may not add one. chrome.storage keys must
    // match between content.js (writer) and popup.js (reader).
    return (location.origin + location.pathname).replace(/\/+$/, '');
  }

  function conversationId() {
    // /c/<uuid> -> uuid. Fallback: 'unknown'.
    const m = location.pathname.match(/^\/c\/([0-9a-f-]+)/i);
    return m ? m[1] : 'unknown';
  }

  async function dispatchCapture(reason) {
    const ext = extractOnce();
    if (!ext) {
      console.log('[hister-capture] dispatchCapture: no extractable messages, skip (reason=' + reason + ')');
      return;
    }

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

    console.log('[hister-capture] dispatchCapture: sending', {
      reason, url: payload.url, messageCount: payload.messageCount, hash: hash.slice(0, 12) + '…',
    });

    try {
      const res = await chrome.runtime.sendMessage(payload);
      console.log('[hister-capture] dispatchCapture: SW response', res);
    } catch (err) {
      console.log('[hister-capture] sendMessage failed:', err && err.message);
    }
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // Unused but kept for future use: scrollable-element detection for sites
  // that DO materialize on scroll (non-chatgpt SPAs). chatgpt.com
  // virtualizes the thread and does not respond to scroll-based materialization
  // (see materializeAndCapture() for the full discussion).
  function findScrollable() {
    const ds = document.scrollingElement;
    if (ds && ds.scrollHeight > ds.clientHeight + 1) return ds;
    const main = document.querySelector('main');
    if (main && main.scrollHeight > main.clientHeight + 1) return main;
    const all = document.querySelectorAll('main, section, div, [role="main"]');
    for (const el of all) {
      const cs = getComputedStyle(el);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
          el.scrollHeight > el.clientHeight + 1) return el;
    }
    return document.body;
  }

  /**
   * Manual capture: dispatch on whatever messages are currently in the DOM.
   *
   * We deliberately do NOT scroll-march or call scrollIntoView. chatgpt.com
   * virtualizes the thread and only mounts messages in the current viewport
   * (+ a small buffer); an instant scrollTop jump does not trigger chatgpt's
   * progressive render, and scrollIntoView is a no-op for messages that are
   * not yet in the DOM. Trying to force-materialize the full thread makes
   * things worse: a partial capture (6 messages) overwrites a previous
   * fuller capture (14 messages) in Hister because the hashes differ.
   *
   * Instead, the user controls when to capture: scroll the thread to the
   * position they want, then click the popup button. capture is a snapshot
   * of the DOM at that moment. Documented limitation: only messages that
   * chatgpt has currently mounted are captured. For full-thread capture
   * the user should scroll to top, let chatgpt stream-mount messages,
   * then capture (note: chatgpt unmounts off-viewport messages, so even
   * scrolling through captures a window, not the full thread).
   */
  async function materializeAndCapture() {
    console.log('[hister-capture] materializeAndCapture: capturing current DOM (no scroll-march)');
    const currentTotal = document.querySelectorAll(SELECTOR).length;
    console.log('[hister-capture] current totalNodes=' + currentTotal);
    await dispatchCapture('manual');
  }

  // Listen for manual trigger from popup.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return false;
    if (msg.type === 'MATERIALIZE_AND_CAPTURE') {
      materializeAndCapture()
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err && err.message || String(err) }));
      return true; // async response
    }
    return false;
  });

  /**
   * v0.2 capture strategy:
   *   - No MutationObserver-driven capture. Scroll-induced materialization
   *     on long threads was causing intermediate-state overwrites.
   *   - Single initial settle capture (best-effort, may be partial).
   *   - Manual capture via popup button forces full scroll-march.
   */
  function init() {
    console.log('[hister-capture] init on', location.href);
    if (!autoCaptureDone) {
      autoCaptureDone = true;
      // Best-effort initial capture; user can force full via popup.
      dispatchCapture('initial');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
