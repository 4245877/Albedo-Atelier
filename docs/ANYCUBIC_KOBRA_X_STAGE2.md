# Kobra X: кандидат расширения LAN-интеграции

Проверка: 2026-10-19. Исходная ревизия `72dfde5`, схема SQLite 19.
Production не развёртывался, контейнеры не перезапускались, production SQLite
открывалась только для SELECT host/TLS pin с `readOnly: true`. Принятая реализация
зафиксирована в `e19e81a`; финализация выпуска файлов/камеры и порядок применения —
в [плане redeploy](ANYCUBIC_KOBRA_X_RELEASE.md). Production остаётся на `72dfde5`.
`tls.ts`, механизм pinning, PrintRun, BedCycle и правила списания материалов не изменялись.

## Реальные наблюдения: modelId 20030, firmware 2.0.2.2

Все аппаратные проверки были запросами чтения. MQTT `video`, `light/control`,
`print/*`, HTTP-загрузка и удаление не выполнялись.

### Файлы

Запрос к `…/web/printer/{modelId}/{deviceId}/file`:

```json
{"type":"file","action":"listLocal","data":{"path":"/","page_num":1,"page_size":200},"msgid":"<uuid>","timestamp":0}
```

В действительном запросе timestamp — текущие миллисекунды, msgid — новый UUID.
`listLocal` читает память, `listUdisk` — USB. Для вложенной папки памяти проверен
`path: "/test_model"`.

Ответ `…/file/report`: `code: 200`, `state: "done"`,
`data: {list_mode: 0, records: [...]}`. Запись содержит `filename`, `display_name`,
`is_dir`, `size` (байты), `timestamp` (миллисекунды), `fileKey`.
`fileKey` не считается хешем содержимого и не передаётся в публичный список.
Символ `+` в имени сохраняется буквально.

В корне найдены 6 файлов и встроенная папка; в ней — 15 файлов. Размеры и даты
получены для реальных файлов. USB отсутствует (`udisk: 0`); `listUdisk` возвращает
успешный пустой список. Работа с физически подключённым USB ещё не проверена.

Важная особенность: без `page_num` и `page_size` получен отказ **10112**.
Однако при `list_mode: 0` прошивка игнорирует значения страниц: запросы страниц
1, 2, 5 с размером 2 вернули те же 7 записей. Адаптер читает полный снимок одним
запросом; неизвестный `list_mode` отвергается, а не выдаётся за пустую папку.

`fileDetails` с `data: {root: "local", filename: "<реальное имя>"}` подтверждён.
Получены `file_size`, `estimated_time_s`, `layer_count`, параметры сопла и нарезки,
температуры, расход, объекты, `thumbnail`, `svg_image`; `png_image` был пустым.
Превью не вставляются как произвольный SVG/HTML в dashboard. Автоматического
запроса деталей каждого файла нет.

Аппаратные пределы числа файлов/длины пути не установлены. Ограничения Atelier:
512 КиБ на MQTT-ответ, 20000 записей, 200 байт на сегмент и 400 на относительный
путь, включая `local/` или `usb/`. Неподдерживаемая запись вызывает ошибку, а не
скрытую потерю файлов. Каталоги памяти и USB разделены виртуальными корнями.

Прошивка заменяет `msgid` в ответах. Поэтому чтения одного типа сериализованы;
дополнительно проверяются action, собственный topic и форма данных. `fileDetails`
проверяет имя и хранилище. Generic MQTT ACK и retained-сообщения не подтверждают
чтение. Таймаут закрывает поколение соединения, чтобы поздний ответ не подтвердил
следующий запрос. Полной корреляции с файловыми запросами сторонних LAN-клиентов
прошивка не предоставляет; особенно это важно перед будущим разрешением записи.

### Камера

`peripherie/query` вернул `camera: 1`. В `info.data.urls.rtspUrl` находится
**HTTP**, а не RTSP: `http://<printer>:18088/live/<private-token>`.
Адрес не публикуется в API и логах.

Обычный GET уже отдаёт **HTTP 206, video/x-flv, H.264**, без команд включения
камеры. Кодек подтверждён go2rtc как H264, MP4 — `avc1.640028`.
Проверены два одновременных MP4-потребителя временного go2rtc 1.9.14:
оба получили HTTP 200 и `ftyp`, соединение с принтером было **одно**;
через 7 секунд после закрытия активных upstream было **ноль**.

