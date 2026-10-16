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

---
---

# Часть II — закрытие инфраструктурных остатков

**Дата:** 2026-08-18, 21:59–22:20 EEST · **хост:** thinkcentre / 192.168.0.139
**Ревизия:** `d44b05a` (рабочее дерево чистое) — код не менялся, менялась только
инфраструктура хоста.

> **Главное:** три пункта из четырёх закрыты по-настоящему. Docker-демон
> перезапущен на живом проде — стек поднялся сам, данные целы, апстримы сменили IP
> и nginx это пережил. `daemon.json` исправлен минимальной правкой. А вот
> «расширить root до 60–80 ГБ» **физически невозможно**: системный накопитель этой
> машины — **32 ГБ целиком**, и он размечен без остатка. Никаких «240 ГБ» внутри
> машины нет.

---

## II.0 Ворота по печати — окно действительно было открыто

Проверено обоими источниками, которыми пользуется сам `deploy.sh`
(`count_active_prints_live` + `count_active_runs_db`), а не «на глаз»:

```
ACTIVE_LIVE = 0    ender3-v3-ke:offline  creality-k2:idle  bambu-a1-combo:idle
ACTIVE_RUNS = 0    print_runs по состояниям: CANCELLED=2  (RUNNING/PAUSED — нет)
preflight   : ✓ no prints in flight (re-checked before the swap)
```

Гейт перепроверялся **непосредственно перед** рестартом демона и ещё раз после всех
работ — все три раза `0`. Ни одна печать за сессию не стартовала.

---

## II.1 Свежий бэкап перед системными изменениями

```
./ops/backup/backup.sh --full
✓ queue.db snapshot: integrity=ok schema_version=13
✓ artifacts: 6 file(s), 13M
✓ secrets: .env captured (0600, values never logged)
  counts verified for 25 tables · artifact references: 9/9 blobs present
  VERIFIED
✓ published /home/miha/atelier-backups/sets/daily/2026-08-18T19-00-20Z (14M)
```

| | |
|---|---|
| **Timestamp набора** | `2026-08-18T19-00-20Z` (22:00:20 EEST) |
| независимый `verify.sh` | **VERIFIED**, exit 0 |
| изолированный restore | `--to-dir` в scratch, production не тронут |
| проверка восстановленной копии | `integrity=ok`, `foreign_key_check` пусто, `schema_version=13` |
| counts восстановленной копии | **25/25 таблиц совпали** с baseline до рестарта |
| blob'ы | **6/6 перехешированы SHA-256 и совпали** с их content-addressed именами |

Восстановление поверх production **не выполнялось**. Тир бэкапа — по-прежнему
`fallback`, и скрипт честно печатает `DEGRADED` (см. II.5).

---

## II.2 Baseline перед системными изменениями

| | |
|---|---|
| `git rev-parse HEAD` | `d44b05aee4a3e5cabe5766de38f8dd735cbbcc9f`, дерево чистое |
| volume | `atelier_orchestrator-data`, created `2026-07-03T17:12:47+03:00` |
| schema_version | **13** · integrity `ok` · foreign_key_check пусто |
| counts | 25 таблиц, `audit_events=277`, `print_runs=2`, `artifacts=9` |
| диск `/` | **4233 МБ** свободно, 84 % занято, inodes 1360082 |
| docker | Images 2.961 GB · Build Cache 1.898 GB (102 записи) |

| Сервис | Container ID | Image ID | rev | health | restarts | policy |
|---|---|---|---|---|---|---|
| go2rtc | `db9f1839ca08` | `675c318b23c0` | `b5948cfb2540` | healthy | 0 | unless-stopped |
| print-orchestrator | `a178da9f48b4` | `b98cf9db291f` | `34d75974e9ba` | healthy | 0 | unless-stopped |
| print-dashboard | `b9869c4792f5` | `527e75b5fee2` | `34d75974e9ba` | healthy | 0 | unless-stopped |

