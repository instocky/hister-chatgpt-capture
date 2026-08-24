// spike/chatgpt-dom-probe-long-thread.js
// Gate 2 — long-thread extraction & virtualization check.
//
// BEFORE RUNNING:
//   1. Pick a long settled thread. Target N >= 100 if available, else >= 50.
//   2. Determine ground-truth N — see spike/RESULTS/long-thread.md for
//      acceptable methods (fresh-thread user count, Share JSON, other).
//   3. Edit GROUND_TRUTH_N below.
//   4. Open the settled thread in browser. Wait until fully rendered.
//   5. Paste this whole file in DevTools console.
//
// Outputs a single JSON object. Paste it into spike/RESULTS/long-thread.md.

(async () => {
  const GROUND_TRUTH_N = 50; // <-- EDIT THIS to your hand-counted N
  if (
    GROUND_TRUTH_N == null ||
    typeof GROUND_TRUTH_N !== 'number' ||
    GROUND_TRUTH_N < 1
  ) {
    console.error('Edit GROUND_TRUTH_N to your hand-counted N first.');
    return;
  }

  const SELECTOR = '[data-message-author-role]';
  const SETTLE_MS = 3000;

  const sha256Hex = async text => {
    const buf = new TextEncoder().encode(text);
    const hashBuf = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  };

  // extract-once: innerText is called EXACTLY ONCE per node.
  // textContent.length is recorded for drift distribution; cheap, no forced
  // layout, NOT used as the extraction or hash source.
  const extractOnce = () => {
    const t0 = performance.now();
    const nodes = Array.from(document.querySelectorAll(SELECTOR));
    const tQuery = performance.now();
    const messages = nodes
      .map(el => ({
        role: el.getAttribute('data-message-author-role'),
        text: el.innerText.trim(), // <-- innerText: ONCE
        textContentLen: el.textContent.length,
      }))
      .filter(m => m.text.length > 0);
    const tExtract = performance.now();
    return {
      messages,
      nodeCount: nodes.length,
      perf: {
        queryMs: +(tQuery - t0).toFixed(2),
        extractMs: +(tExtract - tQuery).toFixed(2),
        totalMs: +(tExtract - t0).toFixed(2),
      },
    };
  };

  const hashInput = messages =>
    messages.map(m => `${m.role}:${m.text}`).join('\n---\n');

  const initial = extractOnce();
  const initialHash = await sha256Hex(hashInput(initial.messages));

  let mutations = 0;
  const obs = new MutationObserver(muts => {
    mutations += muts.length;
  });
  obs.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  await new Promise(r => setTimeout(r, SETTLE_MS));
  obs.disconnect();

  const after = extractOnce();
  const afterHash = await sha256Hex(hashInput(after.messages));

  // drift distribution (per-message innerText vs textContent length)
  const drifts = initial.messages.map(m => {
    const inner = m.text.length;
    const content = m.textContentLen;
    return (Math.abs(content - inner) / Math.max(1, inner)) * 100;
  });
  const sortedDrifts = [...drifts].sort((a, b) => a - b);
  const pct = q => {
    if (sortedDrifts.length === 0) return 0;
    const idx = Math.min(
      sortedDrifts.length - 1,
      Math.floor(q * sortedDrifts.length)
    );
    return sortedDrifts[idx];
  };
  const mean =
    drifts.length === 0 ? 0 : drifts.reduce((a, b) => a + b, 0) / drifts.length;
  const driftStats = {
    n: drifts.length,
    mean: +mean.toFixed(2),
    median: +pct(0.5).toFixed(2),
    p95: +pct(0.95).toFixed(2),
    max: +(drifts.length === 0 ? 0 : Math.max(...drifts)).toFixed(2),
    over_5pct: drifts.filter(d => d > 5).length,
    over_20pct: drifts.filter(d => d > 20).length,
  };

  const roleCounts = initial.messages.reduce((acc, m) => {
    acc[m.role] = (acc[m.role] || 0) + 1;
    return acc;
  }, {});

  const result = {
    url: location.origin + location.pathname,
    title: document.title,
    ground_truth_n: GROUND_TRUTH_N,
    extracted_count: initial.messages.length,
    count_matches_truth: initial.messages.length === GROUND_TRUTH_N,
    count_delta: initial.messages.length - GROUND_TRUTH_N,
    dom_node_count: initial.nodeCount,
    empty_filtered: initial.nodeCount - initial.messages.length,
    perf_initial: initial.perf,
    perf_after: after.perf,
    perf_target_500ms_after: after.perf.totalMs < 500,
    hash_initial: initialHash,
    hash_after: afterHash,
    hash_stable: initialHash === afterHash,
    mutations_observed_3s: mutations,
    drift_distribution_pct: driftStats,
    role_counts: roleCounts,
    has_both_roles:
      (roleCounts.user || 0) > 0 && (roleCounts.assistant || 0) > 0,
  };

  console.log(
    '=== SPIKE RESULT — paste JSON below into spike/RESULTS/long-thread.md ==='
  );
  console.log(JSON.stringify(result, null, 2));
  console.log('=== END ===');
  return result;
})();
