# Print Dashboard

Главная панель Albedo Atelier — управление печатной фермой (front-end, без сборки).

- `index.html` — разметка всех блоков панели (статус, очередь, ночная печать, принтеры, материалы, автоматизации, камеры, обслуживание, система, события, план).
- `styles.css` — визуальная система «Albedo»: светлая фарфорово-жемчужная палитра с обсидианом, старинным золотом, топазом и аметистом (см. таблицу палитры в корневом README), анимации, адаптивная сетка.
- Front-end на нативных ES-модулях (без сборки), точка входа — `app.js` (`<script type="module">`):
  - `app.js` — состояние + оркестрация: загрузка `GET /api/print-orchestrator/api/dashboard`, дедупликация рендера, опрос каждые 6 с, повторные попытки при недоступности backend.
  - `api.js` — REST-клиент. `util.js` — DOM/формат/тосты. `nav.js` — навигация, scroll-spy, липкие смещения, появление секций.
  - `render/` — отрисовка секций доски (`printers.js`, `sections.js`, `board.js`).
  - `actions.js` — действия оператора (пауза/продолжить/отмена/снимок/подсветка по ночному окну, очередь, ночная печать, автоматизации) через POST + делегированные клики.
  - `cameraPlayers.js` — реестр живых WebRTC-плееров камер; `camera-webrtc.js`/`video-rtc.js` — go2rtc-компонент `<camera-stream>`.

The nginx container serves the page on port `8080` and proxies:

- `/api/print-orchestrator/*` to `http://print-orchestrator:3100/*`

So the dashboard calls the API at `/api/print-orchestrator/api/...` (same origin).
