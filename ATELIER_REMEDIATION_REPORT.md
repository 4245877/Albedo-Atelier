# Atelier — отчёт о ремедиации

**Дата:** 2026-08-18
**Базовая ревизия:** `357f912` — та же, на которой писался аудит (рабочее дерево было чистым), поэтому **все 22 находки актуальны**, ни одна не «устарела».
**Хост:** thinkcentre / 192.168.0.139, Ubuntu, Docker 29.6.1, containerd image store.

> **Статус деплоя: НЕ ВЫПОЛНЕН — намеренно.**
> На протяжении всей работы шли печати (на старте K2 48 % + A1 14 %, на момент отчёта A1 88 %).
> Согласно ограничению задания, `deploy`, `rollback`, `docker compose down`, перезапуск
> оркестратора и рестарт Docker-демона **не выполнялись**. Код, тесты и backup-инфраструктура
> готовы полностью; swap ждёт окна без активных печатей. Обход через `--allow-active-prints`
> не применялся.

---

## Сводка

| Приоритет | Исправлено | Всего |
|---|---|---|
| **P0** | 2 полностью + 1 частично | 3 |
| **P1** | 8 / 8 | 8 |
| **P2** | 6 / 6 | 6 |
| **P3** | 3 / 3 (+2 отложены осознанно) | 5 |

**Тесты:** 957 unit + 604 integration = **1561, падений 0**.
Базовая линия до работы: 953 pass / **1 fail** — предсуществующее падение
`registry.test.ts`, не связанное с аудитом, тоже исправлено.
`shellcheck -x -S style` — чисто на `scripts/deploy.sh` и всех `ops/backup/*.sh`.

| Критерий приёмки | Результат |
|---|---|
| Backup/restore | **PASS** — реальный restore проверен, counts совпали, 9/9 blob'ов сверены по SHA-256 |
| Cold build capacity | **PASS** с оговоркой — 5012 МБ против порога 4096 МБ (запас ~0.9 ГБ, см. AT-007) |
| Deploy signal handling | **PASS** — 24/24 проверки, до фикса 14 падало |
| Active-print safety | **PASS** — gate перечитывает данные перед swap, fail-closed, проверен на живой ферме |
| Rollback | **PASS (код + модульно)** / **DEFERRED (e2e)** — сквозной сценарий требует деплоя |
| Restart recovery | **PASS** — 3 теста, включая закреплённое до-фиксовое поведение |
| SQLite compatibility guard | **PASS** — тест падает без гварда, проходит с ним |
| nginx dynamic DNS | **PASS** — включая сценарий, который аудит не смог воспроизвести |
| No-op deploy | **PASS (механизм доказан)** / **DEFERRED (e2e)** |

---

# P0

## AT-001 · Бэкапа не существует · **FIXED**

### Было
Ни одного механизма резервного копирования. `queue.db` (очередь, runs, **инвентарь принтеров
с device-credentials**), `state.json`, `artifacts/` и `.env` существовали ровно в одном
экземпляре на одном диске, заполненном на 92 %.

### Исправлено
Новый каталог `ops/backup/`:

| Файл | Назначение |
|---|---|
| `config.sh` | Конфигурация, разрешение backup-root по **UUID**, guard опасных путей |
| `snapshot-db.js` | `VACUUM INTO` на **read-only** соединении + метаданные снимка |
| `backup.sh` | Создание набора, манифест, retention, самопроверка перед публикацией |
| `verify.sh` + `verify-set.js` | Независимая проверка набора (запускается на хосте) |
| `restore.sh` | Восстановление; по умолчанию — в отдельный каталог, не в production |
| `atelier-backup{,-full}.{service,timer}` | Systemd **user**-таймеры (на хосте нет passwordless sudo) |
| `install-timers.sh` | Установка + проверка lingering |
| `backup.conf.example` | Настройки хоста (в `.gitignore`) |

