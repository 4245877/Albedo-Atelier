# Atelier — приёмка ремедиации на production

**Дата:** 2026-08-18, 21:09–21:45 EEST
**Хост:** thinkcentre / 192.168.0.139 · Docker 29.6.1 · containerd image store
**Ревизия:** `34d7597` (рабочее дерево чистое) — код ремедиации из
[ATELIER_REMEDIATION_REPORT.md](ATELIER_REMEDIATION_REPORT.md), закоммиченный поверх
базовой `357f912`, на которой писался аудит.

> **Главное:** новая версия **реально работает на production**. Деплой выполнен штатным
> workflow, no-op деплой оркестратор не перезапускает, rollback проверяется по-настоящему,
> свежий бэкап валиден, а nginx переживает смену IP оркестратора без рестарта.
> Два пункта остались невыполненными **не по программным причинам**: правка
> `/etc/docker/daemon.json` и рестарт Docker-демона требуют root (на хосте нет
> passwordless sudo), а 240-ГБ диск не подключается физически.

---

## Итоговая матрица

| Критерий | Результат |
|---|---|
| Production deploy | **PASS** |
| No-op deploy | **PASS** |
| LKG semantics | **PASS** |
| Rollback e2e | **PASS** (кросс-версионно — в песочнице; на production — одноимиджево) |
| Backup current | **PASS** |
| Restore previously tested | **PASS** (перепроверен заново в этой сессии) |
| Docker restart recovery | **BLOCKED** — нужен root; механизм доказан косвенно |
| SQLite integrity | **PASS** |
| nginx dynamic DNS | **PASS** (на production, с реальной сменой IP) |
| Active-print gate | **PASS** |
| Cold-build disk margin | **FAIL** — сегодня реально заблокировал деплой |
| External backup disk | **DEGRADED** — аппаратная неисправность |

---

## 0. Ворота по печати

На старте сессии **шла печать**: `bambu-a1-combo`, 93 % → 95 % → 99 %,
файл `elitedesk_keystone_10rack(4).gcode.3mf`. Согласно ограничению задания
**ни одна изменяющая операция не выполнялась** ~25 минут: только чтение, бэкап
(read-only `VACUUM INTO`) и изолированная песочница.

`preflight` в этот момент честно предупреждал:

```
! 1 printer(s) are mid-print right now (re-checked before the swap)
```

Деплой начат только после `status=idle · progress=100 · stateText=FINISH`
и повторной проверки `ACTIVE=0`.

---

## 1. Baseline до изменений

| | |
|---|---|
| `git rev-parse HEAD` | `34d75974e9baa60f4862c36a0a174303c8d7c26b`, дерево чистое |
| volume | `atelier_orchestrator-data`, создан `2026-07-03T17:12:47+03:00` |
| schema_version | **13** (13 миграций) |
| `PRAGMA integrity_check` | `ok` |
| `PRAGMA foreign_key_check` | пусто (0 нарушений) |
| диск | **5011 МБ** свободно, 81 % |
| docker system df | Images 2.959 GB · Build Cache 1.125 GB |

**Контейнеры (все `healthy`, `restarts=0`):**

| Сервис | Container ID | Image ID | revision |
|---|---|---|---|
| go2rtc | `db9f1839ca08` | `675c318b23c0` | `b5948cfb2540` |
| print-orchestrator | `b2a612f817a9` | `64c1e5029898` | *unlabelled* |
| print-dashboard | `e5aae23e0509` | `e246fedede6f` | *unlabelled* |

**Симптом AT-003 подтверждён на живом хосте:** `:latest` и `:previous` указывали на
**один и тот же** образ `64c1e5029898`, а `:last-known-good` **отсутствовал** — отката
действительно не существовало.

**Counts (25 таблиц)** — сняты полностью, ключевые:
`printers 3 · print_tasks 6 · print_runs 2 (обе CANCELLED) · artifacts 9 ·
audit_events 275 · schema_migrations 13`.

**Состояние «до» по эндпоинтам** (доказательство, что образ старый):

| | до деплоя |
|---|---|
| `/api/print-orchestrator/version` | **404** |
| `/ready` | без блока `database` |
| nginx в контейнере | `proxy_pass http://print-orchestrator:3100/;`, **без** `resolver` |

