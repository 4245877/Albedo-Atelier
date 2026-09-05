#!/usr/bin/env bash
#
# scripts/deploy.sh, driven end to end against a fake Docker CLI.
#
# The script under test is the real file, copied unmodified into a throwaway
# checkout; only `docker` and `curl` are replaced (scripts/tests/fake-docker,
# fake-curl). So these tests exercise the actual change detection, the actual
# restart-safety gate, the actual per-service `up` invocation and the actual
# exit codes — not a re-implementation of them.
#
# The regression they exist for: a print in flight used to cancel the WHOLE
# deploy ("DEPLOY DEFERRED — nothing was swapped"), including the dashboard,
# which cannot disturb a print at all. And it cancelled it for every print,
# including the ones the orchestrator can re-adopt from SQLite after a restart.
#
#   ./scripts/tests/deploy.test.sh            # all cases
#   ./scripts/tests/deploy.test.sh <pattern>  # only the matching ones
set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REAL_REPO="$(cd -- "${HERE}/../.." && pwd -P)"
FILTER="${1:-}"

PASS=0; FAIL=0; FAILED_CASES=()
C_G=$'\033[32m'; C_R=$'\033[31m'; C_D=$'\033[2m'; C_0=$'\033[0m'
[ -t 1 ] || { C_G=""; C_R=""; C_D=""; C_0=""; }

OLD_ID="sha256:1111111111111111111111111111111111111111111111111111111111111111"
OLD_DASH_ID="sha256:2222222222222222222222222222222222222222222222222222222222222222"
NEW_ORCH_ID="sha256:3333333333333333333333333333333333333333333333333333333333333333"
NEW_DASH_ID="sha256:4444444444444444444444444444444444444444444444444444444444444444"
GO2RTC_ID="sha256:5555555555555555555555555555555555555555555555555555555555555555"

# ── scenario construction ───────────────────────────────────────────────────

# A throwaway checkout plus a fake-docker state directory describing a stack
# that is up, healthy and idle. Cases then mutate the few facts they care about.
setup() {
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/deploy-test.XXXXXX")"
  REPO="$TMP/repo"; S="$TMP/state"; BIN="$TMP/bin"
  mkdir -p "$REPO/scripts" "$REPO/apps/print-orchestrator" "$REPO/ops" "$BIN" \
           "$S"/{images,layers,revs,running,state,build,imagename,http,health.after-up,config-changed} \
           "$S/root"
  cp "$REAL_REPO/scripts/deploy.sh" "$REPO/scripts/deploy.sh"
  chmod +x "$REPO/scripts/deploy.sh"
  : >"$REPO/compose.yml"
  : >"$REPO/.env"
  : >"$REPO/apps/print-orchestrator/Dockerfile"
  printf '#!/bin/sh\nexit 0\n' >"$REPO/ops/ensure-print-farm-network.sh"
  chmod +x "$REPO/ops/ensure-print-farm-network.sh"

  ln -s "$HERE/fake-docker" "$BIN/docker"
  ln -s "$HERE/fake-curl" "$BIN/curl"

  printf 'go2rtc\nprint-orchestrator\nprint-dashboard\n' >"$S/services"
  printf 'print-orchestrator\nprint-dashboard\n' >"$S/buildable"
  printf 'atelier-print-orchestrator' >"$S/imagename/print-orchestrator"
  printf 'atelier-print-dashboard' >"$S/imagename/print-dashboard"
  printf '0.0.0.0:8090\n' >"$S/port"
  cat >"$S/config.json" <<'JSON'
{
  "name": "atelier",
  "services": {
    "go2rtc": { "image": "alexxit/go2rtc:1.9.14" },
    "print-orchestrator": { "build": { "target": "production" }, "image": "atelier-print-orchestrator" },
    "print-dashboard": { "build": {}, "image": "atelier-print-dashboard",
                         "environment": { "ORCHESTRATOR_API_TOKEN": "t0ken" } }
  }
}
JSON
  cat >"$S/config.txt" <<'TXT'
services:
  print-orchestrator:
    build:
      target: production
    published: 8090
TXT

  # What is running right now: the previous images, all healthy.
  image "$OLD_ID"      layers-orch-old rev-old
  image "$OLD_DASH_ID" layers-dash-old rev-old
  image "$GO2RTC_ID"   layers-go2rtc   rev-none
  tag atelier-print-orchestrator:latest "$OLD_ID"
  tag atelier-print-dashboard:latest    "$OLD_DASH_ID"
  running print-orchestrator "$OLD_ID"
  running print-dashboard    "$OLD_DASH_ID"
  running go2rtc             "$GO2RTC_ID"
  for svc in go2rtc print-orchestrator print-dashboard; do
    printf 'running healthy 0' >"$S/state/$svc"
  done
  # The farm is idle unless a case says otherwise.
  safety_idle
  printf '0' >"$S/printers.active"
  printf '0' >"$S/runs.active"
  # The dashboard's three probes answer correctly.
  http "" 200 ""
  http "api_print-orchestrator_health" 200 '{"status":"ok"}'
  http "api_print-orchestrator_ready"  200 '{"ready":true,"status":"ok"}'
}

