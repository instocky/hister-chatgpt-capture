// content.js — runs at document_idle on chatgpt.com/c/*
//
// Responsibilities (per docs/PRD-chatgpt-ext.md F1-F14, docs/Handoff.md):
//   - DOM extraction via [data-message-author-role]
//   - full-thread capture via proven Phase 2.0 scroll-march algorithm
//     (see c:\Projects\Common\0824\phases.md PHASE 2.0 + report):
//       TOP -> capture -> scroll -> capture -> dedup by fingerprint -> BOTTOM -> sort by Y
//   - chrome.runtime.sendMessage to service_worker.js
//   - manual capture only, triggered by popup button click
//
// v0.3 — capture strategy:
//   - Saving is MANUAL ONLY (popup "Capture this thread" button). No MutationObserver,
//     no auto-capture on load (auto snapshot of the top window would produce a partial
//     hash that differs from a full capture and overwrite the canonical Hister doc on
//     reload; the proven algorithm captures the WHOLE thread, so hashes are stable).
//   - The button runs the full scroll-march from the dev-console probe (Phase 2.0):
//     it walks TOP->BOTTOM with a stepwise scroll, capturing each DOM window, de-dups
//     by fingerprint (SHA256 of role + text + attachments), then orders by Y.
//   - Identities: role + text + attachments (Y is ORDER ONLY — a message can have
//     multiple DOM representations with slightly different Y).
//
// Hard rules:
//   - NO network calls. NO storage. NO Origin header (MV3 forbids; Chrome sets it).
//   - url = location.origin + location.pathname (F13), trailing slash stripped.