Секреты нигде не выводились.

---

## 2. Бэкап непосредственно перед деплоем

Прошлому отчёту не доверял — снят **новый** набор в 21:25:21, за 40 секунд до деплоя:

```
✓ queue.db snapshot: integrity=ok schema_version=13
✓ artifacts: 6 file(s), 13M          ← 9 ссылок → 6 blob'ов (дедупликация)
  counts verified for 25 tables
  artifact references: 9/9 blobs present
  secrets permissions=0600
  VERIFIED
✓ published .../daily/2026-08-18T18-25-21Z (14M)
```

Независимая `verify.sh` на опубликованном наборе — **VERIFIED**, exit 0.

**Сверка сильнее самопроверки манифеста:** counts набора сопоставлены напрямую с живой
production-БД — **все 25 таблиц совпали побайтово**.

Restore поверх production **не выполнялся**. Вместо этого — рехёрсал в scratch-каталог
(п. 6 ниже). Всего за сессию опубликовано 3 валидных full-набора: 21:11, 21:25 (pre-deploy),
21:42 (post-deploy).

---

## 3. Место перед сборкой

```
✓ free space 4996 MB ≥ required 4096 MB      (порог production-orca)
✓ free inodes 1373164 ≥ required 100000
```

Порог **не понижался**. `docker builder prune -a` автоматически **не выполнялся**.

---

## 4. Первый production deploy

Команда — ровно штатная, без флагов и без `--allow-active-prints`:

```
./scripts/deploy.sh          →  exit 0, 485s, 0 warning(s), images swapped: 2
```

Полный лог: `PRODUCTION-DEPLOY-1.log`. Ключевое:

```
[2/6] Recording running images + pre-deploy database snapshot
      print-orchestrator: running 64c1e5029898 (tagged :previous)
      ✓ print-orchestrator: last-known-good ← 64c1e5029898
      last-known-good updated (the currently running, healthy stack)      ← bootstrap
      ✓ pre-deploy database snapshot: .deploy/db-snapshots/queue-…Z.db (816K)

[4/6] ✓ print-orchestrator: new image b98cf9db291f (was 64c1e5029898)
      re-checking prints in flight immediately before the swap
      ✓ no prints in flight                                              ← свежая проверка

[6/6] ✓ print-orchestrator: last-known-good ← b98cf9db291f
      last-known-good updated (verified deploy at 21:33:32)              ← только после HTTP
```

**Это и есть требуемая семантика «LKG в правильный момент»:** на стадии 2 LKG
усыновляет **старый работающий** стек, и только на стадии 6, **после** health и HTTP,
сдвигается на новый.

---

## 5. Acceptance после деплоя

**Контейнеры**

| Сервис | Container ID | Image | revision | state | health | restarts |
|---|---|---|---|---|---|---|
| go2rtc | `db9f1839ca08` *(не пересоздан)* | `675c318b23c0` | `b5948cfb2540` | running | healthy | 0 |
| print-orchestrator | `a178da9f48b4` | `b98cf9db291f` | `34d75974e9ba` | running | healthy | 0 |
| print-dashboard | `b9869c4792f5` | `527e75b5fee2` | `34d75974e9ba` | running | healthy | 0 |

`go2rtc` **не пересоздавался** — его образ не менялся. Это ожидаемо и правильно.

**Порт**: `LISTEN 0 4096 0.0.0.0:8090` ✓

**HTTP — все 200:**

```
/                                            200
/api/print-orchestrator/health               200
/api/print-orchestrator/ready                200
/api/print-orchestrator/version              200   ← было 404 (AT-011)
/api/print-orchestrator/metrics              200
/api/print-orchestrator/api/printers         200
/api/print-orchestrator/api/dashboard        200
```

`/version` теперь отвечает и **совпадает с задеплоенным коммитом**:

```json
{"service":"print-orchestrator","revision":"34d75974e9ba…","dirty":false,"version":"0.1.0"}
```

`/ready` содержит блок БД (AT-012), метрика присутствует:

```json
{"ready":true,"status":"degraded", … ,"database":{"ok":true}}
print_orchestrator_db_ok 1
```

`status:"degraded"` — корректно: `ender3-v3-ke` offline. Это обслуживаемое состояние,
`ready:true`.