Все 7 HTTP-эндпоинтов — 200. Порт `0.0.0.0:8090` слушается. Секреты не выводились.

---

## II.3 BuildKit GC — `daemon.json` исправлен

Фактическое содержимое показано до правки, JSON провалидирован **до** и **после**,
root-only резервная копия сделана первой операцией:

```
-rw------- 1 root root 326  /etc/docker/daemon.json.before-atelier-fix
```

Правка ровно одна, `sed` по конкретному значению — не перезапись файла:

```diff
--- /etc/docker/daemon.json.before-atelier-fix
+++ /etc/docker/daemon.json
@@ -13,7 +13,7 @@
       "enabled": true,
       "reservedSpace": "512MB",
       "maxUsedSpace": "2GB",
-      "minFreeSpace": "5GB"
+      "minFreeSpace": "1GB"
     }
   }
 }
```

Скрипт отказался бы работать, если бы строка `"minFreeSpace": "5GB"` встретилась не
ровно один раз, и откатил бы файл из копии при невалидном JSON после правки.

**Сохранено без изменений:** `log-driver: json-file` с ротацией
(`max-size 10m`, `max-file 3`, `compress`), `features.containerd-snapshotter`,
`reservedSpace`, `maxUsedSpace`.

**Проверка до рестарта:** `python3 -m json.tool` → OK; `dockerd --validate
--config-file /etc/docker/daemon.json` → `configuration OK` (демон при этом не
запускается).

**Честная оговорка о силе этой проверки.** Негативный контроль показал, что
`dockerd --validate` **не** ловит опечатку во вложенном ключе `builder.gc`
(подсунутый `minFreeSpaceTYPO` тоже дал `configuration OK`). То есть валидатор
доказывает корректность JSON и верхнеуровневой схемы, но не то, что BuildKit
именно этот ключ читает. Что доказано вместо этого: ключ `minFreeSpace` уже стоял
в файле до нас и работал (менялось только его значение), демон после рестарта
загрузил конфиг без ошибок разбора и заново поднял BuildKit
(`Initializing buildkit` → `Completed buildkit initialization`). Сборку ради
провокации GC не запускал — она рискует вытеснить тёплый кэш, который сейчас
критичен (см. II.4).

---

## II.4 Docker restart recovery — **PASS**, на живом production

```
sudo systemctl restart docker      T0 = 22:04:12   →   exit 0
docker.service active (running)    22:04:36
```

**`docker compose up` НЕ выполнялся** — стек поднимался только политикой
`restart: unless-stopped`.

| Момент | Событие |
|---|---|
| 22:04:12 | команда рестарта |
| 22:04:18 | контейнеры стартовали сами (`StartedAt`, все три) |
| 22:04:22 | `Loading containers: done.` |
| 22:04:36 | `Daemon has completed initialization` |
| **22:04:55** | **все три контейнера `healthy`** — через 43 с после команды |

**Контейнеры — те же самые, не пересозданные:**

| Сервис | Container ID | совпал с baseline | state | health | restarts |
|---|---|---|---|---|---|
| go2rtc | `db9f1839ca08…` | ✓ | running | healthy | 0 |
| print-orchestrator | `a178da9f48b4…` | ✓ | running | healthy | 0 |
| print-dashboard | `b9869c4792f5…` | ✓ | running | healthy | 0 |

`rev` у обоих сервисов Atelier — `34d75974e9ba`, тот же образ, что и до рестарта.

### Побочно: рестарт демона реально переставил IP апстримов

Это не гипотетический сценарий из п. 8 первой части — оно произошло само:

```
до рестарта : print-orchestrator = 172.19.0.3
после       : print-orchestrator = 172.19.0.2 · go2rtc ЗАНЯЛ 172.19.0.3 · dashboard = 172.19.0.4
```

Оркестратор и go2rtc **обменялись адресами**. Все прокси-маршруты дашборда
(`/api/print-orchestrator/*` и go2rtc) отвечают 200 — `resolver 127.0.0.11 valid=10s`
и переменные в `proxy_pass` подтверждены внутри работающего контейнера.
Со старым конфигом (литеральный апстрим, резолв один раз при старте) дашборд после
такого рестарта проксировал бы запросы оркестратора **в go2rtc**.