teardown() { [ -n "${TMP:-}" ] && rm -rf "$TMP"; }

image()   { printf '%s' "$2" >"$S/layers/$1"; printf '%s' "$3" >"$S/revs/$1"; }
tag()     { printf '%s' "$2" >"$S/images/$(printf '%s' "$1" | tr '/:' '__')"; }
running() { printf '%s' "$2" >"$S/running/$1"; }
builds()  { printf '%s' "$2" >"$S/build/$1"; }
http()    { printf '%s\n%s' "$2" "$3" >"$S/http/${1:-_}"; }

# The /restart-safety report the fake orchestrator answers with.
safety_idle() { printf 'SAFE=1\nACTIVE=0\nRECOVERABLE=0\nATRISK=0\nWINDOW=180' >"$S/restart-safety.out"; }
safety_recoverable() {
  printf 'SAFE=1\nACTIVE=1\nRECOVERABLE=1\nATRISK=0\nWINDOW=180\nPRINTER=A1|recoverable|-|vase.gcode.3mf|92m' \
    >"$S/restart-safety.out"
}
# $1 = the risk to report (default: an external print with no canonical run).
safety_at_risk() {
  printf 'SAFE=0\nACTIVE=1\nRECOVERABLE=0\nATRISK=1\nWINDOW=180\nPRINTER=A1|at-risk|%s|vase.gcode.3mf|%s' \
    "${1:-untracked-print}" "${2:-92m}" >"$S/restart-safety.out"
}
safety_absent()     { : >"$S/restart-safety.out"; }
# What the farm answers from the SECOND read on — i.e. at the swap, after a
# build that took long enough for the farm to change underneath it.
safety_later()      { printf '%s' "$1" >"$S/restart-safety.out.later"; }
safety_unsupported() { printf 'UNSUPPORTED' >"$S/restart-safety.out"; }

# Run the real deploy.sh against the scenario. Budgets are pinned small so the
# suite is fast and does not depend on the host's free disk.
run_deploy() {
  RC=0
  OUT="$(cd "$REPO" && env \
    PATH="$BIN:$PATH" \
    FAKE_DOCKER_STATE="$S" \
    FAKE_DOCKER_ROOT="$S/root" \
    NO_COLOR=1 \
    DEPLOY_MIN_FREE_MB=1 \
    DEPLOY_MIN_FREE_INODES=1 \
    DEPLOY_DISK_FLOOR_MB=1 \
    DEPLOY_HTTP_TIMEOUT=4 \
    "$REPO/scripts/deploy.sh" --no-disk-watchdog --no-cleanup "$@" 2>&1)" || RC=$?
}

