# A1–A11 — Ручной прогон (manual runbook)

Цель: прогнать MVP против живого Hister на реальных ChatGPT-тредах.
Бюджет времени: ~25 мин на A1–A10 + 5 мин на A11 (уже verified, дубль-проверка).

## Pre-checks (1 мин)

```powershell
# 1. Hister поднят?
Get-Process -Name hister -ErrorAction SilentlyContinue
# Если пусто: & "C:\Projects\_Others\hister\hister.exe" listen

# 2. /api/add отвечает?
$h = @{ "Content-Type" = "application/json; charset=utf-8" }
$probe = @{ url = "https://chatgpt.com/c/probe-a1-a11"; title = "probe"; text = "[USER] probe"; label = "chatgpt"; metadata = @{ source = "chatgpt"; conversation_id = "probe-a1-a11"; message_count = 1 } } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:4433/api/add" -Headers $h -Body $probe
# ожидаем: HTTP 201, пустое тело. (Потом можно удалить через /api/delete?url=...)

# 3. Расширение загружено?
# chrome://extensions/ — Developer mode ON — Load unpacked — выбрать корень этого репо.
# Проверить: "Hister ChatGPT Capture" появилось, в service worker console нет ошибок.
```

## Тестовые треды

- **Кириллический** (переиспользуем из Gate 1): `https://chatgpt.com/c/6a8bed08-fbc8-83ea-87ad-e45ce7c66320` (11 сообщений, "Обсуждение Hister")
- **Длинный** (≥ 20 сообщений, микс user/assistant): любой реальный тред. Если такого нет — пропусти проверку count в A1, валидируй только базу.

## Пошаговые A-тесты

Для каждого A ниже: "ожидаемо" = что должно произойти, "oracle" = как подтвердить.

---

### A1 — Capture в пределах 10s от последней мутации + 3s settle

**Шаги:**
1. Открыть кириллический тестовый тред в новой вкладке.
2. Подождать 10s (5s на settle + 3s debounce + 2s запас).
3. Посмотреть на кнопку расширения (пазл рядом с адресной строкой). Должен быть badge "OK" (зелёный).
4. Кликнуть на кнопку → popup должен показать:
   - State: OK
   - URL: `https://chatgpt.com/c/6a8bed08-...`
   - Conversation: `6a8bed08-...`
   - Messages: `11`
   - Hash: первые 12 hex-символов + `…`

**Oracle (со стороны Hister):**
```powershell
Invoke-RestMethod "http://127.0.0.1:4433/api/document?url=https://chatgpt.com/c/6a8bed08-fbc8-83ea-87ad-e45ce7c66320"
# ожидаем: 200, label=chatgpt, message_count в metadata = 11, text начинается с "[USER]"
```

**Pass:** badge OK + в Hister ровно 1 doc на этот URL.

---

### A2 — Reload, новых doc'ов нет

**Шаги:**
1. На той же вкладке треда нажать F5 (reload).
2. Подождать 10s.
3. Проверить badge: всё ещё "OK".

**Oracle (со стороны Hister, проверка счётчика):**
```powershell
# До reload, посчитать записи для этого URL:
$before = (Invoke-RestMethod "http://127.0.0.1:4433/api/document?url=https://chatgpt.com/c/6a8bed08-fbc8-83ea-87ad-e45ce7c66320").add_count
# После reload + 10s:
$after = (Invoke-RestMethod "http://127.0.0.1:4433/api/document?url=https://chatgpt.com/c/6a8bed08-fbc8-83ea-87ad-e45ce7c66320").add_count
"before=$before after=$after"
# ожидаем: add_count НЕ изменился (нового /api/add не было; dedupe по hash).
```

**Pass:** `before == after`. POST не отправлен (SW дедупит по hash).

---

### A3 — Новое сообщение → тот же Hister doc обновляется

**Шаги:**
1. В треде напечатать любое новое сообщение и отправить (дождаться, пока ChatGPT ответит и тред осядет).
2. Подождать 10s после последнего ответа.
3. Badge: "OK".

**Oracle:**
```powershell
$doc = Invoke-RestMethod "http://127.0.0.1:4433/api/document?url=https://chatgpt.com/c/6a8bed08-fbc8-83ea-87ad-e45ce7c66320"
$doc.text | Select-String -Pattern "текст твоего нового сообщения"  # должно найтись
$doc.add_count  # должно быть больше, чем после A2 (одна новая запись)
```

**Pass:** в text есть новое сообщение; `id`/`url` не изменились (тот же канонический doc, upsert in place).

---

### A4 — Hister down → ERR

**Шаги:**
1. Остановить Hister: `Stop-Process -Name hister -Force`
2. В том же треде отправить ещё одно сообщение (или просто спровоцировать мутацию: edit + revert сообщения).
3. Подождать ~10s. Badge должен показать "ERR" (красный) после 3 retry × 2s = ~6s суммарного backoff.

