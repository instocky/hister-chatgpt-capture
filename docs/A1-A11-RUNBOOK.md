# A1–A11 Manual Runbook

Target: validate the MVP against live Hister on real ChatGPT threads.
Time budget: ~25 min for A1–A10 + 5 min A11 (already verified, double-check).

## Pre-checks (1 min)

```powershell
# 1. Hister up?
Get-Process -Name hister -ErrorAction SilentlyContinue
# If empty: & "C:\Projects\_Others\hister\hister.exe" listen

# 2. /api/add responds?
$h = @{ "Content-Type" = "application/json; charset=utf-8" }
$probe = @{ url = "https://chatgpt.com/c/probe-a1-a11"; title = "probe"; text = "[USER] probe"; label = "chatgpt"; metadata = @{ source = "chatgpt"; conversation_id = "probe-a1-a11"; message_count = 1 } } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:4433/api/add" -Headers $h -Body $probe
# expect: HTTP 201, no body. (Optional cleanup later via /api/delete?url=...)

# 3. Extension loaded?
# chrome://extensions/ — Developer mode ON — Load unpacked — select this repo root.
# Verify: "Hister ChatGPT Capture" appears, no errors in service worker console.
```

## Test threads

- **Cyrillic** (reuse from Gate 1): `https://chatgpt.com/c/6a8bed08-fbc8-83ea-87ad-e45ce7c66320` (11 msgs, "Обсуждение Hister")
- **Long** (≥ 20 msgs, mix user/assistant): any real thread you have. If you don't have one, skip the count assertion in A1 and just verify the basics.

## Per-A instructions

For each A below, "expected" = what you should see. "Oracle" = how to confirm.

---

### A1 — Capture within 10s of last mutation + 3s settle

**Steps:**
1. Open the Cyrillic test thread in a fresh tab.
2. Wait 10s (5s for MO to settle + 3s debounce + 2s slack).
3. Look at the extension action button (puzzle piece near address bar). It should show badge "OK" (green).
4. Click the action button → popup should show:
   - State: OK
   - URL: `https://chatgpt.com/c/6a8bed08-...`
   - Conversation: `6a8bed08-...`
   - Messages: `11`
   - Hash: first 12 hex chars + `…`

**Oracle (Hister side):**
```powershell
Invoke-RestMethod "http://127.0.0.1:4433/api/document?url=https://chatgpt.com/c/6a8bed08-fbc8-83ea-87ad-e45ce7c66320"
# expect: 200, label=chatgpt, message_count in metadata = 11, text starts with "[USER]"
```

**Pass:** badge OK + Hister has exactly 1 doc for this URL.

---

### A2 — Reload, no new doc

**Steps:**
1. With the same thread tab open, press F5 (reload).
2. Wait 10s.
3. Check badge: still "OK".

**Oracle (Hister side, count check):**
```powershell
# Before reload, count docs for this URL:
$before = (Invoke-RestMethod "http://127.0.0.1:4433/api/document?url=https://chatgpt.com/c/6a8bed08-fbc8-83ea-87ad-e45ce7c66320").add_count
# After reload + 10s:
$after = (Invoke-RestMethod "http://127.0.0.1:4433/api/document?url=https://chatgpt.com/c/6a8bed08-fbc8-83ea-87ad-e45ce7c66320").add_count
"before=$before after=$after"
# expect: add_count UNCHANGED (no new /api/add fired; dedupe by hash).
```

**Pass:** `before == after`. No POST sent (SW dedupes by hash).

---

### A3 — New message → same Hister doc updated

**Steps:**
1. In the thread, type any new message and submit (let ChatGPT respond and settle).
2. Wait 10s after the last reply.
3. Badge: "OK".

**Oracle:**
```powershell
$doc = Invoke-RestMethod "http://127.0.0.1:4433/api/document?url=https://chatgpt.com/c/6a8bed08-fbc8-83ea-87ad-e45ce7c66320"
$doc.text | Select-String -Pattern "your new message text"  # should be found
$doc.add_count  # should be higher than after A2 (one new write)
```

**Pass:** text contains the new message; `id`/`url` unchanged (same canonical doc, upsert in place).

---

### A4 — Hister down → ERR

**Steps:**
1. Stop Hister: `Stop-Process -Name hister -Force`
2. In the same thread, send another message and wait for ChatGPT to reply (or just trigger a mutation: edit + revert a message).
3. Wait ~10s. Badge should show "ERR" (red) within 3 retry attempts × 2s = ~6s of total backoff after the first failure.

