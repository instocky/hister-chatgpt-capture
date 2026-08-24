// popup.js — runs in the extension action popup
// Reads the current tab's canonical URL, asks the SW for status, renders rows.

(async () => {
  const root = document.getElementById('root');

  let url = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && /^https?:\/\/chatgpt\.com\//.test(tab.url)) {
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

  function row(label, val, valClass, valTitle) {
    return '<div class="row">'
      + '<span class="label">' + escapeHtml(label) + '</span>'
      + '<span class="val ' + (valClass || '') + '" title="' + escapeHtml(valTitle || val) + '">'
      + escapeHtml(val) + '</span></div>';
  }
})();

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