Установленный go2rtc 1.9.14 не принимает upstream HTTP 206, поэтому одной
подстановки нативного URL недостаточно. Расширен существующий `camera.mp4`
прокси: он выдаёт FLV с HTTP 200, получает актуальный приватный адрес из общей
MQTT-сессии и ограничивает upstream одним соединением. Go2rtc получает только
постоянный адрес backend, без токена. При разрыве MQTT upstream закрывается;
повторное подключение обновляет URL. Redirect на другой адрес запрещён.

Просмотр использует существующие WebRTC-плееры карточки, раздела камер и
увеличенного окна. Добавлен один точный stream id в allowlist nginx;
универсальный API go2rtc по-прежнему недоступен браузеру. Проверены изолированные
тесты прокси и действительный MP4-поток; ручная проверка браузерного WebRTC после
активации конфигурации ещё требуется.

Для будущей активации подготовлен полный `config/go2rtc-kobra-x.yaml`;
`docs/examples/go2rtc-anycubic.yaml` остаётся поясняющим фрагментом.
Рабочий смонтированный `config/go2rtc.yaml` и поля принтера в production не менялись.
После отдельного разрешения на развёртывание нужно выбрать полный кандидат через
`GO2RTC_CONFIG_PATH` и установить `streamUrl` принтера согласно примеру. `snapshotUrl` остаётся
пустым до проверки снимков. Управление `startCapture`/`stopCapture` исследовано,
но не выполнялось и не требуется для подтверждённого пассивного просмотра.
Срок действия токена и поведение после аппаратной перезагрузки ещё не измерены.

### Свет

