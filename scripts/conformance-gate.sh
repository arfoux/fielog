#!/usr/bin/env bash
# conformance-gate.sh — pra-merge gate for fielog spins.
#
# Checks (each prints PASS/FAIL with a reason; any FAIL => GATE: FAIL, exit 1):
#   1. base   — branch forked from the newest main tip (merge-base == main tip).
#   2. tree   — working tree clean (no staged/unstaged/untracked changes).
#   3. tests  — `bun test` reports at least EXPECTED_PASS passes and 0 failures.
#   4. scope  — every file changed in merge-base...HEAD is inside the allowlist.
#
# Usage:
#   bash scripts/conformance-gate.sh [--expected-pass N] [--main-ref REF]
#
# Env overrides: GATE_EXPECTED_PASS (default 66), GATE_MAIN_REF (default main).
set -u
set -o pipefail

EXPECTED_PASS="${GATE_EXPECTED_PASS:-66}"
MAIN_REF="${GATE_MAIN_REF:-main}"
ALLOWLIST="scripts/conformance-gate.sh docs/conformance-gate.md"

while [ $# -gt 0 ]; do
  case "$1" in
    --expected-pass=*) EXPECTED_PASS="${1#*=}" ;;
    --expected-pass) EXPECTED_PASS="${2:?--expected-pass needs a value}"; shift ;;
    --main-ref=*) MAIN_REF="${1#*=}" ;;
    --main-ref) MAIN_REF="${2:?--main-ref needs a value}"; shift ;;
    -h|--help)
      echo "usage: bash scripts/conformance-gate.sh [--expected-pass N] [--main-ref REF]"
      exit 0 ;;
    *) echo "FAIL: args (unknown argument: $1)" >&2; exit 2 ;;
  esac
  shift
done
FAILURES=0
report() { # $1 = PASS|FAIL, $2 = name, $3 = detail
  echo "$1: $2 ($3)"
  if [ "$1" = "FAIL" ]; then FAILURES=$((FAILURES + 1)); fi
}

# 1. base — must equal newest main tip.
if ! MAIN_TIP="$(git rev-parse --verify "$MAIN_REF" 2>/dev/null)"; then
  report FAIL base "ref '$MAIN_REF' not found"
  MAIN_TIP=""
  BASE=""
else
  BASE="$(git merge-base HEAD "$MAIN_TIP")"
  if [ "$BASE" = "$MAIN_TIP" ]; then
    report PASS base "merge-base == $MAIN_REF tip ${MAIN_TIP:0:7}"
  else
    report FAIL base "merge-base ${BASE:0:7} != $MAIN_REF tip ${MAIN_TIP:0:7}; rebase onto $MAIN_REF"
  fi
fi

# 2. tree — must be clean.
if [ -z "$(git status --porcelain)" ]; then
  report PASS tree "working tree clean"
else
  DIRTY="$(git status --porcelain | head -5 | tr '\n' ';')"
  report FAIL tree "dirty: $DIRTY"
fi

# 3. tests — bun test must report at least EXPECTED_PASS passes and 0 fails.
TEST_OUT="$(bun test 2>&1)"
PASS_N="$(printf '%s' "$TEST_OUT" | grep -oE '[0-9]+ pass' | grep -oE '[0-9]+' | tail -1)"
FAIL_N="$(printf '%s' "$TEST_OUT" | grep -oE '[0-9]+ fail' | grep -oE '[0-9]+' | tail -1)"
PASS_N="${PASS_N:-?}"
FAIL_N="${FAIL_N:-?}"
if [ "$FAIL_N" = "0" ] && [ "$PASS_N" != "?" ] && [ "$PASS_N" -ge "$EXPECTED_PASS" ]; then
  report PASS tests "bun test ${PASS_N}/${FAIL_N}, expected ${EXPECTED_PASS}/0"
else
  report FAIL tests "bun test ${PASS_N}/${FAIL_N}, expected ${EXPECTED_PASS}/0"
fi

# 4. scope — changed files must stay inside the spin allowlist.
if [ -z "${BASE:-}" ]; then
  report FAIL scope "no base to diff against"
else
  CHANGED="$(git diff --name-only "${BASE}...HEAD")"
  BAD=""
  for f in $CHANGED; do
    OK=0
    for a in $ALLOWLIST; do
      if [ "$f" = "$a" ]; then OK=1; break; fi
    done
    if [ "$OK" = "0" ]; then BAD="$BAD $f"; fi
  done
  if [ -z "$CHANGED" ]; then
    report PASS scope "no files changed vs base; allowlist: $ALLOWLIST"
  elif [ -z "$BAD" ]; then
    N="$(printf '%s\n' "$CHANGED" | wc -l)"
    report PASS scope "$N file(s) inside allowlist"
  else
    report FAIL scope "out-of-scope:$BAD; allowlist: $ALLOWLIST"
  fi
fi

if [ "$FAILURES" = "0" ]; then
  echo "GATE: PASS"
  exit 0
else
  echo "GATE: FAIL ($FAILURES check(s) failed)"
  exit 1
fi