# ── assertions ──────────────────────────────────────────────────────────────
fail_case() { FAILED_CASES+=("$CASE: $1"); printf '  %s✗%s %s\n' "$C_R" "$C_0" "$1"; CASE_OK=0; }
assert_rc()        { [ "$RC" = "$1" ] || fail_case "expected exit $1, got $RC"; }
assert_out()       { grep -qF -- "$1" <<<"$OUT" || fail_case "expected output to contain: $1"; }
assert_not_out()   { grep -qF -- "$1" <<<"$OUT" && fail_case "expected output NOT to contain: $1"; }
assert_running()   { local got; got="$(cat "$S/running/$1")"; [ "$got" = "$2" ] || fail_case "$1 runs ${got:0:19}, expected ${2:0:19}"; }
assert_up_log()    { grep -qF -- "$1" "$S/up.log" 2>/dev/null || fail_case "expected an 'up' with: $1 (got: $(cat "$S/up.log" 2>/dev/null || echo none))"; }
assert_no_up()     { [ ! -s "$S/up.log" ] || fail_case "expected no 'up' at all, got: $(cat "$S/up.log")"; }
assert_tag()       { local got; got="$(cat "$S/images/$(printf '%s' "$1" | tr '/:' '__')" 2>/dev/null || true)"; [ "$got" = "$2" ] || fail_case "$1 -> ${got:0:19}, expected ${2:0:19}"; }
assert_no_tag()    { [ ! -f "$S/images/$(printf '%s' "$1" | tr '/:' '__')" ] || fail_case "expected tag $1 to be absent"; }

case_() {
  CASE="$1"
  if [ -n "$FILTER" ] && ! grep -qi -- "$FILTER" <<<"$CASE"; then return 1; fi
  CASE_OK=1
  printf '%s· %s%s\n' "$C_D" "$CASE" "$C_0"
  setup
  return 0
}
done_() {
  if [ "$CASE_OK" = 1 ]; then PASS=$((PASS + 1)); printf '  %s✓%s\n' "$C_G" "$C_0"
  else FAIL=$((FAIL + 1)); printf '%s\n' "${OUT:-}" | sed 's/^/      | /' | tail -30; fi
  teardown
}

# ── 1. no active print → an ordinary, complete deploy ───────────────────────
if case_ "1 · idle farm: both services change and both are applied"; then
  image "$NEW_ORCH_ID" layers-orch-new rev-new
  image "$NEW_DASH_ID" layers-dash-new rev-new
  builds print-orchestrator "$NEW_ORCH_ID"
  builds print-dashboard    "$NEW_DASH_ID"
  run_deploy
  assert_rc 0
  assert_out "DEPLOY SUCCESS"
  assert_out "APPLIED   : 2 of 2 changed service(s) applied and verified"
  assert_running print-orchestrator "$NEW_ORCH_ID"
  assert_running print-dashboard    "$NEW_DASH_ID"
  # Nothing held back means the plain `up -d` form, so compose applies its own
  # dependency ordering exactly as it always has.
  assert_not_out "--no-deps"
  done_
fi

# ── 2. active print, only the dashboard changed ─────────────────────────────
if case_ "2 · print in flight, dashboard-only change ships anyway"; then
  safety_at_risk
  image "$NEW_DASH_ID" layers-dash-new rev-new
  builds print-dashboard "$NEW_DASH_ID"
  builds print-orchestrator "$OLD_ID"
  run_deploy
  assert_rc 0
  assert_out "DEPLOY SUCCESS"
  assert_running print-dashboard "$NEW_DASH_ID"
  assert_running print-orchestrator "$OLD_ID"
  # The gate must not even be consulted: nothing but the orchestrator can
  # disturb a print, so a busy farm is irrelevant here.
  assert_out "the orchestrator will not be recreated — no active-print gate needed"
  done_
fi

# ── 3. active at-risk print, only the orchestrator changed ──────────────────
if case_ "3 · at-risk print, orchestrator-only change is deferred whole"; then
  safety_at_risk
  image "$NEW_ORCH_ID" layers-orch-new rev-new
  builds print-orchestrator "$NEW_ORCH_ID"
  builds print-dashboard    "$OLD_DASH_ID"
  run_deploy
  assert_rc 4
  assert_out "DEPLOY DEFERRED"
  assert_no_up
  assert_running print-orchestrator "$OLD_ID"
  # :latest must never name an image that is not meant to be running.
  assert_tag atelier-print-orchestrator:latest "$OLD_ID"
  assert_tag atelier-print-orchestrator:pending "$NEW_ORCH_ID"
  done_
fi