`light/query` вернул единственную запись `{type: 3, status: 0, brightness: 0}`.
В [исходнике grunna](https://github.com/grunna/ha-anycubic-kobra-x-lan/blob/main/custom_components/anycubic_kobra_x_lan/light.py)
тип 3 назван **Camera light**, тип 2 — Chamber light.
Это указание назначения по стороннему источнику; физическое соответствие лампе
конкретного устройства нужно подтвердить включением/выключением отдельно.

Подготовлен on/off типа 3 через существующие light service/scheduler и карточку.
Состояние обновляется только по `light/query`; `light/control` ACK не меняет
индикацию. Успех возвращается только после совпадения фактического состояния.
Управление яркостью не предоставляется: поддержка числового поля ещё не доказывает
физическое диммирование.

### Печать, загрузка и старт

Пауза/продолжение/отмена подготовлены под общий command service, но закрыты
production policy. Чтение файлов не расширяет `isReadOnlyQuery`. При финализации
выпуска файлов/камеры отключены также прежние env allowlists:
`ANYCUBIC_LIGHT_CONTROL_PRINTERS` и `ANYCUBIC_PRINT_CONTROL_PRINTERS` не могут
разрешить физические команды. Для последующего открытия категории нужны её
аппаратная приёмка и отдельное изменение policy. Включение света в будущем
подключит также существующую политику расписания.

Дополнительно проверяются modelId 20030, точная firmware 2.0.2.2 и свежее
определённое состояние. Команда печати требует `controlJobKey`, полученный из
карточки. Это случайный ключ наблюдаемой печати, а не `task_id: "-1"`:
меняется при смене файла/id, сбросе elapsed, переходе через idle и reconnect.
После рестарта старый HTTP-запрос тоже не совпадёт с новой сессией. Полностью
пропущенные одинаковые печати протокол не позволяет отличать по уникальному id.

Команды `pause`, `resume`, `stop` отправляются один раз. MQTT-публикация не
считается выполнением: требуется соответствующий `info`. Отмена требует также
`stoped`, сопоставленного с текущей печатью; один idle или исторический
`last_project` недостаточен. Неясный исход блокирует повтор в той же наблюдаемой
печати; автоматических повторов нет. Позднее фактическое подтверждение снимает
блокировку и разрешает следующее явное действие без повторной отправки предыдущего.
Пуши по-прежнему не создают переходов
жизненного цикла: их подтверждает только `info`. Исправлен приоритет исхода:
сопоставленное завершение текущей печати сильнее устаревшего `last_project`.

HTTP upload подготовлен за **двумя закрытыми ограничениями**: общая capability
и отдельное разрешение сессии, которое production registry не выдаёт. Использует
multipart-поля `filename`/`gcode`, приватный `/gcode_upload?s=…`, проверяет имя и
размер повторным чтением, отказывается перезаписывать существующий файл.
Подготовлены `.gcode` и `.gcode.3mf`; аппаратная совместимость загрузки обоих
форматов ещё не доказана. Ошибки HTTP скрывают токен, повтора загрузки нет.

Транспорт старта подготовлен под общий `sendPrinterStart` и его durable guard.
Требует размер/MD5 доставленного артефакта, существующий файл того же имени и
размера, явно закреплённую внешнюю катушку и повторную проверку idle. Generic ACK
не подтверждает старт: требуется реальная печать ожидаемого файла. Неясный старт
удерживается без повтора. Запуск `.gcode.3mf` намеренно не реализован: совпадение
имени контейнера и внутреннего G-code не подтверждено. ACE mapping тоже закрыт.

`supportsJobs`, `supportsUpload`, `supportsRemoteStart`, `supportsFileDelete`
остаются **false**. `supportsFileListing=true`, verification — только
`name_and_size`, никогда SHA-256/remote hash. Прямая попытка печати файла теперь
отклоняется до создания task/assignment/DeviceArtifact для monitoring-адаптера.
Новая очередь или параллельный dispatch не создавались. Перед будущим разрешением
jobs ещё требуется связать размер/MD5 и `local/` пути с подготовленным артефактом
в штатном dispatch, проверить совместимость/ACE и провести аппаратную приёмку
доставки, идентичности и перехода в печать. Транспортная заготовка не объявляется
завершённой интеграцией очереди.

## Проверки

- Чистый полный backend-прогон принятой реализации `e19e81a`: **2290/2290**, без
  пропусков и ошибок (Anycubic, Bambu/Moonraker, PrintRun, BedCycle, dispatch,
  материалы, API и остальные модули).
- Dashboard: 352/352.
- Typecheck (`tsc --noEmit`) и production build (`tsconfig.build.json`) прошли.
- `nginx -t` прошёл в одноразовом контейнере на том же локальном image, со
  штатным envsubst и фиктивным тестовым API token; без сети/production volumes.
- Изолированная TLS-интеграция проверяет pin mismatch, reconnect и отсутствие
  отправки credentials при несовпадении сертификата.
- Дополнительные тесты проверяют retained/ACK, таймауты и очистку waiters,
  неясные команды без повторов, одинаковые имена с task_id=-1, устаревший
  last_project, постпроверку размера upload и закрытые write/start gates.
- Реальный адаптер: память, встроенный каталог, пустой USB, light/peripherie.
- Реальная камера: FLV/H.264 → существующий backend proxy → временный go2rtc →
  два MP4-потребителя, один upstream, освобождение после закрытия.
- Отдельно перепроверены позднее подтверждение паузы без повторной отправки
  (9/9), camera/upload (10/10) и затронутые наборы после исправлений (63/63).
  Эти проверки входят в полный финальный прогон; их числа не суммируются.
- Дополнительная проверка финализации выпуска фиксируется отдельно в
  [release-плане](ANYCUBIC_KOBRA_X_RELEASE.md); полный прогон выше не выдаётся
  за повторный запуск на следующем коммите.

## Что требуется для аппаратной приёмки

1. Отдельное разрешение на один цикл света on/off с визуальной проверкой
   назначения лампы и восстановлением исходного состояния. Без production gate.
2. Отдельно согласованная печать для pause/resume/stop. Текущую печать не трогать.
3. Отдельное разрешение на загрузку согласованного файла и позднее на его старт.
   Согласовать источник филамента; ACE/контейнерные файлы требуют своих проверок.
4. Отдельное разрешение на deploy read-only частей и применение настроек камеры.
   Никакие управляющие возможности и автоматическая очередь не должны включаться
   вместе с этим развёртыванием.

## Источники и лицензии

Исследованы протокольные факты, исходный код в Atelier написан самостоятельно.
Сторонний код не переносился:

- [stribor/anycubic_kobrax](https://github.com/stribor/anycubic_kobrax), MIT:
  fileDetails, команды light/video/print.
- [grunna/ha-anycubic-kobra-x-lan](https://github.com/grunna/ha-anycubic-kobra-x-lan),
  MIT: периферия, типы света, формы команд.
- [chrisfore/anycubic_ha_local](https://github.com/chrisfore/anycubic_ha_local),
  MIT: сопоставление состояния печати и stop.
- [marcodiniz/OrcaCubic](https://github.com/marcodiniz/OrcaCubic), AGPL-3.0:
  описание протокола upload/start и различия имён 3MF. Код не копировался.
- [SlimQuiggle/KobraCache](https://github.com/SlimQuiggle/KobraCache): отдельная
  лицензия в metadata не обнаружена; показанный path-only listLocal аппаратно
  отклонён. Код не копировался.
- [KX-Bridge listLocal](https://gitea.it-drui.de/viewit/KX-Bridge-Release/src/branch/nightly/bridge_endpoints.py):
  обязательные page_num/page_size; после исследования проверено на устройстве.
- [Anycubic LAN guide](https://wiki.anycubic.com/it/fdm-3d-printer/anycubic-kobra-x/lan-connection-guide):
  страница доступна, извлекаемого описания MQTT-команд не предоставила.
- [go2rtc 1.9.14 HTTP input](https://github.com/AlexxIT/go2rtc/blob/v1.9.14/internal/http/http.go):
  условие HTTP 200, объясняющее необходимость существующего backend proxy.

## Изменённые и добавленные файлы

- `apps/print-dashboard/actions.js`
- `apps/print-dashboard/nginx.conf`
- `apps/print-dashboard/render/modals.js`
- `apps/print-orchestrator/src/app/FarmCommands.ts`
- `apps/print-orchestrator/src/app/cameraService.ts`
- `apps/print-orchestrator/src/app/commandService.ts`
- `apps/print-orchestrator/src/app/monitoringOnlyCommands.test.ts`
- `apps/print-orchestrator/src/app/printerView.ts`
- `apps/print-orchestrator/src/domain/printers/types.ts`
- `apps/print-orchestrator/src/infra/printers/anycubic/controlPolicy.ts`
- `apps/print-orchestrator/src/infra/printers/anycubic/dispatch.test.ts`
- `apps/print-orchestrator/src/infra/printers/anycubic/features.test.ts`
- `apps/print-orchestrator/src/infra/printers/anycubic/index.ts`
- `apps/print-orchestrator/src/infra/printers/anycubic/reports.test.ts`
- `apps/print-orchestrator/src/infra/printers/anycubic/reports.ts`
- `apps/print-orchestrator/src/infra/printers/anycubic/requests.ts`
- `apps/print-orchestrator/src/infra/printers/anycubic/session.test.ts`
- `apps/print-orchestrator/src/infra/printers/anycubic/session.ts`
- `apps/print-orchestrator/src/infra/printers/anycubic/start.ts`
- `apps/print-orchestrator/src/infra/printers/anycubic/urls.ts`
- `apps/print-orchestrator/src/infra/printers/camera/anycubicStream.test.ts`
- `apps/print-orchestrator/src/infra/printers/camera/stream.ts`
- `apps/print-orchestrator/src/infra/printers/capabilities.test.ts`
- `apps/print-orchestrator/src/infra/printers/capabilities.ts`
- `apps/print-orchestrator/src/infra/printers/files/anycubic.test.ts`
- `apps/print-orchestrator/src/infra/printers/files/anycubic.ts`
- `apps/print-orchestrator/src/infra/printers/files/anycubicUpload.test.ts`
- `apps/print-orchestrator/src/infra/printers/files/anycubicUpload.ts`
- `apps/print-orchestrator/src/infra/printers/files/index.ts`
- `apps/print-orchestrator/src/infra/printers/files/upload.ts`
- `apps/print-orchestrator/src/infra/printers/status/index.ts`
- `apps/print-orchestrator/src/infra/printers/status/types.ts`
- `apps/print-orchestrator/src/modules/printers/routes.ts`
- `docs/ANYCUBIC_KOBRA_X_STAGE2.md`
- `docs/examples/go2rtc-anycubic.yaml`