### Восстановление данных

```
integrity_check   = ok
foreign_key_check = []          (0 нарушений)
schema_version    = 13          (миграций не применялось)
```

**Counts против baseline: 24 таблицы из 25 идентичны.** Единственная разница —
`audit_events 277 → 278`; новая запись прочитана явно:
`presets_imported` / `entity=profile_revision` / `actor=system` в 22:04:39 —
штатный импорт каталога при старте оркестратора.

| Проверка | Результат |
|---|---|
| persistent volume | `atelier_orchestrator-data`, created `2026-07-03T17:12:47+03:00` — **тот же** |
| очередь | `queue_entries=1`, `/api/queue` отдаёт задачу `3U-default.3mf` — цела |
| PrintRun | `print_runs=2` — без потерь |
| artifacts | 9 ссылок → 6 blob'ов на диске — как и было |
| `state.json` | 11 021 → 10 980 байт, все 9 ключей на месте, включая `unreconciledConsumes` |
| credentials | `.env` не трогался |
| filament state | `filamentCarry` / `pendingConsumes` на месте |
| порт | `LISTEN 0.0.0.0:8090` ✓ |
| go2rtc | `/api` 200, WebRTC-продюсер K2 (`192.168.0.132`) снова активен |
| соседний стек fulfillment | 3 контейнера поднялись сами, postgres healthy |

**HTTP после рестарта — все 200:**
`/` · `/health` · `/ready` · `/metrics` · `/version` · `/api/print-orchestrator/{health,ready,version,metrics}` ·
`/api/print-orchestrator/api/{printers,dashboard,queue}`.
`/ready` содержит `"database":{"ok":true}`, метрика `print_orchestrator_db_ok 1`.

**Docker restart recovery = PASS.**

---

## II.5 Хранилище — фактическая разметка, а не предположения

Главный вопрос задания был: «почему на машине с накопителем ~240 ГБ root всего 27 ГБ?»
Ответ: **никакого 240-ГБ накопителя в машине нет.** Системный диск — 32 ГБ целиком.

```
Disk /dev/sda: 29,82 GiB, 32017047552 bytes    Disk model: RTFMB032RFM1EWLX
  /dev/sda1     1 GiB   EFI System        /boot/efi
  /dev/sda2     2 GiB   ext4              /boot
  /dev/sda3  26,8 GiB   LVM2_member       → ubuntu-vg
свободно на диске: 0,98 MiB перед первым разделом + 1,82 MiB в хвосте
```

| Уровень | Размер | Свободно |
|---|---|---|
| физический SSD `sda` (ATA, ata2, внутренний) | **29,82 GiB** | **1,82 MiB** нераспределённых |
| partition `sda3` | 26,8 GiB | — |
| PV `/dev/sda3` | 26,76 GiB | **Free PE = 0** |
| VG `ubuntu-vg` | 26,76 GiB | **Free PE / Size = 0 / 0** |
| LV `ubuntu-lv` | **26,76 GiB = 100 % VG** | ext4, смонтирован в `/` |

**Вывод: LV расширять некуда.** Ни свободных extents в VG, ни свободного места в PV,
ни нераспределённого пространства на диске (1,82 MiB — это выравнивание). Цель
«root 60–80 ГБ» на этом железе недостижима: весь накопитель — 32 ГБ.
`growpart`/`pvresize`/`lvextend` здесь нечего расширять, и ничего из этого
не выполнялось.

Куда ушло 21 ГБ (после уборки — 20 ГБ):

```
/var 8,0G   → /var/lib/containerd 4,3G (образы) · /var/lib/snapd 2,7G→2,1G · /var/lib/docker 344M
/home 5,6G  → .vscode-server 2,9G · snap 709M · apps 436M · .codex 368M · .cache 273M
/usr 4,6G
/swap.img 2,7G  (swapfile на root, используется — не трогал)
```

