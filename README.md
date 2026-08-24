# Hister ChatGPT Capture

Chrome MV3 extension that auto-captures settled ChatGPT conversations into a
local Hister v0.18.0 instance.

`chatgpt.com/c/<uuid>` -> structured user/assistant text -> `POST /api/add` ->
Hister (Bleve FTS + MCP).

The extension is a capture layer. **Hister remains a dumb pipe.**

## Status

PRD v0.5 + Handoff accepted. All 3 pre-impl gates closed (Gate 2 long-thread
risk explicitly accepted by TL). Implementation is the next phase.

| Gate                                | Verdict           |
| ----------------------------------- | ----------------- |
| 1. `innerText` extract-once         | PASS              |
| 2. long-thread / virtualization     | NOT VERIFIED (TL risk accepted) |
| 3. label preservation (Hister upsert) | PASS, Outcome A   |

See `docs/Handoff.md` for locked architecture, data model, timing, retry.
See `docs/PRD-chatgpt-ext.md` for F1-F15 requirements, A1-A11 acceptance tests.

## Repo layout

```
.
├── manifest.json         # MV3 manifest (TODO: implementation phase)
├── content.js            # DOM extraction, hash, debounce, sendMessage (TODO)
├── service_worker.js     # fetch POST, retry, storage dedupe (TODO)
├── popup.html            # minimal status popup (TODO, optional)
├── README.md             # this file
├── .gitignore
└── docs/
    ├── PRD-chatgpt-ext.md
    ├── Handoff.md
    └── spike/
        ├── chatgpt-dom-probe-innerText.js
        ├── chatgpt-dom-probe-long-thread.js
        ├── label-preservation-runbook.md
        ├── RESULTS/
        │   ├── innerText.md
        │   ├── long-thread.md
        │   └── label-preservation.md
        └── tmp/          # Gate 3 audit artifacts (run-gate3.ps1, body JSON, step logs)
```

## Quick start (after implementation lands)

1. Ensure Hister is running locally: `Get-Process -Name hister`
2. Open `chrome://extensions/`, enable **Developer mode**
3. **Load unpacked** -> select this repo root
4. Open a real settled ChatGPT thread (`chatgpt.com/c/<uuid>`, >= 1 user + 1
   assistant message)
5. Wait ~3 s after the last message renders -> ext auto-captures
6. Verify in Hister WebUI at `http://127.0.0.1:4433` (label: `chatgpt`)

## Hard rules (do not violate)

Full list in `docs/Handoff.md`. Top of mind:

- **F4 extract-once.** `innerText` called exactly once per node. Hash and
  flattened text derived from the same `messages[]` array.
- **F7 debounce 3 s** after the last DOM mutation, hash computed before POST.
- **F8 POST body** = `{url, title, text, label: "chatgpt", metadata: {...}}`.
  `Content-Type: application/json; charset=utf-8`. Do NOT set `Origin` header
  manually (MV3 forbids; Chrome sets `chrome-extension://<id>` automatically).
- **F10 dedupe** via `chrome.storage.local` keyed by URL: `{hash, updatedAt,
  messageCount, conversationId}`.
- **F11 retry** 3x with 2 s backoff, within SW lifetime. No persistent queue
  in v1 (`chrome.alarms` is v2).
- **A11 label policy.** Extension always sends `label: "chatgpt"`. Manual
  Hister WebUI label edits are overwritten on the next recapture (Hister
  `serveAdd` decodes the entire POST body, including `label`). v1 documented
  limitation, do not "fix" on the client.

## Non-goals (v1)

Streaming capture, attachments, image/file extraction, Obsidian integration,
Qdrant/Meilisearch, separate SQLite, server-side ChatGPT extractor,
multi-device sync, historical bulk importer, force-recapture UI.

## Acceptance tests

A1-A10 from PRD must remain unchanged. A11 added in v0.5 (label preservation,
Outcome A). Run A1-A11 against live Hister on the Cyrillic test thread
`chatgpt.com/c/6a8bed08-fbc8-83ea-87ad-e45ce7c66320` (reused from Gate 1) and
a fresh thread with >= 20 messages.

## Resuming work

1. Read `docs/Handoff.md` (implementation context, locked decisions).
2. Read `docs/PRD-chatgpt-ext.md` (F1-F15, A1-A11, DoD in section 13).
3. Read `docs/spike/RESULTS/innerText.md` (Gate 1 evidence, reuse thread).
4. Read `docs/spike/RESULTS/label-preservation.md` (Gate 3 evidence, A11).
5. Implement per locked PRD. No scope changes without TL sign-off.
