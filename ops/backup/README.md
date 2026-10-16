# ops/backup — backup and restore

`queue.db` holds the queue, every run, and the **printer inventory including
device credentials**; `artifacts/` holds the blobs those rows point at; `.env`
holds the only copy of the Bambu LAN access code outside the database. Losing the
`orchestrator-data` volume without a backup means re-provisioning the farm by hand.

This directory provides the backups. It is scheduled with **systemd user timers**
(the host has no passwordless sudo); `loginctl enable-linger` is what makes them
run at boot and with nobody logged in.

```bash
cp ops/backup/backup.conf.example ops/backup/backup.conf   # once; host paths + retention, no secrets
./ops/backup/install-timers.sh          # install + enable both timers
systemctl --user list-timers 'atelier-backup*'
journalctl --user -u atelier-backup.service -n 50
```

| Unit | Cadence | Contents |
|---|---|---|
| `atelier-backup.timer` | hourly | `queue.db` + `state.json` |
| `atelier-backup-full.timer` | daily 04:10 | the above + `artifacts/`, `snapshots/`, `.env`, the `printers.json` seed and `go2rtc.yaml` |

The first full set of each ISO week is also kept in the `weekly` tier.

Manual runs:

```bash
./ops/backup/backup.sh --full
./ops/backup/verify.sh            # newest full set; --all for every set, or a set directory
./ops/backup/restore.sh --to-dir /tmp/atelier-restore-test    # rehearsal, never production
```

`scripts/deploy.sh` additionally takes its own `VACUUM INTO` snapshot of
`queue.db` before every swap (`.deploy/db-snapshots/`, last 10). That is the
"undo" of one deploy, **not** a replacement for these sets: it holds neither
`state.json` (automation rules, counters, owed deductions) nor the artifacts.

## How it stays consistent

`queue.db` is snapshotted with `VACUUM INTO` on a **read-only** handle — correct
on a live WAL database, where `cp queue.db` is not. `artifacts/` is copied
**after** that snapshot, never before: uploads commit the blob to
content-addressed storage before inserting the row that references it
(`src/app/artifacts/ingest.ts`: `storage.commit` precedes `artifacts.insert`) and
committed blobs are immutable, so a later copy is a superset of what the snapshot
needs. The reverse order could reference a blob copied too early to exist. Every
blob the snapshot references is then **verified present**, so the guarantee is
checked rather than asserted. This is not an atomic volume snapshot and is not
claimed to be one.

## Restore

**Restore is verified before it is trusted:** `restore.sh` refuses to restore a
set that does not pass `verify.sh`, and writes to a scratch directory unless you
explicitly pass `--to-production --i-mean-it` (which additionally refuses to run
while the orchestrator is up):

```bash
docker compose stop print-orchestrator
./ops/backup/restore.sh --set <set-dir> --to-production --i-mean-it
```

Everything written after the set was taken is lost. Migrations are forward-only:
a set taken **before** a migration is the way back to an image that predates it —
see [Rollback](../../docs/operations.md#rollback-limitations).

**Retention** is per tier (48 hourly / 14 daily / 8 weekly by default, in
`ops/backup/backup.conf`). Pruning only ever deletes inside the backup tree, and
every path passes a guard that rejects system paths, the Docker data root and the
git checkout.

**Security.** The backup root is `0700`, the `.env` copy is forced to `0600`, the
`printers.json` copy keeps the mode of its source (`cp -p` — keep the source at
`600`), and secrets never reach stdout, the journal or the manifest.

## Where the backups live

`ops/backup/config.sh` prefers a dedicated disk, located by filesystem **UUID**
(`BACKUP_DISK_UUID`) rather than by mountpoint — an absent mount otherwise
leaves an empty directory on the root disk that looks perfectly writable. When
that disk is not mounted it falls back to `~/atelier-backups` and every run
prints a **DEGRADED** warning, because a same-disk backup protects against volume
loss, operator error and filesystem corruption — but **not** against losing the
disk, host death, theft, fire or a root compromise. A second disk in the same
chassis is still not an off-host backup.

> **Current state (2026-10-16):** the host has a single physical disk, so the sets
> live in the `~/atelier-backups` fallback and every run reports DEGRADED. There is
> no copy on another medium yet. Attaching one needs no code change: mount it and
> set `BACKUP_DISK_UUID` in `ops/backup/backup.conf`.
