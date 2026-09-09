#!/usr/bin/env bash
# two-device-rig.sh -- device-01/device-02 rig: three convergence scenarios
# over one relay (port of skill-11 multi-device-rig).
#
# Scenarios (test/two-device-rig.test.ts):
#   s1  device-01 sells offline, device-02 pulls to match + re-sync no-op
#   s2  two-way offline divergence then converge to the combined total
#   s3  relay drops mid-batch, resume without duplicates (exact-once by uuid)
#
# Usage:
#   bash scripts/two-device-rig.sh [--n N] [--filter PATTERN]
#
# Env overrides: RIG_N (default 20).
#
# Exit codes: 0 RIG: PASS (proof line printed), 1 RIG: FAIL, 2 usage error.
set -u
set -o pipefail

N="${RIG_N:-20}"
FILTER=""

usage() {
  echo "usage: scripts/two-device-rig.sh [--n N] [--filter PATTERN]" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --n) [ $# -ge 2 ] || { echo "error: --n needs a value" >&2; usage; exit 2; }; N="$2"; shift 2 ;;
    --filter) [ $# -ge 2 ] || { echo "error: --filter needs a value" >&2; usage; exit 2; }; FILTER="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown flag '$1'" >&2; usage; exit 2 ;;
  esac
done

case "$N" in ''|*[!0-9]*|0) echo "error: --n needs a positive integer" >&2; exit 2 ;; esac

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

echo "two-device-rig: n=$N filter=${FILTER:-all}"

LOG="$(mktemp)"
if [ -n "$FILTER" ]; then
  RIG_N="$N" bun test test/two-device-rig.test.ts --test-name-pattern "$FILTER" >"$LOG" 2>&1
else
  RIG_N="$N" bun test test/two-device-rig.test.ts >"$LOG" 2>&1
fi
STATUS=$?

grep -E '\[two-device-rig\]' "$LOG" || true
PASS_N="$(grep -oE '[0-9]+ pass' "$LOG" | grep -oE '[0-9]+' | tail -1)"
FAIL_N="$(grep -oE '[0-9]+ fail' "$LOG" | grep -oE '[0-9]+' | tail -1)"
rm -f "$LOG"

if [ "$STATUS" -ne 0 ] || [ "${FAIL_N:-?}" != "0" ]; then
  echo "two-device-rig: FAIL pass=${PASS_N:-?} fail=${FAIL_N:-?}" >&2
  exit 1
fi
echo "two-device-rig: PASS pass=$PASS_N fail=0 n=$N"
