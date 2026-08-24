# Gate 3 — Label Preservation Spike Result

**Date:** 2026-08-24
**Hister version:** v0.18.0 (running locally at http://127.0.0.1:4433)
**Run:** 1
**Test URL:** `https://chatgpt.com/c/label-test-20260824-1337`
**Method:** Black-box HTTP via `curl.exe` with `Origin: hister://` (CLI bypass) and JSON bodies from UTF-8 no-BOM files. Run script: `spike/tmp/run-gate3.ps1`.

## Outcome (A / B / C / D)

**Outcome:** **A — label overwritten**

Recapture via `POST /api/add` with the same URL and `label: "chatgpt"` replaced the manually-set label `chatgpt-modified-20260824-1337` back to `chatgpt`. `add_count` incremented from 2 → 3 and `updated` timestamp shifted, confirming the upsert path was hit and the new label was applied.

## Raw evidence

### Step 1 — Initial capture (label=chatgpt)

`POST /api/add` with body `{"url":"https://chatgpt.com/c/label-test-20260824-1337","title":"Label Preservation Test","text":"[USER] test content","label":"chatgpt","metadata":{...}}`

- `exit=0`
- Response body: *(empty — Hister 201 Created has no body)*
- `Origin: hister://` (CLI bypass of CSRF)

### Step 3 — Modify label via `/api/label`

`POST /api/label` with body `{"url":"...","label":"chatgpt-modified-20260824-1337"}`

- `exit=0`
- Response body: `{"ok":true}`

### Step 4 — `GET /api/document?url=...` after manual label change

```json
{
  "id": "https://chatgpt.com/c/label-test-20260824-1337",
  "url": "https://chatgpt.com/c/label-test-20260824-1337",
  "domain": "chatgpt.com",
  "html": "",
  "title": "Label Preservation Test",
  "text": "[USER] test content",
  "label": "chatgpt-modified-20260824-1337",
  "add_count": 2,
  "updated": 1787568146,
  "metadata": {
    "conversation_id": "label-test-20260824-1337",
    "message_count": 1,
    "source": "chatgpt"
  }
  ...
}
```

✅ Manual label change took effect. `add_count: 2` reflects the `Indexer.Save()` call from `/api/label`.

### Step 5 — Recapture (label=chatgpt again, same URL)

`POST /api/add` with the same body as Step 1.

- `exit=0`
- Response body: *(empty — 201 Created)*

### Step 6 — Final `GET /api/document?url=...`

```json
{
  "id": "https://chatgpt.com/c/label-test-20260824-1337",
  "url": "https://chatgpt.com/c/label-test-20260824-1337",
  "domain": "chatgpt.com",
  "html": "",
  "title": "Label Preservation Test",
  "text": "[USER] test content",
  "label": "chatgpt",
  "add_count": 3,
  "updated": 1787568148,
  "metadata": {
    "conversation_id": "label-test-20260824-1337",
    "message_count": 1,
    "source": "chatgpt"
  }
  ...
}
```

❌ Label is back to `chatgpt`. Manual edit lost. `add_count: 3` confirms the upsert path was hit. `updated: 1787568148` (was 1787568146) shows the doc was rewritten.

## Verdict checklist

- [x] Step 1 returned 2xx and Hister accepted the capture
- [x] Step 4 confirmed the doc label was changed to `chatgpt-modified-20260824-1337`
- [x] Step 5 returned 2xx and replaced the same doc (no new doc created)
- [x] Step 6 has a determinate final label (no ambiguity)
- [x] Outcome maps to exactly one row in the runbook's Step 7 table (row A)

**Verdict:** PASS

## Source-code cross-check (sanity)

`server/endpoints.go::serveUpdateLabel` (line ~1525) — `doc.Label = req.Label; c.Indexer.Save(doc)`. Direct assignment, no merge.

`server/endpoints.go::serveAdd` (line ~1474) — decodes entire JSON body into `&document.Document{}`, including `Label`. The new doc (with POST's `label` field) is then passed to `Indexer.AddContext` which upserts by `d.ID()` (URL-derived hash). The previous doc is fully replaced; no field is preserved from the stored version.

This matches the black-box result: any field in the POST body, including `label`, wins on recapture.

## Policy decision (for PRD update)

**Outcome A — overwrite.** Recommended PRD text for v1:

> **A11 (label preservation, v1):** On recapture via `POST /api/add`, every field in the POST body (including `label`) is the source of truth. Manual label edits in the Hister WebUI are **not preserved** on the next capture of the same URL. The extension always sends `label: "chatgpt"`; any user-set label will be overwritten on the next settled-thread capture.
>
> **v1 contract for label:** the extension owns the label value (`"chatgpt"`). If users want to keep their own labels, they must either (a) not use this extension on that thread, or (b) re-apply their label in Hister after each recapture. Future versions may add a "preserve manual label" rule, but that is a Hister-side change (a versioning rule that ignores the `label` field), not an extension-side change.

**Implementation consequence:** the extension should NOT attempt to "preserve" labels. It sends `label: "chatgpt"` on every POST. This is a v1 documented limitation, surfaced in the PRD and (optionally) the extension's README.

**Open follow-up (post-MVP, not a v1 blocker):** investigate Hister's versioning rules to see if a "do not overwrite `label` if non-default" rule can be configured server-side, so manual labels can be preserved without changing the extension.

## Notes

- `add_count` increments on every `Indexer.Save()` call (both `/api/label` and `/api/add`). Useful as a fingerprint for "how many times was this doc rewritten" during debugging.
- `updated` timestamp shifts only when content actually changes (the `serveAdd` path diffs against the existing doc before saving a version). In this test it moved 2 seconds because the timestamps were different — not a real content diff signal, just clock progression.
- The Hister language detector returned `"language":"fr"` for the body `[USER] test content`. Irrelevant to label preservation but noted for future tests.
- Step 7 cleanup failed (`query must not be empty` from `/api/delete`) — the delete endpoint expects a query string, not a JSON body. Test doc may still exist; if it shows up in future searches, the URL is unique enough to identify (`label-test-20260824-1337`).

## Decision

✅ **Gate 3 PASS** — Outcome A. v1 contract: extension owns the label. PRD A11 update proposed above; awaiting TL sign-off before implementation begins.
