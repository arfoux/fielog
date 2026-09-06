#!/usr/bin/env bash
# flake-hunter.sh - rerun one fielog test target N times, report pass-rate,
# classify each failure as env (timing/socket/resource) or product (assertion/invariant).
#
# port of skill-1 (flake-hunter, status MANTAP) to fielog. the skill loop is:
# run the flaky target N times, keep every log, label each failure env vs
# product from the log text, and print a pass-rate summary. ambiguous logs
# default to product so a real bug is never filed as "just flakes".
#
# usage:
#   bash scripts/flake-hunter.sh --target <file> [--test-name <substr>] [--runs N]
#   bash scripts/flake-hunter.sh --from-log <file>
#
# exit codes:
#   0  loop done, no product failure (all pass, or env-only flakes)
#   2  loop/from-log found at least one product failure
#   1  usage or environment error (bad flags, bun missing, target/log unreadable)
set -u
set -o pipefail

TARGET=""
TEST_NAME=""
RUNS=10
FROM_LOG=""

usage() {
  echo "usage: flake-hunter.sh --target <file> [--test-name <substr>] [--runs N]" >&2
  echo "       flake-hunter.sh --from-log <file>" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --test-name) TEST_NAME="${2:-}"; shift 2 ;;
    --runs) RUNS="${2:-}"; shift 2 ;;
    --from-log) FROM_LOG="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[flake-hunter] unknown flag: $1" >&2; usage; exit 1 ;;
  esac
done

command -v bun >/dev/null 2>&1 || { echo "[flake-hunter] bun not on PATH" >&2; exit 1; }

# classify_file <logfile>: prints "product <reason>" or "env <reason>".
# product patterns win: an assertion/invariant line means product even when
# the log also mentions timeouts. bare timeouts / socket / resource errors
# with no assertion line mean env.
classify_file() {
  local log="$1"
  local reason=""
  if ! grep -q "(fail)" "$log" 2>/dev/null && grep -qE "0 fail" "$log" 2>/dev/null; then
    echo "pass no-failure-pattern"
    return 0
  fi
  if grep -qiE "assert|assertion|expect\\(|exact-once|diverges|corrupt|gaps|ack regress|duplicates|lost acked|quarantine|verifylog|unconverged|missing events" "$log" 2>/dev/null; then
    reason="$(grep -oiE ".{0,80}(assert|assertion|exact-once|diverges|corrupt|gaps|ack regress|duplicates|lost acked|quarantine|verifylog|unconverged|missing events).{0,80}" "$log" 2>/dev/null | head -1)"
    reason="$(printf '%s' "$reason" | tr -d '\n' | cut -c1-160)"
    echo "product ${reason:-assertion-pattern}"
    return 0
  fi
  if grep -qiE "timed out|waitfor|eaddrinuse|econnrefused|econnreset|epipe|enotfound|address already in use|no space left|out of memory|cannot allocate|1006|websocket.*(closed|timeout)" "$log" 2>/dev/null; then
    reason="$(grep -oiE ".{0,80}(timed out|waitfor|eaddrinuse|econnrefused|econnreset|epipe|enotfound|address already in use|no space left|out of memory|cannot allocate|1006|websocket.{0,40}(closed|timeout)).{0,80}" "$log" 2>/dev/null | head -1)"
    reason="$(printf '%s' "$reason" | tr -d '\n' | cut -c1-160)"
    echo "env ${reason:-timing-socket-pattern}"
    return 0
  fi
  echo "product unknown-failure-no-pattern"
}

# --from-log: classify one captured log, no loop. mirrors watchdog --from-json.
if [ -n "$FROM_LOG" ]; then
  [ -f "$FROM_LOG" ] || { echo "[flake-hunter] log not found: $FROM_LOG" >&2; exit 1; }
  out="$(classify_file "$FROM_LOG")"
  class="${out%% *}"
  echo "[flake-hunter] class=$out file=$FROM_LOG"
  [ "$class" = "product" ] && exit 2
  exit 0
fi

[ -n "$TARGET" ] || { echo "[flake-hunter] need --target <file> or --from-log <file>" >&2; usage; exit 1; }
[ -f "$TARGET" ] || { echo "[flake-hunter] target not found: $TARGET" >&2; exit 1; }
case "$RUNS" in
  ''|*[!0-9]*|0) echo "[flake-hunter] --runs must be a positive integer" >&2; exit 1 ;;
esac

TMPD="${TMPDIR:-${TEMP:-${TMP:-/tmp}}}"
[ -d "$TMPD" ] || { echo "[flake-hunter] state dir missing: $TMPD" >&2; exit 1; }
STAMP="$(date -u '+%Y%m%d-%H%M%S')"
LOGDIR="$TMPD/flake-hunter-$STAMP"
mkdir -p "$LOGDIR" || { echo "[flake-hunter] cannot create $LOGDIR" >&2; exit 1; }

pass=0
env_n=0
product_n=0
i=0
while [ "$i" -lt "$RUNS" ]; do
  i=$((i + 1))
  log="$LOGDIR/run-$i.log"
  start="$(date +%s)"
  if [ -n "$TEST_NAME" ]; then
    bun test "$TARGET" -t "$TEST_NAME" >"$log" 2>&1
  else
    bun test "$TARGET" >"$log" 2>&1
  fi
  code=$?
  secs=$(( $(date +%s) - start ))
  if [ "$code" -eq 0 ]; then
    pass=$((pass + 1))
    echo "[flake-hunter] run=$i/$RUNS target=$TARGET result=pass time=${secs}s"
  else
    out="$(classify_file "$log")"
    class="${out%% *}"
    if [ "$class" = "env" ]; then
      env_n=$((env_n + 1))
    else
      product_n=$((product_n + 1))
    fi
    echo "[flake-hunter] run=$i/$RUNS target=$TARGET result=fail class=$out time=${secs}s log=$log"
  fi
done

fail=$((RUNS - pass))
rate=$(( (pass * 100) / RUNS ))
echo "[flake-hunter] summary target=$TARGET runs=$RUNS pass=$pass fail=$fail env=$env_n product=$product_n pass_rate=${rate}% logs=$LOGDIR"
[ "$product_n" -gt 0 ] && exit 2
exit 0
