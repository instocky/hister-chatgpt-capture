// spike/chatgpt-dom-probe-innerText.js
// Gate 1 — validate extract-once pattern with innerText on a settled ChatGPT thread.
//
// Run: open chatgpt.com/c/<uuid> with >= 1 non-empty message, wait until thread
// is fully rendered, then paste this whole file into DevTools console.
// The script extracts twice (T0 and T+3s), runs a MutationObserver between, and
// prints one JSON object. Paste the JSON into spike/RESULTS/innerText.md.

(async () => {
  const SELECTOR = '[data-message-author-role]';
  const SETTLE_MS = 3000;

  const sha256Hex = async (text) => {
    const buf = new TextEncoder().encode(text);
    const hashBuf = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  };

  // extract-once: innerText is called EXACTLY ONCE per node.
  // textContent.length is recorded separately for drift comparison; it is cheap
  // (no forced layout) and is NOT used as the extraction or hash source.
  const extractOnce = () => {
    const t0 = performance.now();
    const nodes = Array.from(document.querySelectorAll(SELECTOR));
    const messages = nodes
      .map((el) => ({
        role: el.getAttribute('data-message-author-role'),
        text: el.innerText.trim(),            // <-- innerText: ONCE
        textContentLen: el.textContent.length,
      }))
      .filter((m) => m.text.length > 0);
    return { messages, extractMs: performance.now() - t0 };
  };

  const hashInput = (messages) =>
    messages.map((m) => `${m.role}:${m.text}`).join('\n---\n');

  const initial = extractOnce();
  const initialHash = await sha256Hex(hashInput(initial.messages));

  let mutations = 0;
  const obs = new MutationObserver((muts) => {
    mutations += muts.length;
  });
  obs.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  await new Promise((r) => setTimeout(r, SETTLE_MS));
  obs.disconnect();

  const after = extractOnce();
  const afterHash = await sha256Hex(hashInput(after.messages));

  const result = {
    url: location.origin + location.pathname,
    title: document.title,
    extractMs_initial: +initial.extractMs.toFixed(2),
    extractMs_after: +after.extractMs.toFixed(2),
    count_initial: initial.messages.length,
    count_after: after.messages.length,
    count_stable: initial.messages.length === after.messages.length,
    hash_initial: initialHash,
    hash_after: afterHash,
    hash_stable: initialHash === afterHash,
    mutations_observed_3s: mutations,
    first3: initial.messages.slice(0, 3).map((m) => ({
      role: m.role,
      text_head: m.text.slice(0, 100),
      len_innerText: m.text.length,
      len_textContent: m.textContentLen,
      drift_pct: +(
        ((m.textContentLen - m.text.length) / Math.max(1, m.text.length)) *
        100
      ).toFixed(1),
    })),
  };

  console.log(
    '=== SPIKE RESULT — paste JSON below into spike/RESULTS/innerText.md ==='
  );
  console.log(JSON.stringify(result, null, 2));
  console.log('=== END ===');
  return result;
})();
