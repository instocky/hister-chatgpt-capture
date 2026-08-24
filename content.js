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

  const SCROLL_STEP_PAUSE_MS = 200;
  const SCROLL_MAX_STEPS = 50;
  const SCROLL_NO_GROW_LIMIT = 3;

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
    return location.origin + location.pathname;
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

  /**
   * Manual capture: progressive scroll-march to materialize all messages,
   * then extract + dispatch. Stops when DOM message count stops growing
   * for SCROLL_NO_GROW_LIMIT consecutive steps, or after SCROLL_MAX_STEPS.
   * Restores the user's scroll position when done.
   */
  async function materializeAndCapture() {
    console.log('[hister-capture] materializeAndCapture: starting scroll-march');
    const savedScrollY = window.scrollY;
    let lastTotal = document.querySelectorAll(SELECTOR).length;
    let noGrowSteps = 0;

    // Start from top so we materialize messages in order.
    window.scrollTo(0, 0);
    await sleep(SCROLL_STEP_PAUSE_MS * 2);

    for (let step = 0; step < SCROLL_MAX_STEPS; step++) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(SCROLL_STEP_PAUSE_MS);
      const curTotal = document.querySelectorAll(SELECTOR).length;
      if (curTotal > lastTotal) {
        noGrowSteps = 0;
        lastTotal = curTotal;
      } else {
        noGrowSteps++;
        if (noGrowSteps >= SCROLL_NO_GROW_LIMIT) break;
      }
    }

    console.log('[hister-capture] materializeAndCapture: settled at totalNodes=' + lastTotal);

    await dispatchCapture('manual');

    // Restore the user's scroll position so we don't yank them around.
    window.scrollTo(0, savedScrollY);
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