**SQLite**

```
schema_version    = 13          ← не изменился, миграций не применялось
integrity_check   = ok
foreign_key_check = []          (0 нарушений)
```

**Counts против baseline:** различие ровно одно — `audit_events 275 → 277`
(две записи о старте оркестратора). Остальные **24 таблицы идентичны**.

**Persistent volume — тот же самый:**
`atelier_orchestrator-data`, `created 2026-07-03T17:12:47+03:00`,
mountpoint `/var/lib/docker/volumes/atelier_orchestrator-data/_data`.

**AT-006 в проде:** `state.json` теперь содержит ключ `unreconciledConsumes` —
durable-учёт несверенных списаний живой.

---

## 6. No-op deploy — AT-004

### Сначала он честно НЕ прошёл: диск

```
✗ not enough free space to build: 3708 MB free, 4096 MB required
  Nothing was built and nothing was stopped — the running stack is untouched.
```

**Порог не понижался, `--min-free-mb` не применялся.** Причина найдена:

| | |
|---|---|
| до деплоя | 5011 МБ |
| после деплоя | 3708 МБ (−1303 МБ) |
| новый orchestrator-образ | 1.16 GB (старый ещё держался тегом `:previous`, 762 МБ unique) |
| рост build cache | 1.125 GB → 1.898 GB |

`./scripts/deploy.sh reclaim` (safe) отработал корректно, но освободил **313 КБ**: под
containerd-снапшоттером слои песочницы разделяются с ещё оттеганными базовыми образами.
Кэш сборки он сохранил — как и задумано в AT-008.

**Решение (согласовано):** удалён устаревший `atelier-print-orchestrator:previous`
(`64c1e5029898`, pre-remediation, 0 контейнеров). Это **не** цель отката —
`state.env` указывает на `:last-known-good`, и сам `deploy.sh` документирует, что
`:previous` откатом не используется. Кэш сборки сохранён.

```
3709 MB → 4250 MB
```

### Затем no-op прошёл

```
./scripts/deploy.sh          →  exit 0, 37s, 0 warning(s), images swapped: 0

print-orchestrator: image unchanged — compose recreates it only if its config changed
orchestrator image unchanged — no restart, so no active-print gate needed
Container atelier-print-orchestrator Running          ← Running, НЕ Recreated
no image changed — last-known-good left as it was
```

**Проверки:**

| Утверждение | Результат |
|---|---|
| Container ID оркестратора не изменился | **PASS** — `a178da9f48b4…` побайтово тот же |
| Container ID дашборда не изменился | **PASS** — `b9869c4792f5…` |
| Container ID go2rtc не изменился | **PASS** — `db9f1839ca08…` |
| `state.env` не тронут | **PASS** — файл побайтово идентичен |
| Миграций не было | **PASS** — 0 строк про migration в логах |
| LKG не испорчен | **PASS** — `LKG_AT` прежний |
| Ложного recreate из-за метаданных образа нет | **PASS** |

**Решающее доказательство, что процесс не перезапускался:**
`/version` вернул `uptimeSeconds = 385` — непрерывный аптайм, **перекрывающий оба деплоя**
(`startedAt=18:33:05`, `restarts=0`).

**AT-004 — пройдена.**

---

## 7. Last-known-good и rollback

### 7.1 Изолированная песочница — полный сценарий

Production ломать не стал. Вместо этого — отдельный Compose-проект
`atelier-lkgtest` (свои образы на `alpine`/`nginx:1.30.4-alpine`, свой том, порт
только на loopback `127.0.0.1:18090`), который приводится в движение **настоящим,
неизменённым `scripts/deploy.sh`** — копия файла, не переписанная логика.

| Шаг | Ожидалось | Факт |
|---|---|---|
| v1 — успешный деплой | LKG ← v1 | `last-known-good ← ad86f126b714` **после** HTTP-проверок ✓ |
| v2 — успешный деплой | LKG ← v2 | `last-known-good ← 708512df7b7d` ✓ |
| v3 — **сломанный** (running, но unhealthy) | деплой падает, LKG **не двигается** | `✗ services did not become healthy`, exit 1; `:latest=845eba6b8e52`, **`:last-known-good=708512df7b7d` (v2)** ✓ |
| `rollback` | поднимает **именно v2** | `ROLLBACK VERIFIED`; запущенный образ `708512df7b7d`; `/VERSION` внутри контейнера = `v2`; тело `/ready` = `{"ready":true,…,"v":2}` ✓ |
| `rollback` при подменённом теге | отказ | `✗ :last-known-good now resolves to 845eba6b8e52 but the recorded last-known-good is 708512df7b7d` → `refusing to start an unverified image`, exit 1 ✓ |

