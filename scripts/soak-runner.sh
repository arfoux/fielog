#!/usr/bin/env bash
# soak-runner.sh -- seeded soak driver for fielog spins.
#
# Runs test/soak-runner.test.ts (random append/seal/sync/restart with an
# invariant check every N steps) under a chosen seed and prints the proof
# line: ops + invariant checks + seed. The killer case (seal collision:
# colliding snapshots sweep only the sealed prefix) always runs.
#
# Usage:
#   bash scripts/soak-runner.sh [--seed N] [--steps N] [--check-every N]
#     [--killer-only] [--filter PATTERN]
#
# Env overrides: SOAK_SEED (default 42), SOAK_STEPS (default 200),
#   SOAK_CHECK_EVERY (default 20).
#
# Exit codes: 0 pass (proof line printed), 1 test failure, 2 usage error.
set -u
set -o pipefail

SEED="${SOAK_SEED:-42}"
STEPS="${SOAK_STEPS:-200}"
CHECK_EVERY="${SOAK_CHECK_EVERY:-20}"
FILTER=""

usage() {
  echo "usage: scripts/soak-runner.sh [--seed N] [--steps N] [--check-every N] [--killer-only] [--filter PATTERN]" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --seed) [ $# -ge 2 ] || { echo "error: --seed needs a value" >&2; usage; exit 2; }; SEED="$2"; shift 2 ;;
    --steps) [ $# -ge 2 ] || { echo "error: --steps needs a value" >&2; usage; exit 2; }; STEPS="$2"; shift 2 ;;
    --check-every) [ $# -ge 2 ] || { echo "error: --check-every needs a value" >&2; usage; exit 2; }; CHECK_EVERY="$2"; shift 2 ;;
    --killer-only) FILTER="seal collision"; shift ;;
    --filter) [ $# -ge 2 ] || { echo "error: --filter needs a value" >&2; usage; exit 2; }; FILTER="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown flag '$1'" >&2; usage; exit 2 ;;
  esac
done

case "$SEED/$STEPS/$CHECK_EVERY" in
  *[!0-9/]*|"") echo "error: seed/steps/check-every must be non-negative integers" >&2; exit 2 ;;
esac

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

echo "soak-runner: seed=$SEED steps=$STEPS check_every=$CHECK_EVERY filter=${FILTER:-all}"

LOG="$(mktemp)"
if [ -n "$FILTER" ]; then
  SOAK_SEED="$SEED" SOAK_STEPS="$STEPS" SOAK_CHECK_EVERY="$CHECK_EVERY" \
    bun test test/soak-runner.test.ts --test-name-pattern "$FILTER" >"$LOG" 2>&1
else
  SOAK_SEED="$SEED" SOAK_STEPS="$STEPS" SOAK_CHECK_EVERY="$CHECK_EVERY" \
    bun test test/soak-runner.test.ts >"$LOG" 2>&1
fi
STATUS=$?

grep -E '\[soak-runner\]' "$LOG" || true
PASS_N="$(grep -oE '[0-9]+ pass' "$LOG" | grep -oE '[0-9]+' | tail -1)"
FAIL_N="$(grep -oE '[0-9]+ fail' "$LOG" | grep -oE '[0-9]+' | tail -1)"
rm -f "$LOG"

if [ "$STATUS" -ne 0 ] || [ "${FAIL_N:-?}" != "0" ]; then
  echo "soak-runner: FAIL pass=${PASS_N:-?} fail=${FAIL_N:-?}" >&2
  exit 1
fi
echo "soak-runner: PASS pass=$PASS_N fail=0 seed=$SEED steps=$STEPS check_every=$CHECK_EVERY"