### Перенос Docker data-root — рассмотрен и отвергнут

Переносить некуда: **второго носителя в машине нет**. Единственный кандидат —
внешний USB-накопитель, который не отдаёт блочное устройство (II.6). Смешивать
Docker data-root и backup на одном носителе — против задания, а другого носителя
не существует. Решение отложено до появления физического диска.

---

## II.6 Внешний накопитель — блочного устройства нет, диагноз аппаратный

Ничего не форматировалось, не размечалось и не монтировалось. Только чтение и
**неразрушающие** попытки поднять устройство.

```
lsusb  : Bus 001 Device 006: ID 13fd:0840 Initio Corporation INIC-1618L SATA
sysfs  : product="External" manufacturer="Generic" bcdDevice=1.14
         speed=480  version=2.00  bMaxPower=2mA
lsusb -t: Bus 001 (USB 2.0, 480M) → порт 2, Driver=usb-storage
          Bus 002 (USB 3.0, 5000M) → ПУСТА
модули : usb_storage + uas загружены
scsi   : host2 создан; /sys/class/scsi_device/ содержит только 1:0:0:0 (внутренний sda)
kernel : "usb-storage 1-2:1.0: USB Mass Storage device detected"
         "scsi host2: usb-storage 1-2:1.0"
         "usb 1-2: reset high-speed USB device number 6 using xhci_hcd"
         строк "scsi 2:0:0:0: Direct-Access" и "[sdb] Attached SCSI disk" НЕТ
```

### Три программные попытки — все безрезультатны

| Попытка | Команда | Результат |
|---|---|---|
| 1 | пере-скан SCSI: `echo "- - -" > /sys/class/scsi_host/host2/scan` | целей не появилось |
| 2 | unbind + bind драйвера `usb-storage` для `1-2:1.0` | мост переподключился, диска нет |
| 3 | «программный передёрг» порта: `authorized` 0 → 1 | `usb 1-2: authorized to connect`, диска нет |

После каждой попытки — `USB Mass Storage device detected`, создание `scsi host2`
и `reset high-speed USB device`. **Мост энумерируется, накопитель за ним не
отвечает на INQUIRY.** Блочного устройства нет → `mount`/`fstab`/UUID тут
бессильны, и это не пробовалось.

**Косвенное подтверждение, что диск когда-то работал** — в `/etc/fstab` живёт
запись под него:

```
UUID=d1ae760a-f810-4921-a5a9-bad463165ccf  /mnt/data  ext4  defaults,nofail,x-systemd.automount,x-systemd.device-timeout=10  0 2
/mnt/data/lfbackup/repo  /srv/lfbackup/repo  none  bind,nofail,x-systemd.requires-mounts-for=/mnt/data  0 0
```

`nofail` стоит — отсутствие диска загрузку не ломает; `mnt-data.automount` висит в
`waiting`. Запись оставлена как есть: она сама подхватит диск, когда он вернётся.

**Два независимых указания на питание/кабель:** устройство висит на USB 2.0
(`speed=480`) при **полностью пустой** шине USB 3.0 (5000M) того же контроллера,
а дескриптор заявляет `bMaxPower=2mA`, т.е. «я самопитаемое» — типичная подпись
дешёвого корпуса, который на деле тянет ток с шины.

**External backup disk = DEGRADED** (не FAIL: бэкапы снимаются, проверяются и
восстанавливаются — но лежат на том же физическом носителе, что и production).

---

## II.7 Запас по диску — с 137 МБ до 1500 МБ, без понижения порогов

Порог `DEPLOY_MIN_FREE_MB` / `MIN_FREE_MB_ORCA` = **4096 МБ не менялся**.
Кэш сборки **не уничтожался** (`reclaim --cache` не запускался).