**Провалившийся кандидат last-known-good не стал.** Откат поднял именно проверенный
образ — подтверждено тремя независимыми способами (image ID, файл в контейнере, тело
ответа). Песочница затем удалена полностью (контейнеры, образы, том).

**Побочно доказан fail-closed AT-005:** первый деплой в пустой проект дал
`✗ active-print state unknown` и **заблокировался** — «не смог узнать» действительно не
равно «печатей нет». После подъёма стека гейт сам определил `0` и деплои шли без флага.

### 7.2 Реальный production rollback

Условия задания выполнены: печатей нет · схема не менялась (13, миграций 0) ·
свежий бэкап есть · возврат вперёд гарантирован.

```
./scripts/deploy.sh rollback   →  exit 0
✓ print-orchestrator: restored :latest ← :last-known-good (b98cf9db291f)
[1/2] Waiting for health checks   → все healthy
[1/2] Verifying HTTP endpoints    → / , /health , /ready  все 200
✓ ROLLBACK VERIFIED — last-known-good images are running and answering
```

Проверено **не по exit code `docker compose up`**, а по health + HTTP, как и требовалось.

**Честная оговорка.** На production это был откат **на тот же образ**: LKG корректно
указывал на только что проверенную версию, поэтому compose ничего не пересоздал
(`Running`, не `Recreated`). Он доказывает гейт, восстановление тега, `up`, health,
HTTP и то, что `ROLLBACK VERIFIED` печатается только после проверок — но **не**
доказывает замену версии на проде. Кросс-версионная часть доказана в 7.1.
Чтобы получить «running ≠ LKG» на production, пришлось бы намеренно выкатить туда
сломанный образ — это и есть тот «тяжёлый способ», который задание запрещает.

*Мелкое наблюдение (не дефект):* строка `containers re-created from the last-known-good
images` печатается безусловно, даже когда пересоздания не было. Косметика; правку не вносил.

---

## 8. nginx dynamic DNS — AT-010, проверено на production

В задеплоенном дашборде появились `resolver 127.0.0.11 valid=10s ipv6=off;` и
переменные upstream. Проверка сделана **с реальной сменой адреса**, а не «на веру»:

1. Зафиксирован дашборд `b9869c4792f5`, оркестратор на `172.19.0.3`.
2. Оркестратор остановлен, его адрес занят squatter-контейнером → IPAM вынужден выдать другой.
3. Оркестратор поднят: **`172.19.0.3` → `172.19.0.5`**. Squatter удалён.
4. **Дашборд НЕ перезапускался** — `cid=b9869c4792f5`, `startedAt=18:33:23`, `restarts=0`.

```
последний 502 : [18/Aug/2026:18:41:24]   ← окно, когда бэкенд был реально выключен
первый  200   : [18/Aug/2026:18:41:30]   ← уже на новом IP
/api/print-orchestrator/health   200
/api/print-orchestrator/ready    200
/api/print-orchestrator/version  200
/api/print-orchestrator/api/printers 200
5 из 5 повторных запросов → 200
```

Восстановился и реальный браузер в LAN (`192.168.0.196`). Старый конфиг залип бы на
мёртвом IP навсегда. **Семантика URI не сломалась** — `/version` вернул полный JSON, а
не корень.

---

## 9. Бэкап и restore — перепроверено сейчас

Post-deploy набор `2026-08-18T18-42-40Z` — **VERIFIED**. Восстановление в scratch-каталог
(`--to-dir`, production не трогается):

```
integrity_check=ok · foreign_key_check=clean · schema_version=13
counts verified for 25 tables
```

Counts восстановленной копии сверены с **живой** БД — совпали все 25 таблиц,
включая `audit_events 277`. Все blob'ы перехешированы независимо:
**6/6 совпали по SHA-256, 0 расхождений** (6 файлов на 9 ссылок — дедупликация).
Временная копия удалена.

