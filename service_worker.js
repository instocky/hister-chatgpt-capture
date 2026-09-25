// service_worker.js — MV3 background script (v0.6, clipboard-only)
//
// Responsibilities:
//   - chrome.commands.onCommand relay: hotkey Alt+Shift+C → forward
//     {type:'EXTRACT_WRITE_TOAST'} to the active tab's content script.
//   - That's it. No network, no storage, no badge state machine.
//
// Popup-button path is direct: popup.js → chrome.tabs.sendMessage(content).
// SW is NOT involved for popup clicks.
//
// Hotkey writeText semantics: at hotkey-press time the chatgpt.com tab is the
// user's focus, so navigator.clipboard.writeText in the content script passes
// the document-focus check. If the tab is NOT focused (DevTools / another
// window), writeText rejects with NotAllowedError; content script surfaces
// an error toast.

(() => {
  'use strict';

  const TAG = '[hister-capture/sw]';

  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'save-clipboard') return;
    console.log(TAG, 'command:', command);
    const tab = await activeTab();
    if (!tab?.id) {
      console.warn(TAG, 'no active tab');
      return;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_WRITE_TOAST' });
    } catch (e) {
      console.warn(TAG, 'forward failed:', e?.message || e);
    }
  });

  async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }
})();
