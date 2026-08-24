# Gate 1 — innerText Spike Result

**Date:** 2026-08-24
**Thread:** https://chatgpt.com/c/6a8bed08-fbc8-83ea-87ad-e45ce7c66320
**Browser:** Chrome (dev console)
**Run:** 1

## Raw result

```json
{
  "url": "https://chatgpt.com/c/6a8bed08-fbc8-83ea-87ad-e45ce7c66320",
  "title": "Обсуждение Hister",
  "extractMs_initial": 2.2,
  "extractMs_after": 3.4,
  "count_initial": 11,
  "count_after": 11,
  "count_stable": true,
  "hash_initial": "72b2084504fec75dda9df23f0dc88f8c71e0f5a52807b7d7b0069365e85f8881",
  "hash_after": "72b2084504fec75dda9df23f0dc88f8c71e0f5a52807b7d7b0069365e85f8881",
  "hash_stable": true,
  "mutations_observed_3s": 0,
  "first3": [
    {
      "role": "user",
      "text_head": "локально нормально добавилось\nправда кириллица не отображается пока)",
      "len_innerText": 68,
      "len_textContent": 68,
      "drift_pct": 0
    },
    {
      "role": "user",
      "text_head": "не находит кириллицу",
      "len_innerText": 20,
      "len_textContent": 20,
      "drift_pct": 0
    },
    {
      "role": "user",
      "text_head": "оба сработали)",
      "len_innerText": 14,
      "len_textContent": 14,
      "drift_pct": 0
    }
  ]
}
```

## Verdict checklist

- [x] Extraction ran without exception
- [x] `count_initial === count_after` (11 == 11, no streaming / late DOM updates)
- [x] `hash_initial === hash_after` (SHA-256 identical, settled)
- [x] `mutations_observed_3s === 0` (settled thread, no DOM noise)
- [x] First 3 messages render as visible text (not script / placeholder)
- [x] innerText vs textContent length drift within ±5% per message (0% across all 3)
- [x] `extractMs_after` reasonable for thread size (3.4ms for 11 msgs — well under 500ms A8 target)

**Verdict:** PASS

## Notes

- Thread title `Обсуждение Hister` + 3 first messages are Cyrillic → this same thread is a usable oracle for **A6 (Cyrillic round-trip)**. Worth re-using during A1–A11 sweep.
- 11 messages is small. A8 perf target (50 msgs, < 500ms) is not exercised here — needs Gate 2 confirmation on a long thread.
- All 3 first messages are `role: user` — not a defect (likely a thread structure where user msgs cluster at the start), but the spike should not be cited as "assistant rendering works" without a long-thread run that includes assistant turns.
- innerText vs textContent drift = 0 on all 3 samples → for short messages, both produce identical text. The ±5% tolerance in PRD §15 is not exercised by this run; long-thread with code blocks / multi-line content is the real test.

## Decision

PASS → proceed to Gate 2 (long-thread, ground-truth N).