**Консистентность queue.db ↔ artifacts — доказана по коду, а не заявлена.**
Порядок: **снимок БД → потом artifacts → потом проверка**. Обоснование:
* blob'ы content-addressed и **иммутабельны** — `commit()` при существующем ключе
  дедуплицирует и никогда не перезаписывает ([artifactStorage.ts:129-159](apps/print-orchestrator/src/infra/storage/artifactStorage.ts#L129-L159));
* blob фиксируется **до** вставки строки ([ingest.ts:84](apps/print-orchestrator/src/app/artifacts/ingest.ts#L84) против [:112](apps/print-orchestrator/src/app/artifacts/ingest.ts#L112));
* удаление blob'ов достижимо **только** явными API-вызовами, фонового sweep нет
  ([routes.ts:232](apps/print-orchestrator/src/modules/print/routes.ts#L232), [routes.ts:270](apps/print-orchestrator/src/modules/print/routes.ts#L270)).

Отсюда: копия artifacts, снятая **после** снимка, — надмножество нужного. Обратный порядок
допускал бы ссылку на blob, скопированный слишком рано. Остаточное окно (оператор удаляет
артефакт во время прогона) закрывает шаг 3, который **проверяет наличие каждого**
referenced blob и валит прогон, а не публикует тихо битый набор.
**«Атомарным» снимок тома не назван — он им не является.**

`VACUUM INTO` выбран потому, что он корректен на живой WAL-базе, где `cp queue.db` — нет;
read-only соединение делает запись в production структурно невозможной (проверено: работает).

### Проверка
```
$ ./ops/backup/backup.sh --full
  ✓ queue.db snapshot: integrity=ok schema_version=13
  ✓ artifacts: 6 file(s), 13M            ← 9 ссылок → 6 blob'ов (дедупликация)
  artifact references: 9/9 blobs present
  VERIFIED → published .../daily/2026-08-18T15-19-00Z (14M)

$ ./ops/backup/restore.sh --to-dir <scratch>      # РЕАЛЬНЫЙ restore
  integrity_check   : ok
  foreign_key_check : clean (0 violations)
  count printers 3 · print_tasks 6 · print_runs 2 · artifacts 9 · schema_migrations 13
  artifact blobs    : 9/9 present, 0 checksum mismatch   ← байты перехешированы
  ARTIFACT VERIFICATION: PASS
```
Все counts **совпали с production baseline** (Фаза 0). Временные данные удалены.

Таймер отработал **сам**, без участия оператора:
```
$ systemctl --user list-timers 'atelier-backup*'
atelier-backup.timer       LAST Tue 2026-08-18 19:03:05 EEST (20min ago)
atelier-backup-full.timer  NEXT Wed 2026-08-19 04:15:02 EEST
linger: yes        ← пережидает logout и reboot
```
Дополнительно проверено: retention реально удаляет (7 наборов → 3 при `RETAIN_HOURLY=3`,
удаляются старейшие); guard отвергает `/`, `/var/lib/docker`, `/home`, `/mnt`, пустой путь и
пути внутри git-checkout; ошибка даёт **ненулевой код** и не оставляет `.incomplete`;
секретов нет ни в journald, ни в манифестах (проверено поиском реального значения токена).
Права: каталог `0700`, `.env`-копия `0600`.

### Остаточный риск
**Выделенный 240-ГБ диск физически не подключается.** Корпус USB-SATA (Initio INIC-1618L)
энумерируется, но SCSI-устройство не появляется — сброс каждые ~3 с, `lsblk` видит только
внутренний `sda`. `mnt-data.mount` даёт «Dependency failed» **5201 раз** с загрузки 9 дней
назад. Это аппаратная проблема (кабель/питание/корпус/диск), из софта не решаемая, а
passwordless sudo для монтирования на хосте нет.

Поэтому бэкапы сейчас идут в `~/atelier-backups` — **на тот же физический диск**, и каждый
прогон печатает `DEGRADED`. Это защищает от потери Docker-тома, ошибки оператора и
повреждения ФС внутри тома, но **не** от смерти диска, гибели хоста, кражи, пожара и
ransomware. Механизм заранее сделан target-agnostic: как только диск вернётся, достаточно
прописать `BACKUP_DISK_UUID` в `ops/backup/backup.conf` — код не меняется.
**Это второй приоритет к исправлению после деплоя.**

---

## AT-007 · Диск / деплой заблокирован · **PARTIALLY FIXED**

### Было
`2303 МБ` свободно при пороге `4096 МБ` — preflight падал, деплой был невозможен.

### Исправлено
Удалены **только доказуемо неиспользуемые** версии VS Code server. Использование проверялось
по `/proc/*/exe`, `/proc/*/fd/*` и `/proc/*/maps`, а не по датам:

| Удалено | Размер |
|---|---|
| `cli/servers/Stable-c2d1b13f…`, `Stable-df53daab…`, `Stable-e4c7e7b1…` | 2072 МБ |
| `bin/1b6a188127…` | 598 МБ |
| 3 устаревших CLI-бинаря `code-*` | 96 МБ |

Активная версия `a5b500951314…` (29 fd, 8 maps) и `code-df53…`, удерживаемый живым pid 6001,
**не тронуты**; сессия VS Code Remote не прерывалась. `lru.json` приведён в соответствие.

### Проверка
```
root free : 2295 МБ → 5012 МБ   (92% → 81%)
.vscode-server : 5,6G → 2,9G

$ ./scripts/deploy.sh preflight ; echo $?
  ✓ free space 5056 MB ≥ required 4096 MB
  ✓ Preflight passed
0                                  ← было 1 (точное воспроизведение аудита)
```

### Остаточный риск / что НЕ сделано
1. **`/etc/docker/daemon.json` (`minFreeSpace: 5GB`) не изменён.** Требует root и рестарта
   Docker-демона — а демон рестартовать при активной печати запрещено. Значение по-прежнему
   недостижимо (5 ГБ при 5,0 ГБ свободных), то есть BuildKit GC продолжит срезать тёплый кэш.
   **Подготовленное изменение:** `minFreeSpace` → `1GB`, `maxUsedSpace` → `2GB`. Применять в
   окне без печатей.
2. **Запас честно тонкий.** 5012 МБ против 4096 МБ порога — около **0.9 ГБ** сверх требования
   холодной orca-сборки, а не «несколько ГБ», как просило задание. Порог **не понижался**,
   чтобы замаскировать это.
   27-ГБ корень для этого хоста мал не из-за Atelier (стек — ~3 ГБ образов + 14 МБ данных),
   а потому что на том же корне живут `.vscode-server` (2,9 ГБ даже после чистки), второй
   продакшен-стек fulfillment и apt/journald. Устойчивые варианты, в порядке предпочтения:
   расширить LV (в `ubuntu-vg` проверить `vgs`), перенести Docker data-root, либо выделить
   отдельный диск. **Backup при этом обязан остаться изолированным от Docker/BuildKit.**

---

## AT-002 · Ctrl+C оставляет сборку сиротой · **FIXED**

### Было
Только `trap ERR`. SIGINT убивал скрипт и watchdog, а `docker compose build` в своей
process-group продолжал есть диск **без защиты**, `tee` жил, и осиротевший потомок
удерживал `flock` (fd 9 без close-on-exec), блокируя все последующие деплои.

### Исправлено
[scripts/deploy.sh:141-211](scripts/deploy.sh#L141-L211) — единый путь teardown:
* `stop_build()` ([:141](scripts/deploy.sh#L141)) — `kill -TERM` по **process group**, ожидание, эскалация до `KILL`, `wait`;
* `cleanup()` ([:164](scripts/deploy.sh#L164)) — снимает watchdog, останавливает сборку, чистит temp и `state.env.tmp`;
* однократность через `CLEANUP_DONE` — гонки ERR/EXIT/INT нет;
* **guard `BASHPID == $$`** — трапы наследуются подоболочками при `set -E`, и teardown в
  `$(...)` снёс бы живой деплой (эта ошибка реально произошла при разработке backup.sh и была
  поймана);
* `trap on_signal INT 130` / `TERM 143` / `trap cleanup EXIT` ([:210-212](scripts/deploy.sh#L210-L212));
* **`9>&-`** на фоновой сборке ([:850](scripts/deploy.sh#L850)) и watchdog ([:877](scripts/deploy.sh#L877)) — lock больше не наследуется.

### Проверка
Гарнесс **подключает настоящий `scripts/deploy.sh`** (вырезан только блок разбора аргументов),
то есть тестируется отгружаемый код, а не его копия. Драйвер на Python запускает его в
отдельной сессии с **дефолтными диспозициями сигналов** — критично: bash ставит `SIGINT` в
`SIG_IGN` у асинхронных потомков неинтерактивной оболочки, и первая версия теста поэтому
ничего не воспроизводила.

| Сценарий | ДО (оригинал) | ПОСЛЕ |
|---|---|---|
| SIGINT во время build | exit −2, сирота build **1**, tee **1**, lock **STILL HELD** | exit **130**, сирот 0, tee 0, lock **FREE** |
| SIGTERM во время build | exit −15, сирот **2**, tee **1**, lock **STILL HELD** | exit **143**, сирот 0, tee 0, lock **FREE** |
| SIGINT сразу после build | exit −2, сирот **2** | exit **130**, сирот 0 |
| SIGINT в health wait | exit −2, сирот **2** | exit **130**, сирот 0 |

**24/24 проверки PASS; на исходном коде падало 14.** Temp-файлы и `state.env.tmp` — 0 в обоих
случаях после фикса. Продакшен-стек не затрагивался (сборка контейнеров не касается).

---

# P1

## AT-003 · `:previous` ≠ последняя рабочая версия · **FIXED**

### Было
`:previous` переставлялся на `:latest` **до** каждой сборки, безусловно. На хосте это
наблюдалось буквально: `:latest` и `:previous` указывали на один образ `64c1e5029898` —
отката не существовало. Второй деплой после неудачного делал rollback-таргетом **сломанную**
версию; no-op деплой уничтожал таргет навсегда.

### Исправлено
Три состояния теперь разделены явно ([deploy.sh:660-760](scripts/deploy.sh#L660-L760)):
`candidate` (`:latest` после сборки) · `currently-running` (пишется в стадии 2) ·
`last-known-good` (`:last-known-good` + записанный image ID).

* `adopt_last_known_good()` ([:724](scripts/deploy.sh#L724)) вызывается **только после** прохождения health **и** HTTP-проверок — в самом конце успешного деплоя;
* неудачный деплой таргет не трогает вовсе ⇒ второй неудачный не может продвинуть первый;
* no-op деплой (`IMAGES_CHANGED == 0`) таргет не сдвигает;
* bootstrap: если LKG ещё нет, а стек жив и healthy — он усыновляется однократно и явно (иначе на этом хосте отката не было бы вообще до первого деплоя);
* `SNAPSHOT_GIT_COMMIT` с ложной семантикой заменён на `LKG_GIT_COMMIT` / `DEPLOYED_GIT_COMMIT`;
* `do_rollback` сверяет `image_id(tag)` с записанным `LKG_IMAGE_ID_*` и **отказывается** при расхождении ([:1240](scripts/deploy.sh#L1240)).

### Проверка
`bash -n`, `shellcheck -x -S style` чисто; логика разделения проверена чтением и
согласована с AT-004/AT-009. **Сквозной сценарий (v1→v2→битый v3→rollback→v2) требует
реального деплоя и отложен** — см. «Что осталось».

---

## AT-004 · Gate и Compose решают по разным критериям · **FIXED**

### Было
Скрипт сравнивал `RootFS.Layers`, а `docker compose up` пересоздаёт контейнер по **image id**.
Пока `--provenance=false` держит id стабильным, они совпадают; как только перестанет — gate
скажет «не менялся» и не проверит печати, а compose всё равно пересоздаст оркестратор.

### Исправлено
Защита больше не зависит от флага. При «id изменился, rootfs идентичен»
([deploy.sh:1049-1065](scripts/deploy.sh#L1049-L1065)) тег `:latest` **возвращается на реально работающий образ**:
`docker tag "${RUNNING_IMAGE_ID[$svc]}" "${img_name}:latest"`. После этого compose видит
буквально тот же образ и пересоздать контейнер не может ни при каких настройках provenance.
Сообщение поднято с `detail` до `warn`.

### Проверка
Изолированный compose-проект, тот же демон. Сначала подтверждено, что compose **действительно**
пересоздаёт контейнер при изменении одного лишь id; затем — что `docker tag <image-id> name:tag`
на containerd store работает и корректно резолвится.

**Побочная находка, найденная этим тестом:** первая версия моей правки Dockerfile объявляла
`ARG GIT_COMMIT` в начале стадии, и rootfs менялся при каждом коммите — `ARG` инвалидирует
кэш для всех последующих инструкций, то есть пересобирался и 564-МБ apt-слой. Это молча
отключило бы всю защиту AT-004/AT-005. Блок идентичности перенесён в **конец** стадий
([Dockerfile:86-94](apps/print-orchestrator/Dockerfile#L86-L94)); проверено:
```
commit ccc111 -> image=382ba208a90e rootfs=8e3aff4919d6
commit ddd222 -> image=cbdd58801491 rootfs=8e3aff4919d6
  image id changed : YES (метаданные)   rootfs identical : YES ✓
```
Отдельно проверено, что блок идентичности в родительской стадии **не** инвалидирует дорогой
`RUN` дочерней `production-orca`.

---

## AT-005 · Active-print gate: устаревшие данные, fail-open, неавторитетный источник · **FIXED**

### Было
(a) `ACTIVE_PRINTS` снимался в preflight, а применялся после многоминутной сборки;
(b) `deploy.sh rollback` не проверял печати вообще; (c) опрос шёл через nginx дашборда и при
**любой** ошибке возвращал 0 — fail-open ровно тогда, когда ферме хуже всего.

### Исправлено
* `count_active_prints()` ([deploy.sh:560](scripts/deploy.sh#L560)) возвращает число **или строку `unknown`** — «не смог узнать» больше не равно «печатей нет»;
* `count_active_prints_live()` спрашивает оркестратор **напрямую** через `docker exec` по compose-сети; дашборд-прокси остался лишь запасным путём, и там JSON парсится через `jq`, а не подсчётом подстрок;
* `count_active_runs_db()` — канонические `PrintRun` в состоянии `RUNNING/PAUSED` из SQLite; они переживают уход принтера в offline, чего live-телеметрия не умеет. Берётся максимум из двух источников;
* `enforce_active_print_gate()` ([:605](scripts/deploy.sh#L605)) — **один** механизм для деплоя и отката, вызывается **непосредственно перед `up -d`** со свежими данными;
* при `unknown` — **fail-closed**, обход только явным `--allow-active-prints`.

### Проверка
На живой ферме (шли 2 печати):
```
live telemetry, direct orchestrator API : 2
canonical PrintRun RUNNING/PAUSED (db)  : 0     ← эти печати не имеют канонического run
combined gate value                     : 2
→ ✗ prints in flight (use --allow-active-prints to override)      ← БЛОКИРУЕТ

# оркестратор недоступен (эмуляция):
combined gate value: unknown
→ ✗ active-print state unknown (use --allow-active-prints to override)   ← FAIL-CLOSED
```
Расхождение 2 против 0 — наглядное подтверждение, что **оба** источника необходимы: старый
код (только live через nginx) при неисправном дашборде вернул бы 0.

---

## AT-006 · Учёт печати не переживает рестарт · **FIXED**

### Было
Два трекера, переживал рестарт только один. Канонический `PrintRun` в SQLite возвращался, а
in-memory идентичность (`printId`, `startedAtMs`, `amsStart`) — нет. Run «минтится» только на
переходе не-printing → printing, которого после рестарта не бывает, поэтому завершение
приходило в `consumeForPrint` с `run === undefined`: **автосписание пропускалось целиком**, а
длительность терялась. Долг оставался только строкой в ленте событий.

### Исправлено — устранена первопричина
* `hydrateRunFromCanonical()` ([printerPoller.ts:385](apps/print-orchestrator/src/app/printerPoller.ts#L385)), вызывается в начале каждого poll ([:241](apps/print-orchestrator/src/app/printerPoller.ts#L241)): если принтер печатает, а in-memory run отсутствует — он восстанавливается из канонического;
* `printId` = **канонический `PrintRun.id`** ⇒ ключ идемпотентности переживает рестарт, двойное списание невозможно;
* `startedAtMs` из durable `PrintRun.startedAt` ⇒ длительность не теряется;
* `amsStart` **персистится** в `PrintRun.metadata` ([createRuntime.ts](apps/print-orchestrator/src/bootstrap/createRuntime.ts)) при минте и при backfill ([:448](apps/print-orchestrator/src/app/printerPoller.ts#L448)); для Bambu `remain` абсолютен, поэтому сохранённый старт делает расход восстановимым;
* когда run восстановить нельзя — заводится **durable** `UnreconciledConsume` в `state.json` (с id, принтером, файлом, временем и причиной; ограничен 200 записями), вместо разового события ленты. Есть `listUnreconciled()` / `clearUnreconciled()`.

Метаданные, а не новая колонка: несколько сотен байт на run, читаются только путём
восстановления, индексов не требуют — миграции ради этого не нужно.

### Проверка
`src/app/restartRunRecovery.test.ts` — три теста, **процесс-рестарт эмулируется буквально**:
первый `PrinterPoller` выбрасывается, создаётся второй, канонический run переживает.
```
✔ a print that survives a restart keeps its run id, duration and deduction
    duration = 130 мин (весь прогон, через рестарт)   списаний ровно 1
    ключ идемпотентности содержит run-canonical-1     предупреждения «не отслеживалась» нет
✔ without recovery the same restart loses the deduction (the pre-fix behaviour)
    ← до-фиксовое поведение закреплено как регрессионный сторож
✔ unreconciled debts survive serialization and can be acknowledged
```

### Остаточный риск
Восстановление опирается на существование канонического `PrintRun`. Печать, начатая мимо
очереди (как обе текущие на этой ферме — оба существующих run в БД `CANCELLED`), канонической
записи не имеет, поэтому по-прежнему не списывается автоматически — но теперь долг
**фиксируется durable**, а не исчезает из ленты.

---

## AT-008 · `reclaim` уничтожает кэш, нужный для сборки · **FIXED**

### Было
`reclaim` всегда делал `docker builder prune -a -f`: возвращал ~0.9 ГБ и делал следующую
сборку холодной, которой нужно ~4 ГБ. Хуже того, сообщение preflight о нехватке места
советовало `reclaim` **первым пунктом** — худший из возможных советов в этот момент.

### Исправлено
`do_reclaim()` ([deploy.sh:1306](scripts/deploy.sh#L1306)) разделён:
`reclaim --safe` (по умолчанию) — только `image prune -f`, кэш сохраняется;
`reclaim --cache` — дополнительно `builder prune -a -f`, с явным предупреждением, что
следующая сборка станет холодной и потребует ~4096 МБ. `--cleanup` после деплоя теперь тоже
`--safe`. Подсказка preflight переупорядочена: сначала устаревшие `.vscode-server`
(на этом хосте — самый крупный выигрыш), затем `image prune`, `journalctl --vacuum-size`, и
только последним — `reclaim --cache` как «last resort». Volume-операций по-прежнему нет
нигде.

### Проверка
`shellcheck` чисто; `./scripts/deploy.sh --help` показывает оба режима; путь `--safe`
подтверждает сохранение кэша строкой `build cache still held`.

---

## AT-009 · Rollback не проверяется · **FIXED**

### Было
```bash
dc up -d --no-build
ok "previous images are running again"     # ← печаталось до любой проверки
```
Откат на неподнимающийся образ рапортовал успех и выходил 0.

### Исправлено
`do_rollback` ([deploy.sh:1229](scripts/deploy.sh#L1229)) после `up -d` вызывает
`rollback_verify()` ([:1282](scripts/deploy.sh#L1282)) — те же `wait_for_health` и `verify_http`, что и в
деплое. `ROLLBACK VERIFIED` печатается **только** после их прохождения; иначе —
`ROLLBACK FAILED`, диагностика (`dump_failure`), указание на pre-deploy снимки и
`ops/backup/restore.sh`, и **ненулевой код возврата**. Флаг `ROLLBACK_IN_PROGRESS`
предотвращает рекурсию (откат отката) через `handle_verification_failure`.

### Проверка
`bash -n` + `shellcheck` чисто; отсутствие рекурсии проверено чтением пути
`handle_verification_failure` → `ROLLBACK_IN_PROGRESS` → `die`. Сквозной прогон отложен
вместе с деплоем.

---

## AT-010 · nginx резолвит upstream один раз · **FIXED**

### Было
`proxy_pass http://print-orchestrator:3100/;` без `resolver` — имя резолвится один раз при
парсинге конфига. Последствия: nginx **не стартует**, если upstream ещё не поднялся
(`[emerg] host not found in upstream`, а `restart: unless-stopped` не знает про `depends_on`),
и может залипнуть на мёртвом IP.

### Исправлено
[nginx.conf:56](apps/print-dashboard/nginx.conf#L56) — `resolver 127.0.0.11 valid=10s ipv6=off;` + переменные upstream.

**Ключевая тонкость семантики URI:** при переменной в `proxy_pass` nginx перестаёт заменять
префикс location и отправил бы URI директивы буквально — то есть `proxy_pass http://$up:3100/;`
слал бы `/` для **каждого** запроса и сломал бы всю маршрутизацию. Поэтому путь формируется
явно через `rewrite … break`, а `proxy_pass` идёт **без** URI-части.

### Проверка
Изолированная сеть + backend, который отражает полученный путь.

**Тест 1 — старт без upstream:**
`old → nginx: [emerg] host not found in upstream` · `new → configuration test is successful`

**Тест 2 — семантика URI (регрессия):**
| Запрос | old | new | |
|---|---|---|---|
| `/api/print-orchestrator/` | `PATH=/` | `PATH=/` | ✓ |
| `/api/print-orchestrator/health` | `PATH=/health` | `PATH=/health` | ✓ |
| `…/api/printers?x=1&y=2` | `PATH=/api/printers?x=1&y=2` | то же | ✓ |
| `…/a/b/c` | `PATH=/a/b/c` | `PATH=/a/b/c` | ✓ |

**Тест 3 — смена IP upstream** (аудит пометил как «не воспроизведено»; **воспроизведён**:
старый адрес занят squatter-контейнером, чтобы IPAM выдал другой):
```
backend IP: 172.21.0.2 → 172.21.0.5   (nginx НЕ перезапускался)
old  HTTP 502  <html>502 Bad Gateway   STUCK ON DEAD IP ✗
new  HTTP 200  PATH=/health            RECOVERED ✓
```
Лечения через обязательный рестарт дашборда не потребовалось.

---

## AT-013 · Старый образ молча принимает схему из будущего · **FIXED**

### Было
`runMigrations` игнорировал неизвестные версии в `schema_migrations` — обратной проверки не
было. Откат на старый образ после миграции **стартовал успешно** и дальше либо падал на
`NOT NULL` в рантайме, либо тихо расходился с фактической схемой. Восстановить нечем (AT-001).

### Исправлено
1. **Guard совместимости** ([migrations/index.ts:93](apps/print-orchestrator/src/infra/db/migrations/index.ts#L93)): `KNOWN_MAX_SCHEMA_VERSION` выводится из реестра (дрейфовать не может); при `MAX(schema_migrations.version) > known_max` бросается `SchemaTooNewError` ([:62](apps/print-orchestrator/src/infra/db/migrations/index.ts#L62)) с явным текстом «database schema is newer than this application image» и указанием на restore. Вызывается **до** применения чего-либо ([:134](apps/print-orchestrator/src/infra/db/migrations/index.ts#L134)). Тихое повреждение превращается в честный crash-loop, который `wait_for_health` видит.
2. **Pre-deploy снимок БД** — `snapshot_database()` ([deploy.sh:762](scripts/deploy.sh#L762)) делает `VACUUM INTO` перед swap в `.deploy/db-snapshots/` (не в `/tmp`), хранит последние 10, права `0600`. Это «undo» именно этого деплоя, **не замена** `ops/backup`.
3. **Авто-откат через миграцию запрещён**: `deploy_applied_migrations()` грепает логи оркестратора, и при обнаружении миграции `--rollback-on-failure` **блокируется** с инструкцией по осознанному восстановлению.

### Проверка
```
$ node --test src/infra/db/migrations/migrations.test.ts
✔ refuses to start when the database schema is newer than the image
✔ the guard does not fire on an equal or older schema
✔ a database with no migration bookkeeping is not rejected
```
**Регрессионное доказательство** — с закомментированным вызовом гварда:
`ℹ pass 5 · fail 1 · ✖ refuses to start when the database schema is newer than the image`.
Тест падает без фикса и проходит с ним.

---

# P2

## AT-011 · Нельзя понять, какая версия запущена · **FIXED**

**Было:** ни лейблов, ни `/version`; `SNAPSHOT_GIT_COMMIT` записывал **новый** коммит под
заголовком «состояние, к которому вернёт rollback».

**Исправлено:**
`org.opencontainers.image.revision` / `.created` / `.title` в обоих Dockerfile;
`GET /version` у оркестратора ([version.ts](apps/print-orchestrator/src/infra/observability/version.ts)) — commit, build time, dirty, uptime;
`deploy.sh status` печатает фактический revision **запущенного** контейнера, читая лейбл
образа, с которого он стартовал (`running_revision()`, [deploy.sh:1334](scripts/deploy.sh#L1334));
семантика исправлена на `LKG_GIT_COMMIT` / `DEPLOYED_GIT_COMMIT`.

`BUILD_TIME` — это временная метка **коммита**, а не «сейчас»: wall-clock менялся бы при
каждом прогоне, и пересборка неизменного дерева давала бы другой образ, ломая no-op деплой.
Идентичность живёт только в **конфиге** образа, никогда в слое ФС (см. AT-004).

**Проверка:**
```
$ ./scripts/deploy.sh status
  go2rtc               running healthy 0   rev=b5948cfb2540
  print-orchestrator   running healthy 0   rev=unlabelled     ← честно: образ собран до правки
  print-dashboard      running healthy 0   rev=unlabelled
```

## AT-012 · `/ready` не видит БД · **FIXED**

**Было:** readiness учитывала только возраст poll'а. Повреждённая БД → poll-цикл продолжает
крутиться (ошибки только логируются), `/ready` = 200, Docker healthy, деплой зелёный — при
мёртвой очереди.

**Исправлено:** `probeDatabase()` ([database.ts:92](apps/print-orchestrator/src/infra/db/database.ts#L92)) — дешёвый `SELECT COUNT(*) FROM schema_migrations`,
проброшен в `getReadiness()` и проверяется **первым**: при отказе `status:"db_unavailable"`,
`ready:false` → **HTTP 503**. Однократный `PRAGMA integrity_check` при старте
([:66](apps/print-orchestrator/src/infra/db/database.ts#L66)) — громкий лог при `!= ok`, **не** фатальный (в отличие от схемы из будущего,
которая фатальна) и **не** на каждый `/ready`. Метрика `print_orchestrator_db_ok`.

## AT-014 · Watchdog: ложное срабатывание и отсутствие проверки перед `up -d` · **FIXED**

**Исправлено:** повторный `kill -0 "$BUILD_PID"` **после** `sleep` ([deploy.sh:868](scripts/deploy.sh#L868)) — сборка,
завершившаяся во время сна, больше не даёт пугающего «cancelling the build» и сигнала в
возможно переиспользованный pgid; флаг-файл `.deploy/watchdog.tripped` различает «отменено
ради диска» (**отдельный код возврата 3**) от «не скомпилировалось»; если watchdog сработал,
а сборка всё же удалась — честное предупреждение вместо необъяснённой строки; **проверка
свободного места непосредственно перед `up -d`** — preflight доказывал состояние до сборки,
съевшей гигабайты.

## AT-015 · Весь `.env` уезжает в контейнер · **FIXED**

**Было:** `env_file: .env` инжектил файл целиком.

**Исправлено:** `env_file` убран, нужные переменные перечислены явно. Установлено
эмпирически (рендер конфига с `env_file` и без), что файл добавлял 9 переменных: 4 реально
нужны (`ORCHESTRATOR_API_TOKEN`, `BAMBU_A1_SERIAL`, `BAMBU_A1_ACCESS_CODE` — подставляются в
`printers.json` внутри контейнера, — и `NIGHT_PRINT_WINDOW`), 5 были чистой утечкой.

**Проверка:**
```
ключей у оркестратора: 36 → 31
убрано: COMPOSE_FILE, DASHBOARD_BIND, GO2RTC_WEBRTC_CANDIDATE, K2_CAMERA_SOURCE, ORCA_HOST_DIR
потеряно нужного: (пусто)
дашборд: 1 ключ — только ORCHESTRATOR_API_TOKEN, никаких device/fulfillment credentials
```
Побочно закрыт класс проблемы: переменная, добавленная в `.env` для постороннего инструмента,
больше не попадёт в оркестратор молча.

## AT-016 · Preflight не доказывает `COMPOSE_FILE` · **FIXED**

**Исправлено:** preflight читает **эффективный** `docker compose config`, и комбинация
«`ORCA_SLICER_CMD` задан + собирается lean» теперь **hard FAIL** с инструкцией, а не
бодрая строка `ok`; при `production-orca` дополнительно доказывается наличие монтирования
`/opt/orca`. `COMPOSE_FILE` в `.env.example` **раскомментирован**. Строка отчёта читает
значение из `.env` (compose читает его сам, оболочка — нет), иначе на этом хосте она врала бы
«unset».

**Проверка:** `✓ build target: production-orca` · `✓ OrcaSlicer runtime mount present` ·
`COMPOSE_FILE=compose.yml:compose.orca.yml (from .env)`.

## AT-017 · README · **FIXED**

Добавлены разделы: **Backup and restore** (процедура, расписание, доказательство
консистентности, проверенный restore, предупреждение про one-disk), **Reboot and recovery**,
**Reclaiming disk safely**, **Schema compatibility**, **Which version is running?**,
**Rollback limitations**. `COMPOSE_FILE` внесён в инструкцию первого запуска. Исправлено
«~3 GB» → 4096 МБ. Раздел **Persistence** приведён к реальной модели (queue.db — источник
истины; `state.json` — лента, счётчики, отложенные и **несверенные** списания). «Restart
cost» переписан под фактическое поведение после AT-006.

---

# P3

## AT-018 · `http_code` возвращал `000000` · **FIXED**
`curl -w '%{http_code}'` уже печатает `000`, после чего срабатывал `|| echo 000`.
Заменено на `|| true` + валидация на ровно три цифры.
**Проверка:** `code=[000]` (было `[000000]`).

## AT-019 · Нет валидации числовых флагов · **FIXED**
`assert_positive_int` ([deploy.sh:1370](scripts/deploy.sh#L1370)) проверяет **при разборе аргументов**, до любых
побочных эффектов (раньше `--health-timeout abc` падал арифметикой уже после preflight,
snapshot и полной сборки). Валидация выполняется в главной оболочке, а не в `$(...)`, иначе
`die` убил бы только подоболочку и оператор увидел бы обобщённый ERR вместо внятного текста.
`DEPLOY_MIN_FREE_MB` больше не схлопывает lean/orca — добавлены
`DEPLOY_MIN_FREE_MB_ORCA` / `_LEAN`.
**Проверка:** `--health-timeout abc`, `--min-free-mb ''`, `--min-free-mb 0` → авторские
сообщения; `--health-timeout 90 preflight` → проходит.

## AT-020 · Временные файлы не убираются · **FIXED**
Реестр `TEMP_FILES` + `new_temp()`, снос в `cleanup()` по `EXIT` (тем же патчем, что AT-002).
**Проверка:** во всех 4 сигнальных сценариях `leftover temp files: 0`, `state.env.tmp: 0`.

## AT-021 · `/api/printers/config` без аутентификации · **DEFERRED (осознанно)**
Согласно заданию, для доверенной домашней LAN это принятый риск, и внезапная аутентификация
сломала бы дашборд. **Изменений не вносил.** Предложение отдельно: не вводить токен на
read-путях, а сузить поверхность — привязать `DASHBOARD_BIND` к конкретному интерфейсу LAN
вместо `0.0.0.0`, либо закрыть 8090 файрволом для всего, кроме нужных подсетей. Это не
трогает фронтенд и снимает основную часть риска «готовая карта для сканирования».

## AT-022 · PostgreSQL fulfillment на `0.0.0.0:5433` · **DEFERRED (вне Atelier)**
Соседний проект. Согласно заданию, чужой продакшен без отдельной проверки его репозитория не
менял. Рекомендация остаётся: забиндить на `127.0.0.1`.

---

# Что осталось сделать

| # | Действие | Почему отложено |
|---|---|---|
| 1 | **Выполнить деплой** (`./scripts/deploy.sh`) | Идёт печать (A1 88 %). Все предусловия задания выполнены: бэкап есть, restore проверен, места хватает, signal handling и active-print gate исправлены |
| 2 | **Сквозные тесты rollback и no-op деплоя** | Требуют реального деплоя |
| 3 | **`/etc/docker/daemon.json`: `minFreeSpace` 5GB → 1GB** | Нужен root + рестарт Docker-демона |
| 4 | **Подключить 240-ГБ диск** и прописать `BACKUP_DISK_UUID` | Аппаратная неисправность USB-SATA |
| 5 | **Расширить LV / перенести Docker data-root** | Запас всего ~0.9 ГБ сверх порога |

**После деплоя проверить:** `docker compose ps` (running/healthy/restart count/revision),
порт 8090 LISTEN, `GET /` `/health` `/ready` `/metrics` `/version`, `PRAGMA integrity_check`,
`PRAGMA foreign_key_check`, сверку counts с baseline, неизменность persistent-тома.

---

# Изменённые файлы

```
 .env.example                                   |  13 +-
 .gitignore                                     |   3 +
 README.md                                      | 240 ++++-
 apps/print-dashboard/Dockerfile                |  17 +
 apps/print-dashboard/nginx.conf                |  34 +-
 apps/print-orchestrator/Dockerfile             |  27 +
 apps/print-orchestrator/src/app.ts             |  13 +
 .../src/app/dashboardReadModel.ts              |  24 +-
 .../src/app/filamentConsumption.ts             | 115 ++-
 .../src/app/printerPoller.ts                   | 130 ++-
 .../src/bootstrap/createRuntime.ts             |  70 +-
 .../src/domain/farm/types.ts                   |  11 +-
 .../src/domain/print/repositories.ts           |   6 +
 .../src/infra/db/database.ts                   |  49 ++
 .../src/infra/db/migrations/index.ts           |  72 ++
 .../src/infra/db/repositories/index.ts         |   7 +
 .../src/infra/observability/metrics.ts         |   1 +
 .../src/infra/persistence/stateStore.ts        |  39 +-
 .../src/shared/config/externals.ts             |  13 +
 .../src/shared/config/registry.ts              |   4 +-
 compose.yml                                    |  33 +-
 scripts/deploy.sh                              | 829 +++++++++++++++---
 + тесты: migrations.test.ts, printerPoller.consume.test.ts, stateStore.test.ts
 + новое: ops/backup/ (11 файлов), restartRunRecovery.test.ts, version.ts
```

Ничего не коммитилось, `git pull`/`git push` не выполнялись. Секреты, бэкапы, `.env`,
восстановленные БД и манифесты в Git не попадают (`.gitignore` дополнен
`ops/backup/backup.conf`).

---

# Что намеренно не трогалось

Аудит подтвердил корректность, и это сохранено: порядок preflight → build → up → health →
HTTP; отсутствие `docker compose down`; реальная отмена BuildKit watchdog'ом; `flock`;
`--no-build` при `up`; ротация Docker-логов; WAL / `foreign_keys` / `busy_timeout`;
транзакционные миграции; порядок graceful shutdown; разделение `/health` и `/ready`;
Docker healthchecks; security-middleware и укреплённый nginx; digest-pinned базовые образы;
`pnpm --frozen-lockfile`; restart policies. Volume-операций (`down -v`, `volume prune`,
`system prune --volumes`) в автоматических ветках по-прежнему нет.
