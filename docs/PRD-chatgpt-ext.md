---
title: PRD — Hister ChatGPT Capture (MV3 extension)
status: Draft
version: 0.6
date: 2026-08-24
owner: mavis (TL) → dev
target: C:\Projects\Extantions\20260824_hister-chatgpt-capture
refs:
  - dnote agent-memory #13, #15, #16, #18, #19
  - server/indexer/indexer.go:1073-1157 (upsert behavior)
  - server/document/document.go:25-51 (Document struct)
  - server/endpoints.go:684-754 (serveAdd)
  - server/server.go:343-355 (CSRF bypass for extension origins)
---

# PRD — Hister ChatGPT Capture (MV3 extension)

## 1. Context

Personal KB pipeline. Hister v0.18.0 = dumb-pipe, Bleve FTS, MCP, WebUI. Capture layer = browser extensions. H1–H3 confirmed (server-side, dumb-pipe, MCP). H4 spike (`spike/chatgpt-dom-probe.js`) confirmed DOM stable on settled threads: container `[data-message-author-role]`, hash stable ≥ 3s, 1/8 empty messages, 0 mutations on settled.

Goal: lock v1 scope of the ChatGPT extension so we can ship MVP without scope creep.

## 2. Goal

Auto-capture settled ChatGPT threads to Hister with `label=chatgpt`. **One thread URL → one canonical Hister document**, replaced on content change. No user interaction required.

## 3. Non-goals (v1)

- Live streaming capture (token-by-token). v1 captures settled threads only.
- Image / file attachment capture.
- Code-block syntax preservation beyond `innerText`. **Markdown/HTML formatting is intentionally flattened in v1** (preferred for FTS + personal memory).
- Per-message metadata (timestamp, model, token count).
- Manual re-capture / edit / delete from extension UI.
- Multi-tab coordination beyond last-writer-wins.
- Auth (Hister local: no auth on `/api/add` for extension origin).

## 4. User story

`As a personal KB user, when I open a ChatGPT thread chatgpt.com/c/<uuid> with ≥ 1 non-empty message, the extension auto-captures it to Hister within ~10s of the last relevant DOM mutation, so that I can later search it via WebUI / MCP / LLM.`

## 5. Architecture (v0.2 — split responsibilities)

```
ChatGPT DOM
   ↓
content.js (capture only — DOM extraction, hash, debounce, empty filter)
   ↓ chrome.runtime.sendMessage({ url, title, text, label, metadata })
Service Worker (background script)
   ↓ fetch() — Chrome sets `Origin: chrome-extension://<id>` automatically
http://127.0.0.1:4433/api/add
   ↓
Hister upsert by URL (one canonical doc per thread)
```

**Rationale:**
- **Content script** runs in the page's security context; cross-origin network calls belong in the service worker with declared `host_permissions`.
- **`Origin` header is a forbidden request header** in MV3 — Chrome sets it automatically based on the extension's origin. We must NOT set it manually.
- Hister already accepts `chrome-extension://<id>` for CSRF bypass (`server.go:343-355`), so the SW fetch with default Origin works.

## 6. Functional requirements

