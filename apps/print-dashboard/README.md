# Print Dashboard

Главная панель Albedo Atelier — управление печатной фермой (front-end, без сборки).

- `index.html` — разметка всех блоков панели (статус, очередь, ночная печать, принтеры, материалы, автоматизации, камеры, обслуживание, система, события, план).
- `styles.css` — визуальная система «Albedo»: светлая меловая палитра с золотом и бирюзой, анимации, адаптивная сетка.
- `app.js` — загрузка данных из backend и рендер. Состояние берётся из `GET /api/print-orchestrator/api/dashboard`, действия (пауза/продолжить/отмена/снимок/подсветка, очередь, ночная печать, автоматизации) отправляются POST-запросами, панель обновляется опросом каждые 6 с. Если backend недоступен — показывается предупреждение и выполняются повторные попытки.

The nginx container serves the page on port `8080` and proxies:

- `/api/print-orchestrator/*` to `http://print-orchestrator:3100/*`

So the dashboard calls the API at `/api/print-orchestrator/api/...` (same origin).
