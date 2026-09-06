#!/usr/bin/env bash
# bench-check.sh - honesty gate for fielog benchmarks (port of skill-7).
#
# A bench number is accepted only with three pins attached:
#   1. slice  - exact code version (git HEAD hash).
#   2. korpus - exact workload (bench name + N + fixed workload params).
#   3. mesin  - exact machine + runtime (os, arch, bun version).
# Any pin mismatch => HONESTY: FAIL, exit 2 (mismatch-stop: STOP, do not
# quote the number). The script reports raw pins; the coordinator judges.
#
# usage:
#   bash scripts/bench-check.sh --bench append [--n N] [--run]
#   bash scripts/bench-check.sh --bench append --n 2000 --run \
#     --expect-head d03e683b8e40acf3a484617cdfd42a254a61a358 --expect-bun 1.4.0
#   bash scripts/bench-check.sh --bench append --from-output <file>
#   bash scripts/bench-check.sh --record [--bench NAME] [--n N]
#
# exit codes:
#   0  pins ok (and bench output valid, when --run/--from-output)
#   2  mismatch or invalid bench output (HONESTY: FAIL)
#   1  usage or environment error (bad flags, bun/git missing, file unreadable)
set -u
set -o pipefail

BENCH=""
N=""
RUN=0
FROM_OUTPUT=""
RECORD=0
EXPECT_HEAD=""
EXPECT_BUN=""

usage() {
  echo "usage: scripts/bench-check.sh --bench append|query|sync [--n N] [--run] [--from-output FILE] [--record] [--expect-head HASH] [--expect-bun VER]" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --bench) [ $# -ge 2 ] || { echo "error: --bench needs a value" >&2; usage; exit 1; }; BENCH="$2"; shift 2 ;;
    --n) [ $# -ge 2 ] || { echo "error: --n needs a value" >&2; usage; exit 1; }; N="$2"; shift 2 ;;
    --run) RUN=1; shift ;;
    --from-output) [ $# -ge 2 ] || { echo "error: --from-output needs a value" >&2; usage; exit 1; }; FROM_OUTPUT="$2"; shift 2 ;;
    --record) RECORD=1; shift ;;
    --expect-head) [ $# -ge 2 ] || { echo "error: --expect-head needs a value" >&2; usage; exit 1; }; EXPECT_HEAD="$2"; shift 2 ;;
    --expect-bun) [ $# -ge 2 ] || { echo "error: --expect-bun needs a value" >&2; usage; exit 1; }; EXPECT_BUN="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown flag '$1'" >&2; usage; exit 1 ;;
  esac
done

[ -n "$BENCH" ] || { echo "error: need --bench append|query|sync" >&2; usage; exit 1; }
case "$BENCH" in
  append|query|sync) ;;
  *) echo "error: --bench must be append|query|sync, got '$BENCH'" >&2; exit 1 ;;
esac

case "$N" in
  "") case "$BENCH" in append) N=5000 ;; query) N=100000 ;; sync) N=10000 ;; esac ;;
  *[!0-9]*|0) echo "error: --n must be a positive integer, got '$N'" >&2; exit 1 ;;
esac

command -v git >/dev/null 2>&1 || { echo "[bench-check] git not on PATH" >&2; exit 1; }
command -v bun >/dev/null 2>&1 || { echo "[bench-check] bun not on PATH" >&2; exit 1; }

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

BENCH_FILE="bench/bench-$BENCH.ts"
[ -f "$BENCH_FILE" ] || { echo "[bench-check] bench file missing: $BENCH_FILE" >&2; exit 1; }

HEAD="$(git rev-parse HEAD 2>/dev/null)" || { echo "[bench-check] cannot read git HEAD" >&2; exit 1; }
BUN_VER="$(bun --version 2>/dev/null)" || BUN_VER="?"
OS="$(uname -s 2>/dev/null || echo unknown)"
ARCH="$(uname -m 2>/dev/null || echo unknown)"

# korpus pin: fixed workload params per bench (must match bench/*.ts source).
case "$BENCH" in
  append) KORPUS="n=$N nominal=1000+(i%9000) oleh=bench" ;;
  query) KORPUS="n=$N iters=200 warmup=10 maxPending=n+1000 workloads=sum_all,point_by_seq" ;;
  sync) KORPUS="n=$N chunk=500 relay=ws-real fast=1/30ms" ;;
esac

fail() { echo "HONESTY: FAIL bench=$BENCH $1" >&2; exit 2; }

# pin checks against expectations (only when the caller pins them).
if [ -n "$EXPECT_HEAD" ]; then
  case "$HEAD" in
    "$EXPECT_HEAD"*) ;;
    *) fail "slice mismatch head=$HEAD expect=$EXPECT_HEAD" ;;
  esac
fi
if [ -n "$EXPECT_BUN" ]; then
  [ "$BUN_VER" = "$EXPECT_BUN" ] || fail "mesin mismatch bun=$BUN_VER expect=$EXPECT_BUN"
fi

pins() {
  echo "[bench-check] slice head=$HEAD bench_file=$BENCH_FILE"
  echo "[bench-check] korpus $KORPUS"
  echo "[bench-check] mesin os=$OS arch=$ARCH bun=$BUN_VER"
}

# check_output <file>: a captured bench log must carry its RESULT line and
# the bench-side correctness self-check for n=$N.
check_output() {
  [ -f "$1" ] || { echo "[bench-check] output file not found: $1" >&2; exit 1; }
  grep -q '^RESULT ' "$1" || fail "no RESULT line in $1"
  case "$BENCH" in
    append) grep -q "\"bench\":\"append\",\"n\":$N[,}]" "$1" || fail "RESULT n mismatch (want n=$N)" ;;
    query) grep -q "\"bench\":\"query\"" "$1" || fail "RESULT bench=query missing"; grep -q "\"n_events\":$N[,}]" "$1" || fail "RESULT n_events mismatch (want $N)" ;;
    sync) grep -q "\"bench\":\"sync\",\"n\":$N[,}]" "$1" || fail "RESULT n mismatch (want n=$N)"; grep -q "applied=$N" "$1" || fail "sync self-check applied=$N missing" ;;
  esac
}

if [ "$RECORD" = "1" ]; then
  pins
  echo "HONESTY: PASS bench=$BENCH pins_recorded head=$HEAD bun=$BUN_VER korpus=\"$KORPUS\""
  exit 0
fi

if [ -n "$FROM_OUTPUT" ]; then
  pins
  check_output "$FROM_OUTPUT"
  echo "HONESTY: PASS bench=$BENCH head=$HEAD bun=$BUN_VER korpus=\"$KORPUS\" source=$FROM_OUTPUT"
  exit 0
fi

if [ "$RUN" = "1" ]; then
  pins
  TMPD="${TMPDIR:-${TEMP:-${TMP:-/tmp}}}"
  [ -d "$TMPD" ] || { echo "[bench-check] state dir missing: $TMPD" >&2; exit 1; }
  LOG="$TMPD/bench-check-$BENCH-$N.log"
  bun "$BENCH_FILE" "$N" >"$LOG" 2>&1
  STATUS=$?
  cat "$LOG"
  [ "$STATUS" -eq 0 ] || fail "bench exit=$STATUS (log kept: $LOG)"
  check_output "$LOG"
  echo "HONESTY: PASS bench=$BENCH head=$HEAD bun=$BUN_VER korpus=\"$KORPUS\" log=$LOG"
  exit 0
fi

pins
echo "HONESTY: PASS bench=$BENCH pins_ok head=$HEAD bun=$BUN_VER korpus=\"$KORPUS\""
