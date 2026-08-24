// popup.js — runs in the extension action popup
// Reads the current tab's canonical URL, asks the SW for status, renders rows.
// Captures manual "Capture this thread" button -> sends MATERIALIZE_AND_CAPTURE
// to the content script of the active tab.

(async () => {
  const root = document.getElementById('root');
  const btn = document.getElementById('capture-btn');

  let url = '';
  let tabId = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && /^https?:\/\/chatgpt\.com\//.test(tab.url)) {
      tabId = tab.id;
      const u = new URL(tab.url);
      url = u.origin + u.pathname;
    }
  } catch (_) {
    // ignore
  }

  let status = { state: 'idle' };
  if (url) {
    try {
      status = await chrome.runtime.sendMessage({ type: 'GET_STATUS', url });
    } catch (_) {
      // ignore
    }
  }

  function render() {
    if (!status || status.state === 'idle') {
      root.innerHTML =
        row('State', 'idle', 'state-idle') +
        row('URL', url || '(n/a)') +
        '<div class="hint">Open a <code>chatgpt.com/c/&lt;uuid&gt;</code> thread to capture.</div>';
      return;
    }
    const updatedAt = status.updatedAt ? new Date(status.updatedAt).toLocaleString() : 'n/a';
    const hashShort = (status.hash || '').slice(0, 12) + '…';
    root.innerHTML =
      row('State', 'OK', 'state-OK') +
      row('URL', status.url) +
      row('Conversation', status.conversationId || 'n/a') +
      row('Messages', String(status.messageCount != null ? status.messageCount : 'n/a')) +
      row('Updated', updatedAt) +
      row('Hash', hashShort, '', status.hash);
  }

  function row(label, val, valClass, valTitle) {
    return '<div class="row">'
      + '<span class="label">' + escapeHtml(label) + '</span>'
      + '<span class="val ' + (valClass || '') + '" title="' + escapeHtml(valTitle || val) + '">'
      + escapeHtml(val) + '</span></div>';
  }

  render();

  if (!url || !tabId) {
    btn.disabled = true;
    btn.textContent = 'Not on a chatgpt.com thread';
    return;
  }

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Capturing… (scrolling to materialize)';
    btn.classList.add('btn-err');
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'MATERIALIZE_AND_CAPTURE' });
      if (res && res.ok) {
        btn.classList.remove('btn-err');
        btn.textContent = 'Captured ✓ — click to recapture';
        // Refresh status display.
        try {
          status = await chrome.runtime.sendMessage({ type: 'GET_STATUS', url });
          render();
        } catch (_) { /* ignore */ }
      } else {
        btn.textContent = 'ERR: ' + (res && res.error || 'unknown');
      }
    } catch (err) {
      btn.textContent = 'ERR: ' + (err && err.message || String(err));
    } finally {
      btn.disabled = false;
    }
  });
})();

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
