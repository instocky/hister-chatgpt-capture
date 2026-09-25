// content.js — runs at document_idle on chatgpt.com/c/*
//
// Responsibilities (v0.6 — clipboard-only, Hister sink removed):
//   - DOM extraction via [data-message-author-role]
//   - full-thread capture via proven Phase 2.0 scroll-march algorithm
//     (see c:\Projects\Common\0824\phases.md PHASE 2.0 + report):
//       TOP -> capture -> scroll -> capture -> dedup by fingerprint -> BOTTOM -> sort by Y
//   - Markdown building from extracted messages
//   - chrome.runtime.onMessage handler for popup path (EXTRACT) and hotkey path
//     (EXTRACT_WRITE_TOAST) and toast rendering (TOAST)
//   - manual capture only, triggered by popup button OR hotkey Alt+Shift+C
//
// v0.3 → v0.6 carry-over:
//   - extraction strategy UNCHANGED (Phase 2.0 scroll-march, single-flight guard,
//     innerText capture, Y-based visual order, fingerprint dedup, restore scroll).
//   - extraction → hashing pipeline is irrelevant in v0.6 (no hash, no dedup);
//     messages[] is built once and consumed directly by buildMarkdown().
//
// v0.6 hard rules:
//   - NO network calls. NO storage. NO Chrome declarativeNetRequest.
//   - writeText in content script context requires host document to be focused
//     (only true at hotkey-press time, NOT when popup is open). Popup-button
//     path has popup.js do the writeText itself.
//   - url = location.origin + location.pathname, trailing slash stripped (kept
//     for logging / future use).

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

  /** SHA-256 hex via Web Crypto. (Kept for future fingerprint-based dedup; unused in v0.6.) */
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
  // v0.6 does not include attachments in the markdown output (PRD
  // non-goals: no image/file extraction). Functions retained in case
  // v0.7 wants them back in the toast preview.
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
        if (el.matches('a[download]')) continue;
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
      if (role !== 'user' && role !== 'assistant') continue;
      const text = cleanText(el.innerText);
      if (!text) continue; // empty nodes are filtered (A5)

      const rect = el.getBoundingClientRect();
      const y = +(rect.top - rootRect.top + scroller.scrollTop).toFixed(2);
      const height = +rect.height.toFixed(2);
      const attachments = extractAttachments(el);

      const attachmentIdentity = attachments
        .map((a) => JSON.stringify({ type: a.type, id: a.id, src: a.src, href: a.href, filename: a.filename }))
        .join('|');
      const fingerprint = await sha256Hex([role, text, attachmentIdentity].join(':'));

      result.push({ fingerprint, y, height, bottom: +(y + height).toFixed(2), role, text, attachments, domIndex });
    }

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

    await sleep(CFG.settleMs);
    merge(await captureMessages(), 'final');

    const messages = [...uniqueMap.values()].sort((a, b) => a.y - b.y);
    console.log('[hister-capture] scroll-march done; unique=' + messages.length);
    return messages;
  }

  // ------------------------------------------------------------------
  // MARKDOWN BUILDER (v0.6).
  //   **User:** / **Assistant:** with --- separator.
  //   innerText is preserved verbatim — ChatGPT already renders markdown
  //   source (with ```lang code fences, inline `code`, **bold**, etc.)
  //   as visible text, so no extra markdown rendering is needed here.
  // ------------------------------------------------------------------
  function buildMarkdown(messages) {
    return messages
      .map((m) => `**${m.role[0].toUpperCase()}${m.role.slice(1)}:**\n\n${m.text}`)
      .join('\n\n---\n\n')
      + '\n';
  }

  // Manual capture: full scroll-march, return markdown. Restores scroll position.
  async function materializeAndReturnMarkdown() {
    if (captureInProgress) {
      console.log('[hister-capture] capture already in progress, ignoring');
      return { ok: true, skipped: true, reason: 'in-progress' };
    }
    captureInProgress = true;
    try {
      const originalScrollTop = scroller ? scroller.scrollTop : null;
      const messages = await captureFullThread();
      // Restore the user's scroll position now that data is extracted.
      if (scroller && originalScrollTop != null) {
        try { scroller.scrollTop = originalScrollTop; } catch (_) { /* ignore */ }
      }
      if (!messages || messages.length === 0) {
        return { ok: false, error: 'no-messages', messageCount: 0 };
      }
      const md = buildMarkdown(messages);
      return { ok: true, md, chars: md.length, messageCount: messages.length };
    } finally {
      captureInProgress = false;
    }
  }

  // ------------------------------------------------------------------
  // IN-PAGE TOAST — bottom-right, 2.5s auto-fade, no click.
  // Mirrors prod spec (v0.6 §Toast).
  // ------------------------------------------------------------------
  function showToast(text, kind = 'ok') {
    const el = document.createElement('div');
    el.dataset.histerCaptureToast = '1';
    el.textContent = text;
    el.style.cssText = [
      'position: fixed',
      'bottom: 20px',
      'right: 20px',
      'padding: 12px 20px',
      'background: ' + (kind === 'err' ? '#d33' : '#2a7'),
      'color: #fff',
      'font: 600 14px/1.4 -apple-system, "Segoe UI", sans-serif',
      'border-radius: 6px',
      'box-shadow: 0 4px 12px rgba(0,0,0,0.25)',
      'z-index: 2147483647',
      'opacity: 0',
      'transform: translateY(8px)',
      'transition: opacity 200ms ease, transform 200ms ease',
      'pointer-events: none',
      'max-width: 320px',
    ].join(';');
    document.body.appendChild(el);
    requestAnimationFrame(() => {
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
    });
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      setTimeout(() => el.remove(), 250);
    }, 2500);
  }

  // ------------------------------------------------------------------
  // MESSAGE ROUTING
  //   EXTRACT              → popup button: return markdown, popup writes.
  //   EXTRACT_WRITE_TOAST  → hotkey: do everything in content script
  //                          (chatgpt tab is focused at hotkey time, so
  //                          writeText document-focus check passes).
  //   TOAST                → popup tells us to show the post-write overlay.
  // ------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return false;

    if (msg.type === 'EXTRACT') {
      materializeAndReturnMarkdown()
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err && err.message || String(err) }));
      return true;
    }

    if (msg.type === 'EXTRACT_WRITE_TOAST') {
      (async () => {
        try {
          const r = await materializeAndReturnMarkdown();
          if (!r || !r.ok) {
            showToast('Save failed: ' + ((r && r.error) || 'unknown'), 'err');
            sendResponse({ ok: false, error: (r && r.error) || 'unknown' });
            return;
          }
          await navigator.clipboard.writeText(r.md);
          showToast(`Saved — ${r.chars} chars`);
          sendResponse({ ok: true, chars: r.chars, messageCount: r.messageCount, via: 'content-hotkey' });
        } catch (e) {
          console.error('[hister-capture] hotkey writeText FAIL', e?.name, e?.message);
          showToast(`Save failed: ${e?.name || 'unknown'}`, 'err');
          sendResponse({ ok: false, error: e?.name || 'unknown', message: e?.message || '' });
        }
      })();
      return true;
    }

    if (msg.type === 'TOAST') {
      try {
        showToast(msg.text || '', msg.kind === 'err' ? 'err' : 'ok');
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
      return false;
    }

    return false;
  });

  function init() {
    console.log('[hister-capture] init on', location.href, '(v0.6 clipboard-only)');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
