# Hister ChatGPT Capture

Chrome MV3 extension that captures settled ChatGPT threads into the system
clipboard as Markdown.

`chatgpt.com/c/<uuid>` → `[data-message-author-role]` scroll-march
extraction → `**User:**` / `**Assistant:**` Markdown → system clipboard.

Manual capture only: popup button or hotkey `Alt+Shift+C`.

## Status

v0.6 (clipboard-only). The v0.5 Hister POST architecture was scope-cut on
2026-09-25; see `docs/PRD-chatgpt-ext.md` Appendix E for the dev history and
rationale. v0.6 spec lives in the same PRD §1-13 with the v0.5 appendices
(A-D) retained as historical.

## Repo layout

```
.
├── manifest.json         # MV3 manifest, clipboardWrite + activeTab + commands
├── content.js            # scroll-march extraction + Markdown build + toast
├── service_worker.js     # hotkey relay only (popup talks to content directly)
├── popup.html            # "Save thread to clipboard" button + status
├── popup.js              # extract → popup.writeText → toast via content
├── README.md             # this file
├── .gitignore
└── docs/
    ├── PRD-chatgpt-ext.md
    ├── Handoff.md         # archived v0.5 architecture reference
    └── spike/             # v0.5 pre-impl spike artifacts (historical)
```

## Quick start

1. `chrome://extensions/` → enable **Developer mode**
2. **Load unpacked** → select this repo root
3. Open a settled ChatGPT thread (`chatgpt.com/c/<uuid>`)
4. Click the extension icon → **Save thread to clipboard**
   *or* press **Alt+Shift+C** while the thread tab is focused
5. Paste anywhere. Format:

   ```markdown
   **User:**

   message text

   ---

   **Assistant:**

   response text

   ```

## Hard rules (do not violate)

- **Manual capture only.** No MutationObserver, no auto-settle-detector.
- **`innerText` once per node.** Single `messages[]` array, Markdown derived
  from same array. Phase 2.0 scroll-march algorithm unchanged from v0.5.
- **`activeTab` permission only.** No `<all_urls>`. Content script injects on
  `*://chatgpt.com/c/*` only.
- **No network calls.** No Hister, no telemetry, no Origin header (MV3 forbids).
- **No `chrome.storage`.** Clipboard is the only sink.
- **Popup-button writeText must be the next `await` after extract result.**
  Any delay risks popup closing mid-write.
- **Hotkey writeText needs chatgpt tab focused.** Failure mode: `NotAllowedError:
  Document is not focused` → content script surfaces an error toast.
  Documented limitation; offscreen-doc + `document.execCommand` fallback is
  v0.7 if this becomes a recurring issue.

## Markdown format

- `**User:**` and `**Assistant:**` role labels
- `---` separator between messages
- ```lang fenced code blocks preserved as-is from ChatGPT DOM
- Inline code with single backticks preserved
- No attachments, no images, no JSON envelope — plaintext only

## Acceptance tests (informal, manual)

Open a real thread with ≥ 20 messages (mix user/assistant), click save, paste
into a Markdown editor / Notepad. Verify:

- All messages present, in visual order
- Role labels intact
- Code blocks render correctly when pasted into Obsidian / Notion
- Toast appears bottom-right for ~2.5s with `Saved — N chars`
- Re-capture overwrites clipboard silently (no delta UX)

## Non-goals (v0.6)

Streaming capture, attachments, image/file extraction, Hister integration,
Qdrant/Meilisearch, separate SQLite, server-side ChatGPT extractor,
multi-device sync, historical bulk importer, force-recapture UI, OBS / Notion
auto-paste.

## Resuming work

1. Read `docs/PRD-chatgpt-ext.md` (v0.6 spec + Appendix E scope-cut rationale)
2. Read `docs/spike/RESULTS/innerText.md` (extraction evidence, reuse)
3. No further changes without TL sign-off on the v0.6 contract.
