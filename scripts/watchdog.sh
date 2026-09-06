#!/bin/sh
# watchdog.sh - poll one orchestration wave, wake the coordinator on
# worker_done (all tasks completed), escalation (any task failed), or
# timeout (deadline passed with tasks still open).
#
# read-only: never dispatches, never updates tasks, never touches runs
# owned by other coordinators. exits non-zero so cron/orchestration
# can tell "wave done" apart from "coordinator must look".
#
# usage:
#   scripts/watchdog.sh --run <run_id> [--tasks id1,id2,...]
#     [--interval <sec>] [--timeout <sec>] [--once] [--from-json <file>]
#
# exit codes:
#   0  wave complete - every watched task reached completed
#   2  timeout - deadline passed, one or more tasks still open (wake up)
#   3  escalation - at least one watched task completed with outcome != succeeded
#   1  usage or environment error (bad flags, orca/bun missing, state unreadable)

set -eu

RUN=""
TASKS=""
INTERVAL=30
TIMEOUT=900
ONCE=0
FROM_JSON=""

usage() {
  sed -n '2,17p' "$0"
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --run) RUN="${2:-}"; shift 2 ;;
    --tasks) TASKS="${2:-}"; shift 2 ;;
    --interval) INTERVAL="${2:-}"; shift 2 ;;
    --timeout) TIMEOUT="${2:-}"; shift 2 ;;
    --once) ONCE=1; shift ;;
    --from-json) FROM_JSON="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "[watchdog] unknown flag: $1" >&2; usage ;;
  esac
done

[ -n "$RUN" ] || [ -n "$FROM_JSON" ] || { echo "[watchdog] need --run <id> or --from-json <file>" >&2; exit 1; }
command -v orca >/dev/null 2>&1 || { echo "[watchdog] orca cli not on PATH" >&2; exit 1; }
command -v bun >/dev/null 2>&1 || { echo "[watchdog] bun not on PATH (needed for json parse)" >&2; exit 1; }

# portable state dir: never hardcode /tmp (windows has no /tmp).
TMPD="${TMPDIR:-${TEMP:-${TMP:-/tmp}}}"
[ -d "$TMPD" ] || { echo "[watchdog] state dir missing: $TMPD" >&2; exit 1; }

log() { printf '[watchdog %s] %s\n' "$(date -u '+%H:%M:%S')" "$*"; }

# fetch raw task-list json to stdout. from-json mode exists for dry-runs
# and tests: feed a canned `task-list --json` capture instead of polling live.
fetch_state() {
  if [ -n "$FROM_JSON" ]; then
    cat "$FROM_JSON"
  else
    orca orchestration task-list --run "$RUN" --json
  fi
}

# summarize watched tasks as: total completed failed open "id(status)..."
# reads task-list json on stdin, wanted ids (csv, empty = all) via $WANT.
summarize() {
  WANT="$TASKS" bun -e '
const want = (process.env.WANT || "").split(",").map(s => s.trim()).filter(Boolean);
let s = "";
process.stdin.on("data", d => s += d).on("end", () => {
  const j = JSON.parse(s.slice(s.indexOf("{")));
  const ts = j.result.tasks.filter(t => !want.length || want.includes(t.id));
  let done = 0, failed = [];
  const open = [];
  for (const t of ts) {
    if (t.status === "completed") {
      done++;
      let outcome = "succeeded";
      try { outcome = JSON.parse(t.result || "{}").outcome || "succeeded"; } catch {}
      if (outcome !== "succeeded") failed.push(t.id + "(" + outcome + ")");
    } else {
      open.push(t.id + "(" + t.status + ")");
    }
  }
  console.log([ts.length, done, failed.join(" "), open.join(" ")].join("|"));
});'
}

START=$(date +%s)
ROUND=0
while true; do
  ROUND=$((ROUND + 1))
  STATE="$(fetch_state)"
  SUM="$(printf '%s' "$STATE" | summarize)"
  TOTAL="$(printf '%s' "$SUM" | cut -d'|' -f1)"
  DONE="$(printf '%s' "$SUM" | cut -d'|' -f2)"
  FAILED="$(printf '%s' "$SUM" | cut -d'|' -f3)"
  OPEN="$(printf '%s' "$SUM" | cut -d'|' -f4)"
  NOW=$(date +%s)
  ELAPSED=$((NOW - START))

  if [ -n "$FAILED" ]; then
    log "round=$ROUND watched=$TOTAL done=$DONE open=[$OPEN]"
    log "WAKE-COORDINATOR reason=escalation failed=[$FAILED] run=${RUN:-from-json}"
    exit 3
  fi
  if [ "$TOTAL" -gt 0 ] && [ "$DONE" -eq "$TOTAL" ]; then
    log "round=$ROUND watched=$TOTAL done=$DONE elapsed=${ELAPSED}s"
    log "WAKE-COORDINATOR reason=worker_done run=${RUN:-from-json} all=$DONE/$TOTAL"
    exit 0
  fi
  if [ "$ELAPSED" -ge "$TIMEOUT" ] || [ "$ONCE" -eq 1 ]; then
    if [ "$ONCE" -eq 1 ] && [ "$ELAPSED" -lt "$TIMEOUT" ]; then
      log "round=$ROUND watched=$TOTAL done=$DONE open=[$OPEN] (single poll)"
      log "STILL-OPEN run=${RUN:-from-json} open=[$OPEN]"
      exit 2
    fi
    log "round=$ROUND watched=$TOTAL done=$DONE open=[$OPEN] elapsed=${ELAPSED}s timeout=${TIMEOUT}s"
    log "WAKE-COORDINATOR reason=timeout run=${RUN:-from-json} open=[$OPEN]"
    exit 2
  fi
  log "round=$ROUND watched=$TOTAL done=$DONE open=[$OPEN] elapsed=${ELAPSED}s - sleeping ${INTERVAL}s"
  sleep "$INTERVAL"
done