| # | Requirement | Notes |
|---|---|---|
| F1 | Manifest MV3, match pattern `*://chatgpt.com/c/*` | host perms: chatgpt.com only |
| F2 | Service worker (background script) for all I/O | `chrome.runtime.sendMessage` from content → SW |
| F3 | Parse messages: `[data-message-author-role="user"\|"assistant"]` | selector from spike #18 |
| F4 | **Extract-once pattern:** build `messages[]` once, then derive hash + flattened text from same array. Reference shape: `messages = [...].map(el => ({role, text: el.innerText.trim()})).filter(m => m.text.length > 0)`. `innerText` MUST be called once per node — see §15. |
| F5 | Flatten text: `[USER] msg1\n[ASSISTANT] msg2\n…` from the same `messages[]` array (no second `innerText` call) | plain text only; HTML intentionally dropped |
| F6 | Compute hash: `messages.map(m => \`${m.role}:${m.text}\`).join("\n---\n")`, SHA-256 hex. Hash source = `messages[].text` from F4, never re-extracts. |
| F7 | On hash change vs stored value → debounce 3s post last DOM mutation → POST | `Hash computation MUST happen before POST` — primary defence against DOM noise |
| F8 | POST body shape: `{ url, title, text, label: "chatgpt", metadata: {...} }`; `Content-Type: application/json; charset=utf-8` | No manual `Origin` header — Chrome sets it |
| F9 | Metadata block: `{ source: "chatgpt", conversation_id: "<uuid>", message_count: <int> }` | Stored but not indexed (Hister `metadata.*` is `Index=false`). Use `label:chatgpt` as primary filter |
| F10 | `chrome.storage.local` schema per URL: `{ hash, updatedAt, messageCount, conversationId }` | survives reload, dedupes reopens; no need to store Hister doc id (upsert by URL) |
| F11 | On POST failure → retry up to 3× with 2s backoff **while service worker remains active**; on terminal failure surface error | popup badge "ERR". **SW lifetime is not guaranteed by MV3** — Chrome may unload SW between retry ticks. Full persistent retry via `chrome.alarms` is v2. |
| F12 | MutationObserver(document.body, { childList, subtree, characterData }) with re-attach on root replace | SPA re-render safety |
| F13 | url = `location.origin + location.pathname` (drop query/fragment) | normalize `?model=o1` variants to same URL |
| F14 | title = `document.title` | fallback human-readable |
| F15 | popup.html: status (idle / capturing / OK / ERR), capture count for current thread | optional but cheap |

## 7. Non-functional

- **Privacy:** no telemetry, no remote calls except `127.0.0.1:4433`. Captures only on `/c/*`.
- **Perf:** capture + POST < 500ms after settle on a 50-msg thread.
- **Resilience:** SPA re-render (root swap) must not lose observer. **Hister down at capture time → ERR + drop. Persistent retry across SW unload is v2 (`chrome.alarms`).**
- **Security:** no `eval`, no remote code, no `web_accessible_resources` to chatgpt.com.
- **Idempotency:** same content + same URL = exactly 1 doc in Hister (Hister upsert + ext hash dedupe).

## 8. Acceptance criteria

- A1: Open real thread (≥ 20 msgs, mix user/assistant) → exactly 1 doc in Hister within 10s of the **last relevant DOM mutation** + 3s settle.
- A2: Reload same thread, no edits → 0 new docs (hash unchanged → no POST).
- A3: Add a new message → 1 doc in Hister, content reflects latest state (Hister upsert replaces in place — no duplicates, no version chain).
- A4: Hister stopped before capture → badge shows "ERR", retries 3×, no silent failure.
- A5: Empty messages excluded — verify count match (probe had 1/8).
- A6: Cyrillic round-trip — search via WebUI returns the doc on Cyrillic query.
- A7: 0 docs leaked to `label:youtube` filter (label isolation).
- A8: URL in Hister = `chatgpt.com/c/<uuid>` (no query/fragment, no `?model=o1` variants).
- A9: Doc count for `label:chatgpt` after 50 reloads of the same thread = 1 (not 50).
- A10: Metadata `conversation_id` matches the URL UUID; not searchable (Index=false), but visible in doc detail view.

## 9. Out of scope (v2+)

- Streaming / live capture.
- Attachments (images, files, code artifacts).
- Per-thread model selector.
- Sync across devices.
- Obsidian export trigger.
- Bulk re-capture of historical threads.
- Chrome sync for hash storage.
- "Force recapture" button in popup.

## 10. Risks

