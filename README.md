# Atelier

Workspace for Atelier services.

## Albedo Atelier

Start the local stack:

```bash
docker compose down
docker compose up -d --build
```

Endpoints:

- `GET http://localhost:3100/health`
- `GET http://localhost:3100/ready`
- `GET http://localhost:3100/api/dashboard` — full dashboard state in one payload
- `GET http://localhost:3100/api/printers`

See `apps/print-orchestrator/README.md` for the full API (per-section reads and printer/queue/automation actions).

Dashboard:

- `http://localhost:8090`

Both services bind published ports to `0.0.0.0` so they can be reached from local network devices when the host firewall allows it.
# Albedo-Atelier



Палитра которую нужно
| Название               |       HEX |           RGB |
| ---------------------- | --------: | ------------: |
| Жемчужный блик         | `#FAF7FB` | 250, 247, 251 |
| Фарфоровая кожа        | `#F3EEF2` | 243, 238, 242 |
| Холодная тень кожи     | `#D9CDD4` | 217, 205, 212 |
| Обсидиановый волос     | `#16141D` |    22, 20, 29 |
| Индиговый отлив        | `#3E3A57` |    62, 58, 87 |
| Полуночное крыло       | `#1F2430` |    31, 36, 48 |
| Слоновая кость рогов   | `#E5DED0` | 229, 222, 208 |
| Топазовый ирис         | `#D6C652` |  214, 198, 82 |
| Соборный белый         | `#F8F5FA` | 248, 245, 250 |
| Кружевной серо-голубой | `#BFC6D6` | 191, 198, 214 |
| Старинное золото       | `#C49A3A` |  196, 154, 58 |
| Аметистовая слива      | `#6D4C78` |  109, 76, 120 |