**Oracle (chrome://extensions/ → service worker console):**
- Должна быть видна fetch-ошибка.
- Badge: красный "ERR".

**Pass:** badge ERR, никакого silent failure. Потом перезапустить Hister (`& "C:\Projects\_Others\hister\hister.exe" listen`).

---

### A5 — Пустые сообщения исключены

**Шаги:**
1. Заново спровоцировать capture на кириллическом треде.
2. Открыть захваченный текст в Hister WebUI (`http://127.0.0.1:4433`).

**Oracle:**
```powershell
$doc = Invoke-RestMethod "http://127.0.0.1:4433/api/document?url=https://chatgpt.com/c/6a8bed08-fbc8-83ea-87ad-e45ce7c66320"
# Посчитать [USER] + [ASSISTANT] маркеры в плоском тексте:
$matches = [regex]::Matches($doc.text, '^\[(USER|ASSISTANT)\]', [System.Text.RegularExpressions.RegexOptions]::Multiline)
"marker_count=$($matches.Count)"
# ожидаем: 11 (совпадает с metadata.message_count)
```

**Pass:** marker count == metadata.message_count == 11. Никаких пустых `[USER] ` строк.

---

### A6 — Кириллический round-trip (туда-обратно)

**Шаги:** capture уже сделан из A1.

**Oracle (WebUI):**
1. Открыть `http://127.0.0.1:4433`.
2. Поиск: `Хистер` (или любое кириллическое слово из треда).
3. Подтвердить, что doc появляется в результатах.

**Pass:** кириллический поиск возвращает захваченный doc.

---

### A7 — Изоляция label (0 утечек в label:youtube)

**Oracle:**
```powershell
$youtube = Invoke-RestMethod "http://127.0.0.1:4433/api/search?q=label:youtube"  # скорректировать под реальный search endpoint
# ИЛИ WebUI: поиск "label:youtube" → НЕ должен включать chatgpt doc
```

**Pass:** 0 chatgpt doc'ов под `label:youtube`. У всех chatgpt doc'ов `label:chatgpt`.

---

### A8 — URL канонический (без вариантов `?model=o1`)

**Шаги:** никаких (пассивная проверка). Просто верифицируем:
```powershell
$doc = Invoke-RestMethod "http://127.0.0.1:4433/api/document?url=https://chatgpt.com/c/6a8bed08-fbc8-83ea-87ad-e45ce7c66320?model=o1-preview"
# ожидаем: 200 (Hister канонизирует по URL hash, отбрасывает query)
$doc2 = Invoke-RestMethod "http://127.0.0.1:4433/api/document?url=https://chatgpt.com/c/6a8bed08-fbc8-83ea-87ad-e45ce7c66320"
"id_match=$($doc.id -eq $doc2.id)"
```

**Pass:** оба URL возвращают один и тот же Hister doc.

---

### A9 — 50 reload'ов → ровно 1 doc

**Шаги:**
1. В dev tools console на вкладке треда выполнить:
   ```js
   for (let i = 0; i < 50; i++) location.reload()
   ```
   (или через `setInterval` растянуть по времени — мгновенный цикл тоже OK, dedupe идёт по hash).
2. Подождать 30s.

**Oracle:**
```powershell
# В Hister, поиск по label:chatgpt и URL:
$results = Invoke-RestMethod "http://127.0.0.1:4433/api/search?q=label:chatgpt+6a8bed08"  # скорректировать под endpoint
"doc_count=$($results.Count)"  # ожидаем: 1
# ИЛИ
$doc = Invoke-RestMethod "http://127.0.0.1:4433/api/document?url=https://chatgpt.com/c/6a8bed08-fbc8-83ea-87ad-e45ce7c66320"
"add_count=$($doc.add_count)"  # ожидаем: небольшое однозначное число (initial + несколько hash-changed capture'ов, НЕ 50)
```

**Pass:** ровно 1 doc для URL. `add_count` НЕ 50+ (доказывает dedupe по hash, а не POST на каждый reload).

---

### A10 — Metadata `conversation_id` совпадает с UUID из URL

**Oracle:**
```powershell
$doc = Invoke-RestMethod "http://127.0.0.1:4433/api/document?url=https://chatgpt.com/c/6a8bed08-fbc8-83ea-87ad-e45ce7c66320"
"conv_id=$($doc.metadata.conversation_id)"
# ожидаем: "6a8bed08-fbc8-83ea-87ad-e45ce7c66320"
```

**Pass:** metadata.conversation_id == UUID из URL.

**Сноска:** `metadata.*` не индексируется в Hister (per upstream context `docs/spike/RESULTS/innerText.md` + dnote #15). Видно в doc detail view, но не ищется. Это документированное v1 ограничение.

---

### A11 — Сохранение label (уже verified, дубль-проверка)

Gate 3 результат: Outcome A — `serveAdd` перетирает label при recapture.
Runbook: `docs/spike/label-preservation-runbook.md`.
Результат: `docs/spike/RESULTS/label-preservation.md`.

**Re-verify (5 мин, опционально):**
1. Открыть doc в Hister WebUI, вручную поменять label на, например, `chatgpt-test-A11`.
2. Спровоцировать recapture (edit + revert сообщения в ChatGPT-треде, чтобы сработал MO, подождать 10s).
3. Проверить doc: label снова `chatgpt`.

**Pass:** label откатился к `chatgpt` (документированное v1 ограничение, A11 в PRD).

---

## После A1–A11

```powershell
# 1. Подчистить probe doc из Pre-checks
Invoke-RestMethod "http://127.0.0.1:4433/api/delete?url=https://chatgpt.com/c/probe-a1-a11"
# (или через WebUI)

# 2. Финальный счёт Hister doc'ов для label:chatgpt — должен быть только кириллический тред (1 doc).
# WebUI: поиск "label:chatgpt" → count
```

## Result record

Заполнить после прогона:

| A | Pass/Fail | Заметки |
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
| A11 | | (уже verified в `docs/spike/RESULTS/label-preservation.md`) |

Когда все 11 зелёные — MVP shippable. Per PRD §13 DoD:
- ext код в этом репо ✓
- A1–A10 green (A11 уже verified)
- Краткий README ✓
- До/после baseline Hister doc count