**Oracle (chrome://extensions/ → service worker console):**
- Look for the failed fetch error.
- Badge: red "ERR".

**Pass:** badge ERR, no silent failure. Then restart Hister (`& "C:\Projects\_Others\hister\hister.exe" listen`).

---

### A5 — Empty messages excluded

**Steps:**
1. Re-trigger a capture on the Cyrillic thread.
2. Open the captured text in Hister WebUI (`http://127.0.0.1:4433`).

**Oracle:**
```powershell
$doc = Invoke-RestMethod "http://127.0.0.1:4433/api/document?url=https://chatgpt.com/c/6a8bed08-fbc8-83ea-87ad-e45ce7c66320"
# Count [USER] + [ASSISTANT] markers in the flattened text:
$matches = [regex]::Matches($doc.text, '^\[(USER|ASSISTANT)\]', [System.Text.RegularExpressions.RegexOptions]::Multiline)
"marker_count=$($matches.Count)"
# expect: 11 (matches metadata.message_count)
```

**Pass:** marker count == metadata.message_count == 11. No `[USER] ` (empty) lines.

---

### A6 — Cyrillic round-trip

**Steps:** capture is already done from A1.

**Oracle (WebUI):**
1. Open `http://127.0.0.1:4433`.
2. Search: `Хистер` (or any Cyrillic word from the thread).
3. Confirm the doc appears in the results.

**Pass:** Cyrillic search returns the captured doc.

---

### A7 — Label isolation (0 leak to label:youtube)

**Oracle:**
```powershell
$youtube = Invoke-RestMethod "http://127.0.0.1:4433/api/search?q=label:youtube"  # adjust if Hister uses different search endpoint
# OR WebUI: search "label:youtube" → should NOT include the chatgpt doc
```

**Pass:** 0 chatgpt docs visible under `label:youtube`. All chatgpt docs have `label:chatgpt`.

---

### A8 — URL canonical (no `?model=o1` variants)

**Steps:** none (passive). Just verify via:
```powershell
$doc = Invoke-RestMethod "http://127.0.0.1:4433/api/document?url=https://chatgpt.com/c/6a8bed08-fbc8-83ea-87ad-e45ce7c66320?model=o1-preview"
# expect: 200 (Hister canonicalises by URL hash, drops query)
$doc2 = Invoke-RestMethod "http://127.0.0.1:4433/api/document?url=https://chatgpt.com/c/6a8bed08-fbc8-83ea-87ad-e45ce7c66320"
"id_match=$($doc.id -eq $doc2.id)"
```

**Pass:** both URLs return the same Hister doc.

---

### A9 — 50 reloads → exactly 1 doc

**Steps:**
1. In dev tools console on the thread tab, run:
   ```js
   for (let i = 0; i < 50; i++) location.reload()
   ```
   (or use a `setInterval` to spread over time — instant loop is OK because dedupe is by hash).
2. Wait 30s.

**Oracle:**
```powershell
# In Hister, search label:chatgpt and the URL:
$results = Invoke-RestMethod "http://127.0.0.1:4433/api/search?q=label:chatgpt+6a8bed08"  # adjust to your search endpoint
"doc_count=$($results.Count)"  # expect: 1
# OR
$doc = Invoke-RestMethod "http://127.0.0.1:4433/api/document?url=https://chatgpt.com/c/6a8bed08-fbc8-83ea-87ad-e45ce7c66320"
"add_count=$($doc.add_count)"  # expect: low single digit (initial + a few hash-changed captures, NOT 50)
```

**Pass:** exactly 1 doc for the URL. `add_count` not 50+ (proves dedupe by hash, not by per-reload POST).

---

### A10 — Metadata `conversation_id` matches URL UUID

**Oracle:**
```powershell
$doc = Invoke-RestMethod "http://127.0.0.1:4433/api/document?url=https://chatgpt.com/c/6a8bed08-fbc8-83ea-87ad-e45ce7c66320"
"conv_id=$($doc.metadata.conversation_id)"
# expect: "6a8bed08-fbc8-83ea-87ad-e45ce7c66320"
```

**Pass:** metadata.conversation_id == URL UUID.

**Note:** `metadata.*` is not indexed in Hister (per `docs/spike/RESULTS/innerText.md` upstream context + dnote #15). Visible in doc detail view, not searchable. That's the documented v1 limitation.

---

### A11 — Label preservation (already verified, double-check)

Gate 3 result: Outcome A — `serveAdd` overwrites label on recapture.
Runbook: `docs/spike/label-preservation-runbook.md`.
Result: `docs/spike/RESULTS/label-preservation.md`.

**Re-verify (5 min, optional):**
1. Open the doc in Hister WebUI, manually change the label to e.g. `chatgpt-test-A11`.
2. Trigger a recapture (edit + revert a message in the ChatGPT thread to fire MO, wait 10s).
3. Check the doc: label is back to `chatgpt`.

**Pass:** label reverted to `chatgpt` (v1 documented limitation, A11 in PRD).

---

## After A1–A11

```powershell
# 1. Cleanup probe doc from Pre-checks
Invoke-RestMethod "http://127.0.0.1:4433/api/delete?url=https://chatgpt.com/c/probe-a1-a11"
# (or via WebUI)

# 2. Final Hister doc count for label:chatgpt — should be the captured Cyrillic thread only (1 doc).
# WebUI: search "label:chatgpt" → count
```

## Result record

Fill in after the run:

| A | Pass/Fail | Notes |
|---|---|---|
| A1 | | |
| A2 | | |
| A3 | | |
| A4 | | |
| A5 | | |
| A6 | | |
| A7 | | |
| A8 | | |
| A9 | | |
| A10 | | |
| A11 | | (already verified in docs/spike/RESULTS/label-preservation.md) |

When all 11 are green, MVP is shippable. Per PRD §13 DoD:
- ext code in this repo ✓
- A1–A10 green (A11 already verified)
- Brief README ✓
- Hister doc count check before/after baseline