# ── 4. active at-risk print, BOTH changed → the regression ──────────────────
if case_ "4 · at-risk print, both change: dashboard applied, orchestrator held"; then
  safety_at_risk
  image "$NEW_ORCH_ID" layers-orch-new rev-new
  image "$NEW_DASH_ID" layers-dash-new rev-new
  builds print-orchestrator "$NEW_ORCH_ID"
  builds print-dashboard    "$NEW_DASH_ID"
  run_deploy
  assert_rc 5
  assert_out "DEPLOY PARTIAL"
  assert_out "APPLIED   : 1 of 2 changed service(s) applied and verified"
  assert_out "HELD BACK : print-orchestrator"
  assert_running print-dashboard    "$NEW_DASH_ID"
  assert_running print-orchestrator "$OLD_ID"
  # --no-deps is what stops compose dragging the held-back orchestrator into the
  # operation through print-dashboard's `depends_on: service_healthy`.
  assert_up_log "--no-deps"
  assert_up_log "print-dashboard"
  grep -q 'print-orchestrator' "$S/up.log" && fail_case "the held-back orchestrator was named in 'up'"
  assert_tag atelier-print-orchestrator:latest "$OLD_ID"
  assert_tag atelier-print-orchestrator:pending "$NEW_ORCH_ID"
  done_
fi

# ── 5. a safely recoverable canonical run ───────────────────────────────────
if case_ "5 · recoverable canonical run: the orchestrator IS restarted"; then
  safety_recoverable
  image "$NEW_ORCH_ID" layers-orch-new rev-new
  builds print-orchestrator "$NEW_ORCH_ID"
  builds print-dashboard    "$OLD_DASH_ID"
  run_deploy
  assert_rc 0
  assert_out "DEPLOY SUCCESS"
  assert_out "all 1 recoverable across a restart"
  assert_running print-orchestrator "$NEW_ORCH_ID"
  # No override was needed for this: the farm proved it was safe.
  assert_not_out "--allow-active-prints"
  done_
fi

# ── 6. an external print with no canonical run ──────────────────────────────
if case_ "6 · external print with no canonical run stays protected"; then
  safety_at_risk untracked-print
  image "$NEW_ORCH_ID" layers-orch-new rev-new
  builds print-orchestrator "$NEW_ORCH_ID"
  builds print-dashboard    "$OLD_DASH_ID"
  run_deploy
  assert_rc 4
  assert_out "DEPLOY DEFERRED"
  assert_out "untracked-print"
  assert_out "no canonical run to re-adopt"
  assert_running print-orchestrator "$OLD_ID"
  done_
fi

# ── 7. what a partial deploy leaves behind ──────────────────────────────────
if case_ "7 · after a partial deploy the held-back service is verified untouched"; then
  safety_at_risk no-ams-baseline
  image "$NEW_ORCH_ID" layers-orch-new rev-new
  image "$NEW_DASH_ID" layers-dash-new rev-new
  builds print-orchestrator "$NEW_ORCH_ID"
  builds print-dashboard    "$NEW_DASH_ID"
  run_deploy
  assert_rc 5
  assert_out "print-orchestrator: HELD BACK — still on"
  assert_out "(untouched, as planned)"
  assert_out "no-ams-baseline"
  # The last-known-good must record what is RUNNING, never the unapplied image.
  assert_tag atelier-print-orchestrator:last-known-good "$OLD_ID"
  assert_tag atelier-print-dashboard:last-known-good "$NEW_DASH_ID"
  done_
fi

# ── 8. the follow-up run after a deferral ───────────────────────────────────
if case_ "8 · re-running after a deferral applies the parked image"; then
  safety_at_risk
  image "$NEW_ORCH_ID" layers-orch-new rev-new
  builds print-orchestrator "$NEW_ORCH_ID"
  builds print-dashboard    "$OLD_DASH_ID"
  run_deploy
  assert_rc 4
  # The print finished; nothing else changed, and the build is fully cached so
  # it produces the same image id again.
  safety_idle
  run_deploy
  assert_rc 0
  assert_out "DEPLOY SUCCESS"
  assert_running print-orchestrator "$NEW_ORCH_ID"
  # The parked tag is dropped once the image it protected is actually running.
  assert_no_tag atelier-print-orchestrator:pending
  done_
fi