| Операция | Освобождено |
|---|---|
| `journalctl --vacuum-size=100M` (журнал был 229 МБ) | +150 МБ |
| `apt-get clean` | +111 МБ |
| удаление **отключённых** ревизий snap (`firefox 8736`, `core22 2411`, `snapd 27591`) + `refresh.retain=2` | +74 МБ |
| очистка `/var/lib/snapd/cache` (кэш загрузок snapd) | +515 МБ |
| `docker rmi chromedp/headless-shell` (516 МБ unique, 0 контейнеров, в CI не с этого хоста) | +493 МБ |
| `docker rmi curlimages/curl`, `koalaman/shellcheck`, `nginx:alpine` (не ссылается ни один Dockerfile/compose) | +129 МБ |
| `./scripts/deploy.sh reclaim` (safe — untagged образ дашборда) | +2 МБ |
| **Итого** | **+1474 МБ** |

```
free before : 4233 MB   (margin над floor 4096 МБ  =   137 МБ, 3,3 %)
free after  : 5707 MB
preflight   : ✓ free space 5596 MB ≥ required 4096 MB   (margin = 1500 МБ, 37 %)
build cache : 1.898 GB — СОХРАНЁН (101 запись)
inodes      : 1 366 335 свободно ≥ 100 000
```

**Что сохранено намеренно:** тёплый build cache (без него холодная
`production-orca` не влезет вовсе), базовые образы сборки
(`node:22-alpine`, `nginx:1.30.4-alpine`, пиннинг по sha256), оба
`:last-known-good` образа — их ID **сверены с `.deploy/state.env`**, откат остался
рабочим:

```
LKG_IMAGE_ID_print_orchestrator = sha256:b98cf9db291f…   →  атрибут образа совпал
LKG_IMAGE_ID_print_dashboard    = sha256:527e75b5fee2…   →  атрибут образа совпал
```

Холодную сборку **не запускал**: единственный способ её «доказать» — сначала снести
кэш, что прямо запрещено заданием и оставило бы хост в худшем состоянии, чем до
сессии. Оценка по факту: деплой 21:33 стоил −1303 МБ (новый образ 1,16 ГБ + рост
кэша). При 5596 МБ такой цикл теперь завершается с ~4,3 ГБ — **выше** порога, тогда
как до уборки он упирался в 3708 МБ и деплой падал.

**Cold-build disk margin = WARN.** Один полный цикл деплоя теперь проходит без
ручного вмешательства, чего раньше не было. Но каждый деплой оставляет
предыдущий образ оркестратора (1,16 ГБ) как `:previous`/`:last-known-good`, поэтому
на дистанции 32-ГБ диск всё равно упрётся. Это не программный дефект и порогами не
лечится.

---

## II.8 Git

Исходники не менялись. Опубликованные коммиты `34d7597` и `d44b05a` не переписывались,
force-push не делался, история не разбивалась, ничего не пушилось.

```
$ git status --porcelain → (пусто до правки этого отчёта)
$ git log --oneline -3   → d44b05a · 34d7597 · 357f912
```

Изменения этой сессии лежат **вне** Git и к репозиторию не относятся:
`/etc/docker/daemon.json` (+ root-only копия `daemon.json.before-atelier-fix`),
журнал systemd, кэши apt/snapd, локальные Docker-образы. `fstab` и LVM **не менялись**.

---

## II.9 Итоговая матрица

| Критерий | Результат |
|---|---|
| Production deploy | **PASS** |
| No-op deploy | **PASS** |
| LKG semantics | **PASS** |
| Rollback e2e | **PASS** (кросс-версионно — в песочнице; на проде — одноимиджево) |
| Backup | **PASS** — новый набор `2026-08-18T19-00-20Z`, VERIFIED |
| Restore | **PASS** — изолированный рехёрсал, 25/25 таблиц, 6/6 blob'ов по SHA-256 |
| SQLite integrity | **PASS** — до и после рестарта демона |
| nginx dynamic DNS | **PASS** — пережил реальную смену IP при рестарте Docker |
| Active-print gate | **PASS** |
| **Docker restart recovery** | **PASS** — стек поднялся сам за 43 с, данные целы |
| **BuildKit GC config** | **PASS** — правка применена, демон её загрузил (границы проверки — II.3) |
| **Cold-build disk margin** | **WARN** — 1500 МБ запаса вместо 137 МБ; потолок в 32-ГБ диске |
| **External physical backup** | **DEGRADED** — накопитель не отдаёт блочное устройство, нужна физика |