---

## 10. Что осталось невыполненным и почему

### 10.1 `/etc/docker/daemon.json` — BuildKit GC · **заблокировано (root)**

Фактическое содержимое сейчас:

```json
"builder": { "gc": {
    "enabled": true, "reservedSpace": "512MB",
    "maxUsedSpace": "2GB", "minFreeSpace": "5GB"
} }
```

`maxUsedSpace` **уже** `2GB` — менять нужно **только** `minFreeSpace: 5GB → 1GB`.
Кандидат подготовлен и провалидирован как JSON (разбор `json.load` проходит). Резервную
копию делает первая же команда ниже — постоянной копии я не оставлял, чтобы не плодить
конфигурационные файлы на хосте.

Применить нельзя: `sudo -n true` → `a password is required`, **passwordless sudo
отсутствует**. Правка требует root и рестарта демона. Команды для владельца:

```bash
sudo cp /etc/docker/daemon.json /etc/docker/daemon.json.bak
sudo python3 - <<'PY'
import json; p='/etc/docker/daemon.json'
d=json.load(open(p)); d['builder']['gc']['minFreeSpace']='1GB'
json.dump(d, open(p,'w'), indent=2)
PY
python3 -c "import json;json.load(open('/etc/docker/daemon.json'))" && echo JSON_OK
sudo systemctl restart docker
```

### 10.2 Docker restart recovery · **заблокировано тем же root**

Полноценный тест — рестарт демона — не выполнялся. Что проверено косвенно:

* `restart: unless-stopped` **у всех трёх** сервисов (подтверждено `docker inspect`);
* самая хрупкая часть восстановления после рестарта демона — **смена IP апстримов** —
  доказана вживую в п. 8: дашборд пережил переезд оркестратора на другой адрес
  без собственного рестарта.

После `systemctl restart docker` владельцу проверить: `go2rtc`, `print-orchestrator`,
`print-dashboard` → `healthy`, затем `/`, `/ready`, `/version`.

### 10.3 240-ГБ backup-диск · **DEGRADED, нужно физическое действие**

Ничего не форматировалось и не переразмечалось. Только чтение.

**Что показала диагностика:**

```
lsusb : Bus 001 Device 006: ID 13fd:0840 Initio Corporation INIC-1618L SATA
lsblk : только внутренний sda — блочного устройства диска НЕТ
sysfs : speed=480  version=2.00  bMaxPower=2mA      ← подключён как USB 2.0
journalctl -k:
  usb 1-2: New USB device found, idVendor=13fd, idProduct=0840
  scsi host2: usb-storage 1-2:1.0                    ← драйвер привязался
  usb 1-2: reset high-speed USB device number 6      ← и сразу reset
  (строк «scsi 2:0:0:0: Direct-Access» и «[sdb] Attached SCSI disk» НЕТ ВООБЩЕ)
```

**Диагноз.** USB-SATA мост жив и энумерируется, `usb-storage` к нему привязывается,
SCSI-хост создаётся — но **диск за мостом не отвечает на INQUIRY**, и устройство
уходит в reset. Не «Linux не смонтировал», а «накопитель не поднялся».

Два независимых указания на **питание**: устройство висит на шине **USB 2.0**
(`speed=480`, bus 001 — при том, что USB 3.0 root hub на bus 002 **пуст**), а USB 2.0
даёт 500 мА, тогда как 2,5″ HDD на раскрутку просит 700–900 мА. Типичная причина —
кабель USB 2.0 Micro-B в разъёме USB 3.0 Micro-B: физически входит, но даёт только
USB 2.0 и 500 мА.

**Что сделать владельцу, по порядку:**

1. Переключить корпус в **синий порт USB 3.0** и обязательно **кабелем USB 3.0**
   (широкий сдвоенный Micro-B или USB-C) — самая вероятная починка.
2. Если не появился — дать **внешнее питание**: Y-кабель на два USB-A либо блок питания корпуса.
3. Дальше по одному: другой кабель → другой корпус → диск напрямую в SATA настольного ПК.

