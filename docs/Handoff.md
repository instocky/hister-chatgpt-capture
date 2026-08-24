# HANDOFF — Hister ChatGPT Capture

## Mission

Build a Chrome MV3 extension that automatically captures settled
ChatGPT conversations into a local Hister v0.18.0 instance.

Goal:
ChatGPT → structured user/assistant text → Hister → FTS/MCP retrieval.

The extension is a capture layer. Hister remains a dumb pipe.

## Current status

PRD v0.5 is accepted at architecture level.

DO NOT redesign the architecture unless a spike disproves an assumption.

Repository target:
C:\Projects\Extantions\20260824_hister-chatgpt-capture

Hister backend:
http://127.0.0.1:4433

## Verified facts

### Hister

- v0.18.0 running locally.
- POST /api/add works.
- HTTP 201 confirmed.
- FTS works.
- Cyrillic FTS works.
- label:chatgpt works.
- label:youtube works.
- MCP /mcp works.
- MCP search works.
- MCP get_preview works.
- metadata.KEY: is not indexed.
- Hister upserts documents by d.ID(), derived from URL.
- Re-POSTing same URL replaces the canonical document.
- No Hister document ID needs to be stored by extension.
- Extension origins are accepted for CSRF bypass.
- Chrome extension must NOT manually set Origin.

### ChatGPT DOM

Verified on a real settled thread:

- selector:
  [data-message-author-role]
- roles:
  user / assistant
- empty message nodes exist and must be filtered.
- settled DOM showed stable content.
- current implementation decision: use innerText.
- extraction/hash must use exactly the same extracted strings.

## Locked architecture

ChatGPT DOM
    ↓
content.js
    ↓ chrome.runtime.sendMessage()
Service Worker
    ↓ fetch()
http://127.0.0.1:4433/api/add
    ↓
Hister

content.js:
- DOM extraction
- empty filtering
- extract-once messages[]
- hash
- debounce

Service Worker:
- network I/O
- retry
- storage coordination

## Locked data model

One canonical Hister document per normalized ChatGPT thread URL.

URL:
location.origin + location.pathname

Drop:
- query
- fragment

Example:
https://chatgpt.com/c/<uuid>

POST:

{
  url,
  title,
  text,
  label: "chatgpt",
  metadata: {
    source: "chatgpt",
    conversation_id,
    message_count
  }
}

Flattened text:

[USER] ...
[ASSISTANT] ...
[USER] ...

## Hash

Build messages exactly once:

messages = [
  {
    role,
    text: el.innerText.trim()
  }
]

Filter empty messages.

Hash input:

messages
  .map(m => `${m.role}:${m.text}`)
  .join("\n---\n")

SHA-256 hex.

Do NOT call innerText twice.

## Deduplication

chrome.storage.local stores per URL:

{
  hash,
  updatedAt,
  messageCount,
  conversationId
}

If hash unchanged:
→ no POST.

If hash changed:
→ POST.

Hister handles canonical upsert by URL.

Result:
one thread URL = one Hister document.

## Timing

**v0.2 — manual trigger, not MutationObserver.**

- **No MO-driven capture.** chatgpt.com virtualizes the thread; the DOM only contains the current buffer window (~14-15 messages). MO would fire on every scroll-induced DOM change, re-hash, and re-POST, overwriting Hister with intermediate state. Removed in commit `fceec9d`.
- **Single-shot initial capture** on page load (best-effort, may be partial).
- **Manual capture** via the popup "Capture this thread" button. Snapshots whatever messages are currently mounted in the DOM at click time. User is expected to scroll the thread to the position they want to capture first.

Capture is settled-thread at the moment the user clicks; no token-by-token streaming.

## Retry

On POST failure:
- retry up to 3 times
- 2 sec backoff
- only while MV3 service worker remains active

If terminal failure:
- surface ERR

No persistent retry queue in v1.

Persistent retry via chrome.alarms = v2.

## Mandatory pre-implementation gates