---

## II.10 Вывод

### 1. Можно ли считать Atelier production-ready?

**YES WITH RESIDUAL RISKS.**

Программная часть закрыта полностью и проверена на живом проде: деплой, no-op,
LKG, откат, бэкап, восстановление, целостность БД, динамический резолв nginx,
гейт по печати — и теперь ещё и **восстановление после рестарта Docker-демона**,
самый честный тест из всех: демон погасили целиком, стек вернулся сам, IP апстримов
переехали, ни одна строка данных не потерялась. Остаточные риски —
**исключительно железные**: 32-ГБ системный диск и неработающий внешний накопитель.

### 2. Какие проблемы реально остались

1. **Внешнего бэкапа не существует.** Наборы валидны и восстановимы, но лежат на
   том же физическом носителе, что и production. Потеря/кража/смерть хоста =
   потеря и данных, и бэкапа. USB-мост `13fd:0840` энумерируется, а диск за ним
   не отвечает — блочного устройства нет; три программные попытки не помогли.
2. **Дисковый потолок.** Root — 26,76 ГБ и расширять его некуда: PV/VG/LV забиты
   под ноль, весь накопитель 29,82 ГБ. Запас поднят с 137 МБ до 1500 МБ уборкой
   мусора, но это разовый выигрыш: каждый деплой оставляет ещё один образ
   оркестратора на 1,16 ГБ. Через несколько циклов запас снова истает.
3. **Кросс-версионный откат на самом production не проверялся** (проверен в
   изолированной песочнице тем же неизменённым `deploy.sh`). Чтобы проверить
   на проде, нужно намеренно выкатить туда сломанный образ.
4. **`print-orchestrator` в состоянии `degraded`** — `ender3-v3-ke` offline.
   Обслуживаемое состояние, `ready:true`; не дефект ремедиации.

### 3. Что нужно сделать физически

1. **Внешний накопитель — по порядку:**
   а) переставить в **синий порт USB 3.x** (шина USB 3.0 контроллера сейчас
      полностью пуста, а корпус висит на USB 2.0);
   б) обязательно **кабелем USB 3.x** (широкий сдвоенный Micro-B или USB-C) —
      кабель USB 2.0 физически входит в разъём USB 3.0 Micro-B и даёт только 480 Мбит и 500 мА;
   в) дать **внешнее питание** (Y-кабель на два USB-A или БП корпуса);
   г) если не помогло — проверить сам SSD **напрямую в SATA** другого компьютера:
      это разделит «умер мост» и «умер диск»;
   д) при живом диске и мёртвом мосте — заменить USB-SATA корпус/мост.

   Признак успеха в `journalctl -k`: появляются `scsi 2:0:0:0: Direct-Access …` и
   `sd 2:0:0:0: [sdb] Attached SCSI disk`. Дальше: узнать UUID, смонтировать
   (`nofail`), прописать `BACKUP_DISK_UUID` в `ops/backup/backup.conf` (резолв по
   UUID уже реализован в `config.sh`), `backup.sh --full` → `verify.sh` → restore-тест,
   и доказать через `findmnt`, что бэкап и `/` — на разных устройствах.

2. **Системный накопитель.** Единственное настоящее решение проблемы места —
   заменить 32-ГБ модуль на нормальный SSD (256 ГБ и больше) либо добавить второй
   внутренний диск и вынести на него `/var/lib/docker` + `/var/lib/containerd`.
   Программно этот потолок не обходится, и понижать `DEPLOY_MIN_FREE_MB` под него
   нельзя — порог отражает реальный пик холодной сборки OrcaSlicer.