# ── 9. a health failure after a PARTIAL swap ────────────────────────────────
if case_ "9 · health failure after a partial swap rolls back only what was applied"; then
  safety_at_risk
  image "$NEW_ORCH_ID" layers-orch-new rev-new
  image "$NEW_DASH_ID" layers-dash-new rev-new
  builds print-orchestrator "$NEW_ORCH_ID"
  builds print-dashboard    "$NEW_DASH_ID"
  # The new dashboard comes up unhealthy.
  printf 'running unhealthy 0' >"$S/health.after-up/print-dashboard"
  run_deploy --rollback-on-failure --health-timeout 4
  assert_rc 1
  assert_out "did not become healthy"
  assert_out "rollback scope: print-dashboard"
  # The orchestrator must not be dragged into the rollback: it was never
  # applied, and re-creating it is the exact thing the gate refused.
  assert_not_out "rollback scope: print-orchestrator"
  assert_running print-orchestrator "$OLD_ID"
  done_
fi

# ── 10. the explicit rollback command ───────────────────────────────────────
if case_ "10 · rollback restores the recorded last-known-good"; then
  image "$NEW_ORCH_ID" layers-orch-new rev-new
  image "$NEW_DASH_ID" layers-dash-new rev-new
  builds print-orchestrator "$NEW_ORCH_ID"
  builds print-dashboard    "$NEW_DASH_ID"
  run_deploy
  assert_rc 0
  assert_running print-orchestrator "$NEW_ORCH_ID"
  # Roll the whole stack back to the images that deploy verified before it.
  run_deploy rollback
  assert_rc 0
  assert_out "ROLLBACK SUCCESS"
  assert_running print-orchestrator "$NEW_ORCH_ID"
  done_
fi

# ── 11. a print that ends during the deploy ─────────────────────────────────
if case_ "11 · a print finishing inside the restart window holds the orchestrator"; then
  # Preflight sees a print that is safely recoverable; by the time the swap is
  # about to happen it is minutes from finishing, which is NOT recoverable —
  # the completion would be observed by neither process.
  safety_recoverable
  image "$NEW_ORCH_ID" layers-orch-new rev-new
  builds print-orchestrator "$NEW_ORCH_ID"
  builds print-dashboard    "$OLD_DASH_ID"
  # The build takes minutes on a real host, which is precisely why the gate is
  # re-taken immediately before the swap rather than trusted from preflight.
  printf 'SAFE=0\nACTIVE=1\nRECOVERABLE=0\nATRISK=1\nWINDOW=180\nPRINTER=A1|at-risk|finishing-soon|vase.gcode.3mf|1m' \
    >"$S/restart-safety.out.later"
  run_deploy
  assert_rc 4
  assert_out "DEPLOY DEFERRED"
  assert_out "finishing-soon"
  assert_running print-orchestrator "$OLD_ID"
  done_
fi

# ── 12. the explicit override ───────────────────────────────────────────────
if case_ "12 · --allow-active-prints swaps despite an at-risk print"; then
  safety_at_risk
  image "$NEW_ORCH_ID" layers-orch-new rev-new
  builds print-orchestrator "$NEW_ORCH_ID"
  builds print-dashboard    "$OLD_DASH_ID"
  run_deploy --allow-active-prints
  assert_rc 0
  assert_out "DEPLOY SUCCESS"
  assert_out "proceeding on --allow-active-prints"
  assert_running print-orchestrator "$NEW_ORCH_ID"
  done_
fi

# ── 13. an orchestrator image that predates the endpoint ────────────────────
if case_ "13 · an image without /restart-safety falls back to the busy count"; then
  safety_unsupported
  printf '1' >"$S/printers.active"
  image "$NEW_ORCH_ID" layers-orch-new rev-new
  builds print-orchestrator "$NEW_ORCH_ID"
  builds print-dashboard    "$OLD_DASH_ID"
  run_deploy
  assert_rc 4
  assert_out "no /restart-safety endpoint"
  assert_out "DEPLOY DEFERRED"
  assert_running print-orchestrator "$OLD_ID"
  done_
fi

# ── 14. --strict-active-prints pins the old, cruder rule ────────────────────
if case_ "14 · --strict-active-prints ignores a recoverable verdict"; then
  safety_recoverable
  printf '1' >"$S/printers.active"
  image "$NEW_ORCH_ID" layers-orch-new rev-new
  builds print-orchestrator "$NEW_ORCH_ID"
  builds print-dashboard    "$OLD_DASH_ID"
  run_deploy --strict-active-prints
  assert_rc 4
  assert_out "DEPLOY DEFERRED"
  assert_running print-orchestrator "$OLD_ID"
  done_
fi