DO THESE BEFORE WRITING THE EXTENSION.

### Status (as of 2026-08-24)

- Gate 1 — innerText: ✅ PASS (`spike/RESULTS/innerText.md`)
- Gate 2 — long-thread: 🟡 NOT VERIFIED — TL accepted risk; not a blocker. Documented in PRD §10 + `spike/RESULTS/long-thread.md`
- Gate 3 — label preservation: ⏳ pending (runbook in `spike/label-preservation-runbook.md`)

### Gate 1 — innerText spike

Create:
spike/chatgpt-dom-probe-innerText.js

Verify on a real settled thread:

- extraction succeeds
- count stable after 3 sec
- hash stable after 3 sec
- no unexpected mutations
- first 3 messages render correctly
- innerText/textContent lengths are reasonably consistent
- extraction uses innerText once per node

Result:
spike/RESULTS/innerText.md

### Gate 2 — long-thread spike (de-scoped, not a blocker)

**Status (2026-08-24, TL):** NOT VERIFIED — no real long-thread with known N ≥ 50 available in dev inventory. Risk explicitly accepted for v1. The extension captures messages currently rendered in the DOM at settle time; full historical-thread capture is deferred until a real long-thread test is available (good post-MVP regression test).

The spike code stays at `spike/chatgpt-dom-probe-long-thread.js`. When a real long-thread is available, run the spike with the correct N and backfill `spike/RESULTS/long-thread.md`.

Result:
spike/RESULTS/long-thread.md (currently NOT VERIFIED verdict)

### Gate 3 — label preservation

In Hister:
1. create/capture document
2. manually modify its label
3. recapture same ChatGPT URL
4. verify whether label survives upsert

Record:
spike/RESULTS/label-preservation.md

Decision must be documented before implementation.

## Acceptance tests

A1-A10 from PRD must remain unchanged.

Critical tests:

- ≥20 message real thread
- reload → no duplicate
- new message → same Hister document updated
- Hister unavailable → ERR
- empty messages excluded
- Cyrillic searchable
- label isolation
- canonical URL
- 50 reloads → exactly 1 document
- metadata conversation_id matches URL UUID

A11:
label preservation.

## Explicit non-goals

Do NOT add:

- streaming capture
- attachments
- image extraction
- file extraction
- Obsidian integration
- Qdrant
- Meilisearch
- separate SQLite
- server-side ChatGPT extractor
- multi-device sync
- historical bulk importer
- force-recapture UI

These belong to future iterations.

## Important implementation principle

Do not make Hister ChatGPT-aware.

The browser extension owns ChatGPT DOM knowledge.

Hister receives normalized documents only.

If ChatGPT changes its DOM:
→ fix extension, not Hister.

## First implementation milestone

After the three gates pass:

1. create MV3 manifest
2. create content.js
3. create service_worker.js
4. implement extraction
5. implement hash
6. implement storage
7. implement POST
8. implement retry
9. implement minimal popup
10. run A1-A11

## Source of truth

PRD.md is authoritative for v1 requirements.

This HANDOFF explains implementation context and verified assumptions.

Do not reopen settled architectural decisions without new evidence.

## Current blocker

No architectural blocker for the v1 scope (snapshot-of-DOM capture).

**Known v1 limit (documented inline in `content.js` and in dnote #22):** Cannot capture the full thread on a long ChatGPT conversation (>14-15 messages). chatgpt.com virtualizes the thread; the DOM only contains the current buffer window. Scroll does not materialize additional messages — verified by manual probe (dnote #22, section 5). Three scroll-march attempts were made and reverted (commits `5ccee76`, `ac00500`, reverted in `d22ed9c`); none grew the union.

**Path to full-thread capture (v2, not v1):** main-world content script injection (`world: "MAIN"`) to read chatgpt's internal Recoil/Redux state directly. Bypasses the virtualizer entirely but requires knowledge of chatgpt's state shape (will break on chatgpt updates).