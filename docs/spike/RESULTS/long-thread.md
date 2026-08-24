# Gate 2 — Long-Thread Spike Result

**Date:** 2026-08-24
**Status:** NOT VERIFIED 🟡 (TL risk acceptance, 2026-08-24)

## Ground-truth N (how obtained)

**N obtained:** NO — no real long-thread with known N ≥ 50 available in dev inventory.

Attempts (2026-08-24):

- **Run 1:** thread `6a8bed08-fbc8-83ea-87ad-e45ce7c66320` ("Обсуждение Hister"), 11 DOM messages. Dev-set N=50 → invalid (oracle mismatch, N placed in script, not derived from the actual thread).
- **Run 2:** thread `6a880dbc-bc80-83ea-a0c0-17b3d2e82a63` ("Автопоиск клиентов Telegram"), 9 DOM messages. Dev-set N=50 → invalid (same methodology).

The spike itself is correct — `count_matches_truth: false` is an honest signal that the test was misconfigured, not a virtualization observation.

## Raw result (both runs invalidated, kept for audit)

**Run 1 — N=50 on 11-msg thread (invalid):**
```json
{
  "url": "https://chatgpt.com/c/6a8bed08-fbc8-83ea-87ad-e45ce7c66320",
  "title": "Обсуждение Hister",
  "ground_truth_n": 50,
  "extracted_count": 11,
  "count_matches_truth": false,
  "count_delta": -39,
  "dom_node_count": 13,
  "empty_filtered": 2,
  "perf_initial": { "queryMs": 0.2, "extractMs": 1.3, "totalMs": 1.5 },
  "perf_after":  { "queryMs": 0.2, "extractMs": 1.2, "totalMs": 1.4 },
  "hash_initial": "391b1b3a1f31d6339bb96606cd217ccd7cdc0758be0d437db109320a8a9cd9ee",
  "hash_after":  "391b1b3a1f31d6339bb96606cd217ccd7cdc0758be0d437db109320a8a9cd9ee",
  "hash_stable": true,
  "mutations_observed_3s": 0,
  "drift_distribution_pct": { "n": 11, "mean": 0.88, "median": 0.32, "p95": 4.35, "max": 4.35, "over_5pct": 0, "over_20pct": 0 },
  "role_counts": { "user": 8, "assistant": 3 },
  "has_both_roles": true
}
```

**Run 2 — N=50 on 9-msg thread (invalid):**
```json
{
  "url": "https://chatgpt.com/c/6a880dbc-bc80-83ea-a0c0-17b3d2e82a63",
  "title": "Автопоиск клиентов Telegram",
  "ground_truth_n": 50,
  "extracted_count": 9,
  "count_matches_truth": false,
  "count_delta": -41,
  "dom_node_count": 9,
  "empty_filtered": 0,
  "perf_initial": { "queryMs": 0.3, "extractMs": 2.4, "totalMs": 2.7 },
  "perf_after":  { "queryMs": 0.5, "extractMs": 4.2, "totalMs": 4.7 },
  "hash_initial": "48e26009fe8ec56299b938b877d6cff450597f19403dad4c1d4d133bd68a0173",
  "hash_after":  "48e26009fe8ec56299b938b877d6cff450597f19403dad4c1d4d133bd68a0173",
  "hash_stable": true,
  "mutations_observed_3s": 0,
  "drift_distribution_pct": { "n": 9, "mean": 0.74, "median": 0.06, "p95": 4.46, "max": 4.46, "over_5pct": 0, "over_20pct": 0 },
  "role_counts": { "user": 5, "assistant": 4 },
  "has_both_roles": true
}
```

## Verdict checklist

- [ ] `extracted_count === ground_truth_n` — **N/A**: oracle not obtained. `count_matches_truth: false` reflects test misconfiguration, not a real extraction defect.
- [x] `hash_initial === hash_after` on both runs (settled)
- [x] `mutations_observed_3s === 0` on both runs
- [x] `perf_after.totalMs < 500` on both runs (1.4ms / 4.7ms)
- [x] `drift_distribution.max < 5%` on both runs (4.35% / 4.46%)
- [x] `has_both_roles === true` on both runs

**Verdict:** NOT VERIFIED 🟡

## Notes — what these 2 runs DO and DO NOT tell us

**Confirmed (short threads, N ≤ 11):**
- DOM extraction is consistent (hash stable across the 3s settle window)
- No late DOM mutations at settle
- Performance is fast (≤ 5ms)
- innerText vs textContent drift stays within ±5% tolerance
- Both user and assistant roles extract correctly

**NOT verified (long threads, N ≥ 50):**
- Performance at scale (A8 target = 50 msgs, < 500ms)
- innerText vs textContent drift on long / code-block content
- Whether ChatGPT virtualizes long threads (the original Gate 2 question)
- Whether the extension can capture full historical threads or only currently-rendered ones

## Risk acceptance (TL decision 2026-08-24)

> **Long-thread / DOM virtualization is not verified in v1. The extension captures messages currently rendered in the DOM at settle time. Full historical-thread capture is deferred until a real long-thread test is available.**

This is captured in:
- PRD §10 Risk #Long-threads (row "Long threads (> 1000 msgs)")
- PRD Appendix D — Status for TL sign-off
- Handoff §"Mandatory pre-implementation gates" — Gate 2 entry

**v1 contract:** the extension captures what is rendered at MutationObserver settle time. If ChatGPT virtualizes the DOM and only shows the last K messages, the extension captures K messages, not the full thread. This is a documented v1 limitation, not a bug.

## Post-MVP regression test

When a real long-thread becomes available (or a synthetic one is built):

1. Pick a thread with known N (Share JSON export preferred, fresh-thread user count as fallback).
2. Edit `spike/chatgpt-dom-probe-long-thread.js` line: `const GROUND_TRUTH_N = <N>;`.
3. Open the settled thread in browser, paste spike in DevTools console.
4. Capture the JSON output.
5. Backfill this file: replace the verdict with PASS or FAIL, append the run, document the new N source.

The spike code stays in `spike/chatgpt-dom-probe-long-thread.js` for this purpose.

## Decision

NOT VERIFIED 🟡 → proceed to Gate 3 (label preservation). Gate 2 closed as a non-blocker per TL acceptance.