# ── 15. a rebuild that changed nothing must recreate nothing ────────────────
if case_ "15 · a metadata-only rebuild recreates no container"; then
  safety_at_risk
  # Same layers, new image id: an OCI label moving with the commit.
  image "$NEW_ORCH_ID" layers-orch-old rev-new
  builds print-orchestrator "$NEW_ORCH_ID"
  builds print-dashboard    "$OLD_DASH_ID"
  run_deploy
  assert_rc 0
  assert_out "the filesystem is identical (build metadata only)"
  assert_out "DEPLOY SUCCESS"
  assert_running print-orchestrator "$OLD_ID"
  # The tag is pulled back onto the running image so compose sees no change.
  assert_tag atelier-print-orchestrator:latest "$OLD_ID"
  done_
fi

# ── 16. the state is unknowable and the orchestrator is healthy ─────────────
if case_ "16 · an unanswerable farm fails closed"; then
  safety_absent
  rm -f "$S/printers.active" "$S/runs.active"
  image "$NEW_ORCH_ID" layers-orch-new rev-new
  builds print-orchestrator "$NEW_ORCH_ID"
  builds print-dashboard    "$OLD_DASH_ID"
  # The dashboard proxy cannot answer either.
  http "api_print-orchestrator_printers" 503 ""
  run_deploy
  assert_rc 4
  assert_out "could not determine whether any prints are in flight"
  assert_running print-orchestrator "$OLD_ID"
  done_
fi

# ── 17. an unhealthy orchestrator is observing nothing ──────────────────────
if case_ "17 · an unhealthy orchestrator is not protected by the gate"; then
  safety_absent
  rm -f "$S/printers.active" "$S/runs.active"
  printf 'running unhealthy 0' >"$S/state/print-orchestrator"
  printf 'running healthy 0' >"$S/health.after-up/print-orchestrator"
  image "$NEW_ORCH_ID" layers-orch-new rev-new
  builds print-orchestrator "$NEW_ORCH_ID"
  builds print-dashboard    "$OLD_DASH_ID"
  run_deploy
  assert_rc 0
  assert_out "it is tracking nothing, so this gate has nothing left to protect"
  assert_running print-orchestrator "$NEW_ORCH_ID"
  done_
fi

# ── 18. help must survive a closed pipe ─────────────────────────────────────
if case_ "18 · --help piped into head exits 0"; then
  RC=0
  ( cd "$REPO" && PATH="$BIN:$PATH" FAKE_DOCKER_STATE="$S" "$REPO/scripts/deploy.sh" --help | head -3 ) >/dev/null 2>&1 || RC=$?
  assert_rc 0
  OUT=""
  done_
fi

# ── 19. `up` itself fails during a partial swap ─────────────────────────────
if case_ "19 · a failed 'up' during a partial swap still parks the held-back image"; then
  safety_at_risk
  image "$NEW_ORCH_ID" layers-orch-new rev-new
  image "$NEW_DASH_ID" layers-dash-new rev-new
  builds print-orchestrator "$NEW_ORCH_ID"
  builds print-dashboard    "$NEW_DASH_ID"
  printf '1' >"$S/up.fail"
  run_deploy
  assert_rc 1
  # The recovery path is exactly when a stray `docker compose up -d` gets typed,
  # so :latest must already name what is running, not the refused image.
  assert_tag atelier-print-orchestrator:latest "$OLD_ID"
  assert_tag atelier-print-orchestrator:pending "$NEW_ORCH_ID"
  assert_running print-orchestrator "$OLD_ID"
  done_
fi

# ── 20. a second identical run is a true no-op ──────────────────────────────
if case_ "20 · re-running an unchanged tree recreates nothing"; then
  image "$NEW_ORCH_ID" layers-orch-new rev-new
  image "$NEW_DASH_ID" layers-dash-new rev-new
  builds print-orchestrator "$NEW_ORCH_ID"
  builds print-dashboard    "$NEW_DASH_ID"
  run_deploy
  assert_rc 0
  # A print starts, and the tree has not moved: the rebuild is fully cached and
  # produces the same ids, so nothing may be recreated and the gate must not
  # even be reached.
  safety_at_risk
  : >"$S/up.log"
  run_deploy
  assert_rc 0
  assert_out "plan: nothing changed"
  assert_out "no active-print gate needed"
  assert_running print-orchestrator "$NEW_ORCH_ID"
  done_