| Risk | Mitigation |
|---|---|
| ChatGPT DOM selector changes | MutationObserver + selector fallback chain; spike captures current snapshot as regression baseline |
| Long threads (> 1000 msgs) — ChatGPT may virtualize | **Pre-impl spike:** open a thread with **known ground-truth message count N** (user counts from a fresh thread before ChatGPT does any windowing; or count exported via "Share" JSON if available). Acceptance: `extracted_count === N`. If ext sees fewer → ChatGPT virtualizes → need scroll-to-bottom to materialize all messages before capture (v1 limitation: capture only what's rendered at the time MutationObserver fires settle). **TL decision (2026-08-24):** spike not runnable in current dev inventory (no thread with known N ≥ 50 available). Risk explicitly accepted. The extension captures messages currently rendered in the DOM at settle time. Long-thread / DOM virtualization is **not verified** in v1; full historical-thread capture is deferred until a real long-thread test is available (post-MVP regression test, not a pre-impl blocker). See `spike/RESULTS/long-thread.md`. |
| Hister down on browser open | Retry 3× within SW lifetime; if all fail → ERR badge, capture dropped. **No persistent queue in v1** (SW can be unloaded between retries — `chrome.alarms` retry is v2) |
| Extension ID rotation (MV3 = stable per install) | Document ID; user copies from `chrome://extensions` if needed |
| Two tabs open on same URL | Both race; last writer wins; both write same content → 1 doc. Acceptable for v1 |

## 11. Resolved (v0.1 → v0.2)

- **Q3 — Hister upsert semantics** ✅
  - `/api/add` upserts on `d.ID()` (URL-derived hash) — `server/indexer/indexer.go:1073-1157` (`getStoredDocumentState` + `Index(d.ID(), d)`)
  - Default config: no versioning rules match → re-POST replaces in place, no version history saved
  - `Document.Metadata` (`map[string]any`) accepted in JSON body — `server/document/document.go:43`
  - **Conclusion: one URL = one canonical document. No DELETE-then-ADD, no `histerDocumentId` storage needed in ext.**

## 12. Open questions (v0.2)

- Q1: `chrome.storage.local` quota for `url → {...}` map? Default 10MB; one entry ≈ 200 bytes → 50k threads fine. ✅ No action.
- Q2: Behavior on re-capture when previous doc has label/notes — re-POST preserves them? Need a test (A11, add): edit a doc label in Hister, re-capture, label preserved.
- Q3: Should popup have a "Force recapture" button for debugging? Recommend v2.

## 15. Pre-impl innerText re-spike (mandatory)

> **Architectural note:** spike must validate the **extract-once pattern** (F4). Probe must call `innerText` once per message node, not twice — to measure real perf cost on long threads.

Existing spike (`spike/chatgpt-dom-probe.js`) used `textContent`. New probe `spike/chatgpt-dom-probe-innerText.js` must mirror the old structure but with `innerText` extraction, on a real open thread. Must verify:

| Check | Pass criterion |
|---|---|
| Extraction runs without exception | OK |
| `count` matches `count_after_3s` | 0 deltas (no streaming) |
| `hash_initial === hash_after_3s` | true |
| `mutations_observed_3s` | 0 (settled) or traceable to expected streaming events |
| Sample of first 3 messages renders correctly (visible text, not script content) | qualitative |
| Per-message `innerText` length consistent with `textContent` length (± 5% drift acceptable) | both recorded for comparison |

If probe fails or shows non-zero mutations on a settled thread → revert to `textContent` (Q4 reopen). Probe result captured in `spike/RESULT-chatgpt-dom-innerText.md` before implementation starts.

## 13. Definition of done

- ext code in `C:\Projects\Extantions\20260824_hister-chatgpt-capture\`
- A1–A10 all green on manual run
- A11 (label preservation) verified
- Pre-impl long-thread spike passed (≥ 1 known long thread, all messages present in DOM)
- Brief README with install + load unpacked steps
- Hister doc count check (curl `?q=label:chatgpt`) before/after baseline

---

## Appendix A — v0.1 → v0.2 changelog

- **F7 rewrite:** drop manual `Origin` header. Chrome sets it automatically. `Origin` is a forbidden request header in MV3.
- **New section 5 (Architecture):** explicit split content script = capture only, service worker = network/storage/retry.
- **F8 extended metadata:** `metadata: { source, conversation_id, message_count }` in POST body. Stored but not indexed (Hister limitation). `label:` remains primary filter.
- **F10 extended storage schema:** `{ hash, updatedAt, messageCount, conversationId }` (was just `url → hash`).
- **A3 rewrite:** hash change → POST → Hister replaces in place → exactly 1 doc. No "TBD", no version chain.
- **A8 added:** URL normalization (drop query/fragment) — prevents `?model=o1` creating duplicate doc.
- **A9 added:** idempotency stress (50 reloads → 1 doc).
- **A10 added:** metadata presence in detail view.
- **Section 11 (Resolved):** Q3 closed with code evidence. No more `TBD` on upsert semantics.
- **New pre-impl spike:** long-thread DOM virtualization check (Section 10 Risks).

## Appendix B — v0.2 → v0.3 changelog (TL review)

- **F4/F6 clarified:** explicit "extraction source MUST match hashing source" rule — guards against textContent/innerText drift between F4 and F6 (open Q4 below).
- **F11 qualified:** retry 3× bounded to **SW active lifetime**. MV3 SW can be unloaded between retries. `chrome.alarms` persistent retry → v2.
- **Resilience (NFR) qualified:** "Survive Hister restart" removed. v1 = best-effort within SW lifetime, drop + ERR otherwise.
- **Risk #Hister-down qualified:** same — no persistent queue in v1.
- **Risk #Long-threads re-orchestrated:** oracle changed from "UI visible count" (unreliable — both UI and DOM may be windowed) to **ground-truth N from user / Share JSON / fresh-thread count**. Pre-impl spike updated accordingly.

## Open Q (v0.5)

Q1–Q3 (v0.2) and Q4 (v0.3) all closed. No open questions blocking sign-off.

## Appendix C — v0.4 → v0.5 changelog (final TL review)

- **§3 stale text fixed:** "textContent" → "innerText" in non-goals.
- **F4/F5/F6 rewritten as "extract-once" pattern:** single `messages[]` array built once with `innerText.trim()`; hash + flattened text derived from same array. Eliminates double `innerText` call (forced-layout cost on long threads).
- **§15 spike note:** added explicit reminder to validate the extract-once pattern in pre-impl probe.

## Appendix D — Status for TL sign-off

- Architecture: ✅ locked
- Upsert semantics: ✅ verified by code
- Storage schema: ✅ defined
- Acceptance criteria: ✅ A1–A11 with testable oracles
- Gate 1 — innerText extract-once: ✅ PASS (`spike/RESULTS/innerText.md`, 2026-08-24)
- Gate 2 — long-thread / virtualization: 🟡 NOT VERIFIED — TL decision 2026-08-24: risk explicitly accepted; not a pre-impl blocker. Documented in §10 + `spike/RESULTS/long-thread.md`. Post-MVP regression test.
- Gate 3 — label preservation: ⏳ pending (runbook in `spike/label-preservation-runbook.md`)
- Q2 (label preservation): resolves with Gate 3 result
- **Awaiting: TL sign-off + Gate 3 result**



- **Q4 (TL review, #1):** `textContent` vs `innerText` for F4. **H4 spike used `textContent`** (spike/chatgpt-dom-probe.js:21,26,39). TL argues `innerText` better matches visible rendering but requires re-spike to verify (5 min) and adds forced-layout cost on long threads. **Decision: `innerText`.** Re-spike mandatory before implementation; F4/F6 updated to use `innerText` with extraction/hash coherence guard.

---

## Appendix E — v0.5 → v0.6 changelog (scope cut: Hister → clipboard)

**Scope cut decided 2026-09-25.** This is a sibling-branch rewrite, not a regression. All previous appendices (A–D) describe the **archived v0.5 contract** (Hister POST). They remain in this document for dev history only and are NOT the spec for v0.6.

### What changed

- **Sink replaced:** Hister `POST /api/add` → system clipboard via `navigator.clipboard.writeText`. No more network, no more storage, no more dedup hash. The whole Hister-client layer (service_worker retry loop, `chrome.storage.local` dedup, declarative CSRF rule, badge state machine) is gone.
- **Format:** Markdown with `**User:**` / `**Assistant:**` role labels, `---` separator between messages, ```lang code fences preserved as-is from the ChatGPT DOM. Final plaintext only — no attachments, no JSON envelope.
- **Triggers:** popup button **and** browser hotkey `Alt+Shift+C` (`commands.save-clipboard`). Both manual-only. The auto-settle-detector that previously lived in `service_worker.js` is removed.
- **Feedback:** in-page toast overlay, bottom-right, 2.5s auto-fade, no click-to-dismiss. Text: `Saved — N chars`. Error toast (red) on write failure.

### What stayed

- **Extraction:** `[data-message-author-role]` scroll-march (Phase 2.0 algorithm, v0.3 spec). `innerText` capture strategy. Roles filtered to `user`/`assistant`. Empty messages excluded (A5). Visual order by Y ascending.
- **Single-flight guard** against overlapping captures.
- **Restoring scroll position** after materialize.
- **`materializeAndCapture()` entry point** renamed to `materializeAndReturnMarkdown()` (no SW dispatch at the end).
- **`canonicalUrl()` and `conversationId()`** helpers retained (still useful for logging and dev-console probes).

### Architecture (v0.6)

```
HOTKEY Alt+Shift+C                    POPUP BUTTON
        ↓                                     ↓
  Service Worker                        popup.js
  (chrome.commands.onCommand)                ↓
        ↓                              chrome.tabs.sendMessage
  chrome.tabs.sendMessage                   {type:'EXTRACT'}
        {type:'EXTRACT_WRITE_TOAST'}             ↓
        ↓                                 content.js
  content.js                              - materialize via scroll-march
  - materialize via scroll-march          - buildMarkdown(messages)
  - buildMarkdown(messages)               - return {ok, md, chars, count}
  - navigator.clipboard.writeText(md)         ↓
    (chatgpt tab focused at hotkey time)  popup.js
  - showToast('Saved — N chars')          - navigator.clipboard.writeText(md)
                                               (popup focused, no focus issue)
                                               ↓
                                          chrome.tabs.sendMessage
                                             {type:'TOAST', text}
                                               ↓
                                          content.js shows overlay
```

### Manifest diff (v0.6)

- `permissions`: `storage`, `declarativeNetRequest` → `clipboardWrite`, `activeTab`
- `host_permissions`: `http://127.0.0.1:4433/*` removed
- `declarative_net_request` block + `rules.json` deleted
- `commands.save-clipboard` added (`Alt+Shift+C`)
- `version` bump `0.1.0` → `0.2.0`

### Why clipboard (TL rationale)

- Removes Hister as a hard runtime dependency (it was already dropped from v0.5 dev loop)
- Aligns with "personal KB pipeline" — user pastes into whatever tool they want
- Cuts ~120 lines of network/retry/storage code, no loss of capture fidelity (extraction was the proven part)
- Avoids Hister label-preservation concern (A11) entirely — the extension no longer touches docs

### Known limitations (v0.6, accepted)

- Hotkey `Alt+Shift+C` requires chatgpt tab to be focused at hotkey time. If focus is elsewhere (DevTools, another window), `writeText` from content script rejects with `NotAllowedError: Document is not focused`. Error toast surfaces the failure. **Future v0.7:** offscreen-doc fallback with legacy `document.execCommand('copy')` if focus becomes a recurring issue.
- Popup-button write succeeds even with DevTools focused (popup itself is focused + secure context).
- No re-capture delta UX — second click overwrites clipboard silently. Char count in toast always reflects current snapshot, not delta.

### Verification status

- **Popup-button path:** verified on `chatgpt.com/c/<uuid>` — write succeeds, toast appears, clipboard contains expected Markdown.
- **Hotkey path:** verified in `probe/` spike — write succeeds when chatgpt tab focused.
- **Extraction algorithm:** unchanged from v0.5, no regression risk by definition.
- **Not yet verified:** hotkey with chatgpt tab unfocused (known limitation, deferred to v0.7).