(() => {
  'use strict';

  const SELECTOR = '[data-message-author-role]';

  const CFG = {
    scrollStepPx: 900,
    settleMs: 1000,
    pollMs: 250,
    stablePasses: 3,
    maxTopAttempts: 20,
    maxSteps: 1000,
    maxNoMoveSteps: 5,
    topTolerancePx: 5,
    bottomTolerancePx: 5,
    yTolerancePx: 2,
  };

  // Single-flight guard: prevent overlapping captures.
  let captureInProgress = false;
  // Resolved lazily on first capture (re-find each capture to survive DOM swaps).
  let scroller = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const cleanText = (text) => (text || '').replace(/\s+/g, ' ').trim();

  /** SHA-256 hex via Web Crypto. */
  async function sha256Hex(input) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function canonicalUrl() {
    // Strip trailing slash so canonicalization is stable across chatgpt redirects.
    return (location.origin + location.pathname).replace(/\/+$/, '');
  }

  function conversationId() {
    const m = location.pathname.match(/^\/c\/([0-9a-f-]+)/i);
    return m ? m[1] : 'unknown';
  }

  // ------------------------------------------------------------------
  // SCROLLER — find the element that actually scrolls the thread.
  // chatgpt.com scrolls a custom DIV, not the window. Phase 1.2/2.0
  // proved [data-scroll-root] (or the most-scrollable element) is it.
  // ------------------------------------------------------------------
  function findScroller() {
    const explicit = document.querySelector('[data-scroll-root]');
    if (explicit && explicit.scrollHeight > explicit.clientHeight) return explicit;

    const candidates = [
      document.scrollingElement,
      document.documentElement,
      document.body,
      ...document.querySelectorAll('*'),
    ];

    let best = null;
    let bestScrollable = 0;
    for (const el of candidates) {
      if (!el) continue;
      const scrollable = el.scrollHeight - el.clientHeight;
      if (scrollable > bestScrollable) {
        bestScrollable = scrollable;
        best = el;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------
  // GEOMETRY — absolute Y inside the scroll content.
  //   y = elementRect.top - scrollerRect.top + scroller.scrollTop
  // ------------------------------------------------------------------
  function getGeometry(el) {
    const rect = el.getBoundingClientRect();
    const rootRect = scroller.getBoundingClientRect();
    const y = rect.top - rootRect.top + scroller.scrollTop;
    return {
      y: +y.toFixed(2),
      width: +rect.width.toFixed(2),
      height: +rect.height.toFixed(2),
      bottom: +(y + rect.height).toFixed(2),
    };
  }

  // ------------------------------------------------------------------
  // ATTACHMENTS — forensic extraction used ONLY for identity/dedup.
  // Hister text stays role+text (PRD non-goals: no image/file extraction).
  // ------------------------------------------------------------------
  function extractAttachmentId(value) {
    if (!value) return null;
    try {
      const url = new URL(value, location.origin);
      const id = url.searchParams.get('id');
      if (id) return id;
    } catch (_) { /* ignore */ }
    const match = String(value).match(/[?&]id=(file_[A-Za-z0-9_-]+)/i);
    return match ? match[1] : null;
  }

  function extractImages(messageNode) {
    const result = [];
    for (const img of messageNode.querySelectorAll('img')) {
      const geometry = getGeometry(img);
      // Skip tiny UI icons (avatars, decorations). Keep real images.
      if (geometry.width < 40 && geometry.height < 40) continue;
      const src = img.getAttribute('src') || null;
      const alt = cleanText(img.getAttribute('alt') || '') || null;
      const filename =
        img.getAttribute('data-file-name') ||
        img.getAttribute('data-filename') ||
        img.getAttribute('filename') ||
        null;
      result.push({ type: 'image', id: extractAttachmentId(src), src, alt, filename, y: geometry.y });
    }
    return result;
  }

  function extractFiles(messageNode) {
    const result = [];
    for (const link of messageNode.querySelectorAll('a[download]')) {
      const href = link.getAttribute('href');
      if (!href) continue;
      const filename =
        link.getAttribute('download') ||
        cleanText(link.innerText || link.textContent || '') ||
        null;
      result.push({ type: 'file', id: extractAttachmentId(href), href, filename, y: getGeometry(link).y });
    }
    const selectors = ['[data-file-name]', '[data-file-type]'];
    for (const selector of selectors) {
      for (const el of messageNode.querySelectorAll(selector)) {
        if (el.matches('a[download]')) continue; // already captured above
        const filename =
          el.getAttribute('data-file-name') ||
          el.getAttribute('data-filename') ||
          null;
        const fileType = el.getAttribute('data-file-type') || null;
        const href = el.getAttribute('href') || null;
        result.push({ type: 'file', id: extractAttachmentId(href), href, filename, fileType, y: getGeometry(el).y });
      }
    }
    return result;
  }

  function extractVideos(messageNode) {
    const result = [];
    for (const video of messageNode.querySelectorAll('video')) {
      const geometry = getGeometry(video);
      result.push({
        type: 'video',
        src: video.getAttribute('src') || null,
        poster: video.getAttribute('poster') || null,
        width: geometry.width,
        height: geometry.height,
        y: geometry.y,
      });
    }
    return result;
  }

  function extractAudio(messageNode) {
    const result = [];
    for (const audio of messageNode.querySelectorAll('audio')) {
      result.push({ type: 'audio', src: audio.getAttribute('src') || null, y: getGeometry(audio).y });
    }
    return result;
  }

  function extractAttachments(messageNode) {
    return [
      ...extractImages(messageNode),
      ...extractFiles(messageNode),
      ...extractVideos(messageNode),
      ...extractAudio(messageNode),
    ];
  }

  // ------------------------------------------------------------------
  // CAPTURE ONE WINDOW
  // Builds an array of { fingerprint, y, height, bottom, role, text, attachments, domIndex }
  // sorted in visual (Y) order.
  // ------------------------------------------------------------------
  async function captureMessages() {
    const nodes = [...document.querySelectorAll(SELECTOR)];
    const rootRect = scroller.getBoundingClientRect();
    const result = [];

    for (let domIndex = 0; domIndex < nodes.length; domIndex++) {
      const el = nodes[domIndex];
      const role = el.getAttribute('data-message-author-role');
      // role is expected to be 'user'/'assistant'. Keep only those.
      if (role !== 'user' && role !== 'assistant') continue;
      const text = cleanText(el.innerText);
      if (!text) continue; // empty nodes are filtered (A5)

      const rect = el.getBoundingClientRect();
      const y = +(rect.top - rootRect.top + scroller.scrollTop).toFixed(2);
      const height = +rect.height.toFixed(2);
      const attachments = extractAttachments(el);

      // IDENTITY — Y is NOT part of it. Attachments ARE.
      const attachmentIdentity = attachments
        .map((a) => JSON.stringify({ type: a.type, id: a.id, src: a.src, href: a.href, filename: a.filename }))
        .join('|');
      const fingerprint = await sha256Hex([role, text, attachmentIdentity].join(':'));

      result.push({ fingerprint, y, height, bottom: +(y + height).toFixed(2), role, text, attachments, domIndex });
    }

    // Visual order: Y ascending, ties broken by DOM order.
    result.sort((a, b) => {
      const delta = a.y - b.y;
      if (Math.abs(delta) > CFG.yTolerancePx) return delta;
      return a.domIndex - b.domIndex;
    });

    return result;
  }

  function messageSignature(messages) {
    return messages.map((m) => m.fingerprint).join('|');
  }

  // Wait until the current window is stable (3 consecutive identical captures).
  async function waitForStableState() {
    let previousSignature = null;
    let stable = 0;
    let lastMessages = [];

    for (let i = 0; i < 30; i++) {
      await sleep(i === 0 ? CFG.settleMs : CFG.pollMs);
      lastMessages = await captureMessages();
      const signature = messageSignature(lastMessages);
      if (signature === previousSignature) stable++;
      else stable = 0;
      previousSignature = signature;
      if (stable >= CFG.stablePasses) return { stable: true, messages: lastMessages };
    }
    return { stable: false, messages: lastMessages };
  }

  // ------------------------------------------------------------------
  // GLOBAL UNIQUE MESSAGE MAP — de-dup across windows.
  // Keeps min Y and the richest attachment representation.
  // ------------------------------------------------------------------
  function makeMerger() {
    const uniqueMap = new Map();
    function merge(messages, step) {
      for (const message of messages) {
        const fp = message.fingerprint;
        if (!uniqueMap.has(fp)) {
          uniqueMap.set(fp, {
            fingerprint: fp,
            role: message.role,
            text: message.text,
            y: message.y,
            height: message.height,
            bottom: message.bottom,
            attachments: message.attachments,
            firstStep: step,
            lastStep: step,
            appearances: 1,
          });
        } else {
          const item = uniqueMap.get(fp);
          item.lastStep = step;
          item.appearances++;
          if (message.y < item.y) item.y = message.y;
          if (message.attachments.length > item.attachments.length) item.attachments = message.attachments;
        }
      }
    }
    return { uniqueMap, merge };
  }

  // ------------------------------------------------------------------
  // FULL THREAD CAPTURE — proven Phase 2.0 scroll-march.
  // Returns the ordered message array (Y ascending) or null on failure.
  // ------------------------------------------------------------------
  async function captureFullThread() {
    scroller = findScroller();
    if (!scroller) {
      console.error('[hister-capture] Could not find scroll container');
      return null;
    }

    const { uniqueMap, merge } = makeMerger();
    console.log('[hister-capture] scroll-march start; scroller SC=' + scroller.scrollHeight +
      ' CH=' + scroller.clientHeight);

    // PHASE A — TOP: scroll to 0 and wait for a stable window.
    let topReady = false;
    for (let attempt = 0; attempt < CFG.maxTopAttempts; attempt++) {
      scroller.scrollTop = 0;
      await sleep(CFG.settleMs);
      const state = await waitForStableState();
      const atTop = scroller.scrollTop <= CFG.topTolerancePx;
      console.log('[hister-capture] [TOP] attempt=' + attempt +
        ' scrollTop=' + scroller.scrollTop.toFixed(1) + ' DOM=' + state.messages.length + ' stable=' + state.stable);
      if (atTop && state.stable) {
        merge(state.messages, 0);
        topReady = true;
        break;
      }
    }
    if (!topReady) {
      console.warn('[hister-capture] ⚠️ TOP did not fully stabilize');
      merge(await captureMessages(), 0);
    }

    // PHASE B — TOP -> BOTTOM, stepwise scroll.
    let noMoveSteps = 0;
    for (let step = 1; step <= CFG.maxSteps; step++) {
      const beforeTop = scroller.scrollTop;
      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollTop = Math.min(beforeTop + CFG.scrollStepPx, maxTop);

      const state = await waitForStableState();
      const afterTop = scroller.scrollTop;
      merge(state.messages, step);

      const progress = maxTop > 0 ? afterTop / maxTop : 1;
      const atBottom = afterTop >= maxTop - CFG.bottomTolerancePx;
      console.log('[hister-capture] [DOWN] step=' + step + ' scroll=' + afterTop.toFixed(1) +
        ' DOM=' + state.messages.length + ' unique=' + uniqueMap.size +
        ' progress=' + (progress * 100).toFixed(1) + '%' + (atBottom ? ' 🏁 BOTTOM' : ''));

      if (Math.abs(afterTop - beforeTop) < 1) noMoveSteps++;
      else noMoveSteps = 0;

      if (atBottom) break;
      if (noMoveSteps >= CFG.maxNoMoveSteps) {
        console.warn('[hister-capture] ⚠️ Scroll stopped moving');
        break;
      }
    }

    // FINAL CAPTURE — settle, one more window at BOTTOM.
    await sleep(CFG.settleMs);
    merge(await captureMessages(), 'final');

    // Final order: ONLY now Y is used.
    const messages = [...uniqueMap.values()].sort((a, b) => a.y - b.y);
    console.log('[hister-capture] scroll-march done; unique=' + messages.length);
    return messages;
  }

  // Build flattened [USER]/[ASSISTANT] text in visual order.
  function flattenText(messages) {
    return messages.map((m) => `[${m.role.toUpperCase()}] ${m.text}`).join('\n');
  }

  async function dispatchCapture(messages, reason) {
    if (!messages || messages.length === 0) {
      console.log('[hister-capture] dispatchCapture: no messages, skip (reason=' + reason + ')');
      return;
    }

    const text = flattenText(messages);
    const hashInput = messages.map((m) => `${m.role}:${m.text}`).join('\n---\n');
    const hash = await sha256Hex(hashInput);

    const payload = {
      type: 'CHATGPT_CAPTURE',
      url: canonicalUrl(),
      title: document.title,
      text,
      label: 'chatgpt',
      metadata: {
        source: 'chatgpt',
        conversation_id: conversationId(),
        message_count: messages.length,
      },
      hash,
      messageCount: messages.length,
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

  // Manual capture: full scroll-march, then dispatch. Restores scroll position.
  async function materializeAndCapture() {
    if (captureInProgress) {
      console.log('[hister-capture] capture already in progress, ignoring');
      return { ok: true, skipped: true, reason: 'in-progress' };
    }
    captureInProgress = true;
    try {
      const originalScrollTop = scroller ? scroller.scrollTop : null;
      const messages = await captureFullThread();
      if (messages) {
        // Restore the user's scroll position now that data is extracted.
        if (scroller && originalScrollTop != null) {
          try { scroller.scrollTop = originalScrollTop; } catch (_) { /* ignore */ }
        }
        await dispatchCapture(messages, 'manual');
      }
      return { ok: true, messageCount: messages ? messages.length : 0 };
    } finally {
      captureInProgress = false;
    }
  }

  // Listen for manual trigger from popup.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return false;
    if (msg.type === 'MATERIALIZE_AND_CAPTURE') {
      materializeAndCapture()
        .then((res) => sendResponse(res || { ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err && err.message || String(err) }));
      return true; // async response
    }
    return false;
  });

  // NOTE: no auto-capture on load. Saving is manual-only (by button) so a
  // full-thread hash is what lands in Hister; a partial top-window snapshot
  // would produce a different hash and overwrite the canonical doc on reload.
  function init() {
    console.log('[hister-capture] init on', location.href, '(manual capture via popup button)');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