fi

# ── 21. the container must outlive the process's own shutdown budget ────────
if case_ "21 · the orchestrator's stop grace period exceeds its shutdown cap"; then
  # A cross-file coupling nothing else checks. Docker's default stop grace is 10
  # SECONDS; the orchestrator's graceful shutdown drains in-flight jobs for up to
  # SHUTDOWN_DRAIN_TIMEOUT_MS and only THEN flushes the printing-hours counter and
  # the event feed and closes SQLite. With the default it was SIGKILLed part-way
  # through, on every recreate that followed a busy moment — losing exactly the
  # state a redeploy exists to preserve.
  grace="$(awk '/^  print-orchestrator:/,/^  print-dashboard:/' "$REAL_REPO/compose.yml" \
            | awk -F': *' '/stop_grace_period:/ {gsub(/s$/,"",$2); print $2; exit}')"
  cap_ms="$(grep -A 2 'shutdownTimeoutMs: envVar' \
              "$REAL_REPO/apps/print-orchestrator/src/shared/config/server.ts" \
            | sed -n 's/.*readNonNegativeInt(n, raw, \([0-9_]*\)).*/\1/p' \
            | tr -d '_' | head -1)"
  if [ -z "$grace" ]; then
    fail_case "compose.yml declares no stop_grace_period for print-orchestrator"
  elif [ -z "$cap_ms" ]; then
    fail_case "could not read the shutdownTimeoutMs default from server.ts"
  elif [ "$grace" -le $(( cap_ms / 1000 )) ]; then
    fail_case "stop_grace_period ${grace}s does not exceed the ${cap_ms}ms shutdown cap"
  fi
  OUT=""
  done_
fi

# ── 22. a config-only recreate is gated too ─────────────────────────────────
if case_ "22 · a config-only recreate of the orchestrator still arms the gate"; then
  # No image moved — but compose recreates on its own config hash as well (an
  # .env value, a mount, a stop_grace_period), and that recreate costs a print
  # in flight exactly as much as an image one. Comparing images alone missed it
  # entirely, so editing TZ could restart the orchestrator mid-print ungated.
  safety_at_risk
  builds print-orchestrator "$OLD_ID"
  builds print-dashboard    "$OLD_DASH_ID"
  : >"$S/config-changed/print-orchestrator"
  run_deploy
  assert_rc 4
  assert_out "image unchanged but compose would recreate it"
  assert_out "DEPLOY DEFERRED"
  assert_no_up
  assert_running print-orchestrator "$OLD_ID"
  done_
fi

# ── 23. a config-only recreate of a safe service is not gated ───────────────
if case_ "23 · a config-only recreate of the dashboard is applied during a print"; then
  safety_at_risk
  builds print-orchestrator "$OLD_ID"
  builds print-dashboard    "$OLD_DASH_ID"
  : >"$S/config-changed/print-dashboard"
  run_deploy
  assert_rc 0
  assert_out "DEPLOY SUCCESS"
  assert_out "the orchestrator will not be recreated"
  done_
fi

# ── 24. a compose without --dry-run must not be asked to run one ────────────
if case_ "24 · a compose without --dry-run falls back to the image comparison"; then
  # The failure mode being guarded: a compose that dropped the flag instead of
  # erroring would perform the swap this call only means to ASK about — ungated,
  # before the gate has run. So the flag is feature-detected, and its absence
  # simply leaves the image-based verdict standing.
  : >"$S/no-dry-run"
  safety_at_risk
  builds print-orchestrator "$OLD_ID"
  builds print-dashboard    "$OLD_DASH_ID"
  : >"$S/config-changed/print-orchestrator"
  run_deploy
  assert_rc 0
  assert_out "compose could not describe its plan"
  assert_not_out "image unchanged but compose would recreate it"
  done_
fi

printf '\n%s%s passed%s, %s%s failed%s\n' "$C_G" "$PASS" "$C_0" \
  "$([ "$FAIL" -gt 0 ] && printf '%s' "$C_R")" "$FAIL" "$C_0"
if [ "$FAIL" -gt 0 ]; then
  printf '\nfailures:\n'
  printf '  %s\n' "${FAILED_CASES[@]}"
  exit 1
fi