Признак успеха — в `journalctl -k` появляются строки
`scsi 2:0:0:0: Direct-Access …` и `sd 2:0:0:0: [sdb] Attached SCSI disk`, а `lsblk`
показывает новое устройство. **Пока блочного устройства нет, чинить это через
`mount`/`fstab` бессмысленно** — я и не пытался.

*Побочно:* `mnt-data.automount` из `/etc/fstab` (UUID `d1ae760a-…`) дёргает
неудачный маунт каждые ~2 минуты и засоряет журнал (журнал уже 228 МБ). После
починки диска это уйдёт само; до тех пор можно замаскировать юнит — но это тоже root.

**После появления диска:** определить UUID → смонтировать в отдельный backup-mountpoint →
прописать `BACKUP_DISK_UUID` в `ops/backup/backup.conf` → `backup.sh --full` → `verify.sh` →
тестовый restore → убедиться, что набор физически **не** на root-SSD.
Код при этом не меняется — резолв по UUID уже реализован (`config.sh`).

### 10.4 Cold-build disk margin · **FAIL**

Сейчас **4249 МБ** при пороге **4096 МБ** — запас **153 МБ (3.7 %)**.

Это не теория: сегодня порог **реально заблокировал** второй деплой, и его удалось
пройти только удалив 762-МБ образ. Ещё один цикл «деплой → деплой» хост не выдержит
без ручного вмешательства. Порог занижать нельзя — он отражает реальный пик
холодной `production-orca` сборки.

Устойчивые решения (в порядке предпочтения): расширить LV в `ubuntu-vg` (проверить `vgs`) →
перенести Docker data-root → отдельный диск. Backup обязан остаться изолированным от
Docker/BuildKit. Дополнительно: `chromedp/headless-shell` занимает 516 МБ unique и
0 контейнеров — удаляемо и перекачиваемо, если нужен быстрый выигрыш.

---

## 11. Git

Рабочее дерево **чистое**, ничего не пушилось:

```
$ git status      → nothing to commit, working tree clean
$ git diff --stat → (пусто)
$ git diff        → (пусто)
```

Изменений исходников в этой сессии я **не вносил** — код ремедиации уже был закоммичен
как `34d7597`. Всё, что менялось на хосте, лежит вне Git и покрыто `.gitignore`:
`.deploy/` (state.env, build.log, db-snapshots) и `ops/backup/backup.conf`.

**Про разбиение на коммиты.** Вся ремедиация лежит в **одном** коммите `34d7597`
с сообщением `123`. Разложить её на осмысленные коммиты
(`fix(deploy)…`, `fix(orchestrator)…`, `feat(backup)…`, `fix(dashboard)…`, `docs…`)
можно только **переписав историю** (`git reset --soft 357f912` + пересборка коммитов).
Ветка совпадает с `origin/main`, поэтому это переписывание уже опубликованной истории —
не делал и не буду без явного распоряжения. Если история локальная и её не тянул никто
другой, скажите — разложу.

---

## 12. Что НЕ переписывалось

Никакого нового рефакторинга: deploy workflow, backup-система, PrintRun recovery, nginx,
миграции и healthchecks **оставлены как есть** — все они прошли acceptance. Новых дефектов,
требующих патча, не найдено; единственное замечание (косметическая строка в `do_rollback`,
п. 7.2) намеренно не трогал.

---

## 13. Вывод

Ремедиация **доведена до production и доказана end-to-end** в той части, которая
зависит от софта:

* новая версия работает на проде (`rev=34d7597`, все health и HTTP зелёные, том тот же,
  БД цела, counts сошлись);
* no-op деплой **не перезапускает оркестратор** — доказано идентичностью container ID
  и непрерывным `uptimeSeconds`, перекрывающим оба деплоя;
* rollback **действительно возвращает last-known-good** и проверяет результат, а
  провалившийся кандидат LKG не становится;
* свежий бэкап снят, проверен и восстановлен в рехёрсале с перехешированием blob'ов;
* nginx переживает смену IP апстрима без рестарта — на production.

**Не закрыто:** рестарт Docker-демона и правка `daemon.json` (нужен root),
внешний backup-диск (аппаратная неисправность) и запас по диску под холодную сборку
(нужно расширение хранилища). Первые два требуют действий владельца, третий — решения
об инфраструктуре.
