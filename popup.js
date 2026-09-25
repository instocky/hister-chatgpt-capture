// popup.js — runs in the extension action popup (v0.6 clipboard-only)
//
// Flow on button click:
//   1. chrome.tabs.sendMessage(content, EXTRACT) → {ok, md, chars, messageCount}
//   2. navigator.clipboard.writeText(md)        ← popup is focused, no NotAllowedError
//   3. chrome.tabs.sendMessage(content, TOAST)  ← best-effort in-page overlay
//
// Step 2 must run AS SOON AS we have md in hand — do not await anything
// between extract-result and writeText or the popup may close first.

(async () => {
  const root = document.getElementById('root');
  const btn = document.getElementById('save-btn');

  let tabId = null;
  let url = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id && tab.url && /^https?:\/\/chatgpt\.com\/c\//.test(tab.url)) {
      tabId = tab.id;
      url = (new URL(tab.url)).origin + (new URL(tab.url)).pathname;
      url = url.replace(/\/+$/, '');
    }
  } catch (_) { /* ignore */ }

  function render(state) {
    if (!url || !tabId) {
      root.innerHTML =
        '<div class="row"><span class="label">State</span><span class="val state-idle">idle</span></div>' +
        '<div class="row"><span class="label">URL</span><span class="val">(n/a)</span></div>' +
        '<div class="hint">Open a <code>chatgpt.com/c/&lt;uuid&gt;</code> thread to save.</div>';
      return;
    }
    if (state === 'OK') {
      root.innerHTML =
        '<div class="row"><span class="label">State</span><span class="val state-OK">saved ✓</span></div>' +
        '<div class="row"><span class="label">URL</span><span class="val">' + escapeHtml(url) + '</span></div>' +
        '<div class="hint">Click again to recapture. Each click overwrites the clipboard with the current snapshot.</div>';
      return;
    }
    if (state === 'ERR') {
      root.innerHTML =
        '<div class="row"><span class="label">State</span><span class="val state-ERR">error</span></div>' +
        '<div class="row"><span class="label">URL</span><span class="val">' + escapeHtml(url) + '</span></div>' +
        '<div class="hint">See console / page for details. Try again on the thread page.</div>';
      return;
    }
    root.innerHTML =
      '<div class="row"><span class="label">State</span><span class="val state-idle">idle</span></div>' +
      '<div class="row"><span class="label">URL</span><span class="val">' + escapeHtml(url) + '</span></div>';
  }

  if (!url || !tabId) {
    render('idle');
    btn.disabled = true;
    btn.textContent = 'Not on a chatgpt.com/c/* thread';
    return;
  }
  render('idle');

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = 'Capturing… (scrolling to materialize)';
    btn.classList.add('btn-err');
    render('idle');

    try {
      // Step 1: ask content script for markdown.
      const extract = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT' });
      if (!extract || !extract.ok) {
        throw new Error('extract failed: ' + ((extract && extract.error) || 'unknown'));
      }

      btn.textContent = `Writing ${extract.chars} chars…`;

      // Step 2: writeText from popup context (popup is focused + clipboardWrite permission).
      await navigator.clipboard.writeText(extract.md);

      // Step 3: surface success in popup + ask content script for in-page overlay.
      btn.classList.remove('btn-err');
      btn.textContent = `Saved ✓ — ${extract.chars} chars (${extract.messageCount} msgs)`;
      render('OK');

      chrome.tabs
        .sendMessage(tabId, { type: 'TOAST', text: `Saved — ${extract.chars} chars` })
        .catch(() => { /* toast is best-effort */ });
    } catch (err) {
      btn.textContent = 'ERR: ' + (err && err.message || String(err));
      render('ERR');
      chrome.tabs
        .sendMessage(tabId, { type: 'TOAST', text: 'Save failed: ' + (err && err.message || 'unknown'), kind: 'err' })
        .catch(() => { /* ignore */ });
    } finally {
      btn.disabled = false;
      setTimeout(() => {
        if (btn.textContent.startsWith('Saved ✓')) btn.textContent = originalLabel;
      }, 4000);
    }
  });
})();

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
