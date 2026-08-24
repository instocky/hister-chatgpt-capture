# Gate 3 — Label Preservation Runbook

## Goal

Determine whether a manually-set label on a Hister document survives when the
same URL is recaptured via `POST /api/add` (the upsert path the extension will
use). The answer dictates v1 policy: label-overwrite vs label-preserve.

## Setup

- Hister running locally at `http://127.0.0.1:4433`.
- Pick a unique test URL not already in Hister, e.g.:
  `https://chatgpt.com/c/label-test-<timestamp>`
- Substitute `<timestamp>` consistently across all steps below (e.g. a date
  like `20260824-1330` or a random suffix).

The test is a black-box sequence of 4 HTTP exchanges against the real Hister
instance. Record every response and the final label value.

## Step 1 — Initial capture (label = `chatgpt`)

```powershell
$ts = "20260824-1330"
$url = "https://chatgpt.com/c/label-test-$ts"
$body = @{
  url    = $url
  title  = "Label Preservation Test"
  text   = "[USER] test content for label preservation"
  label  = "chatgpt"
  metadata = @{
    source          = "chatgpt"
    conversation_id = "label-test-$ts"
    message_count   = 1
  }
} | ConvertTo-Json

curl.exe -X POST http://127.0.0.1:4433/api/add `
  -H "Content-Type: application/json; charset=utf-8" `
  -d $body
```

**Record response (status, body):** ___

## Step 2 — Wait for Hister to settle

```powershell
Start-Sleep -Seconds 2
```

## Step 3 — Modify the label

Use Hister WebUI or an API endpoint to change the doc's label to
`chatgpt-modified-$ts`. Record the method used.

**Method (WebUI / API / other):** ___

If via API and you know the endpoint, record the exact call:
```text
<command>
```

## Step 4 — Verify the label was changed

Query Hister and confirm the doc's label is now `chatgpt-modified-$ts`.

```powershell
curl.exe "http://127.0.0.1:4433/api/search?q=label:chatgpt-modified-$ts"
```

**Record response — what label do you see on the doc?** ___

If the doc is not findable by `label:chatgpt-modified-$ts`, the test setup is
broken — fix and restart from Step 1.

## Step 5 — Recapture the same URL (label = `chatgpt` again)

```powershell
curl.exe -X POST http://127.0.0.1:4433/api/add `
  -H "Content-Type: application/json; charset=utf-8" `
  -d $body
```

**Record response (status, body):** ___

## Step 6 — Check the final label

Same query as Step 4.

```powershell
curl.exe "http://127.0.0.1:4433/api/search?q=label:chatgpt-modified-$ts"
curl.exe "http://127.0.0.1:4433/api/search?q=label:chatgpt"
```

**Record what you find:**
- Doc found by `label:chatgpt-modified-$ts`? yes / no
- Doc found by `label:chatgpt`? yes / no
- Final label value: ___

## Step 7 — Determine the outcome

| Outcome | Detection | v1 Implication |
|---|---|---|
| **A — label overwritten** | Doc found by `label:chatgpt`, not by `label:chatgpt-modified-$ts` | Re-POST replaces the doc and the label. Document in PRD: "label is capture-source-of-truth; manual edits lost on recapture". UI implication: Hister WebUI must surface this so users do not edit labels they expect to keep. |
| **B — label preserved** | Doc found by `label:chatgpt-modified-$ts`, not by `label:chatgpt` | Re-POST preserves manually-edited label. Document in PRD: "manual label edits survive recapture". This is the friendlier default — flag it as a Hister behavior, not extension behavior. |
| **C — multi-label / merged** | Doc found by both `label:chatgpt` and `label:chatgpt-modified-$ts` (Hister supports arrays) | Hister has multi-label semantics. Investigate Hister label model before implementation; extension may need to send label as additive rather than replace. |
| **D — error / no doc** | Re-POST failed or doc disappeared | Re-run with Hister logs visible. Not a feature of upsert — likely a config / ID collision / 5xx. |

**Outcome:** A / B / C / D

**Brief evidence (paste relevant lines from responses):**
```text
<evidence>
```

## Notes

- Use a unique URL each run. Otherwise a previous test's doc can pollute results.
- If the Hister API has a different label-edit endpoint, record it in Step 3 — the result still tells us the policy, regardless of which tool was used to set it.
- Hister upsert is on `d.ID()` (URL-derived). Re-POSTing the same URL *should* hit the same canonical document. If Step 5 produces a new doc instead of replacing, that is itself a finding — record it.
