#!/usr/bin/env bash
# merge-spin.sh -- ff-only merge of a spin branch into main, green-gated + exact tag.
#
# usage:
#   scripts/merge-spin.sh --spin <branch> --order <k> [--dry-run]
#
# contract:
#   - merges <branch> into main with `git merge --ff-only` (never a merge commit)
#   - REQUIRES `bun test` green on main BEFORE and AFTER the merge
#   - creates exact tag v0.14.N where N = 2 + k
#     (k = merge order, coordinated via coordinator inbox so two runners
#     never claim the same N)
#   - rejects on: dirty tree, non-ff, red pre-test, red post-test, tag clash
#   - --dry-run executes every check up to (not including) the actual merge
#     and exits 0 without mutating any branch, tag, or working tree
set -euo pipefail

SPIN=""
ORDER=""
DRY_RUN=0

usage() {
  echo "usage: scripts/merge-spin.sh --spin <branch> --order <k> [--dry-run]" >&2
  echo "  --spin   spin branch to merge into main" >&2
  echo "  --order  merge order k (non-negative int); tag is v0.14.\$((2+k))" >&2
  echo "  --dry-run  run all pre-merge checks, stop before the actual merge" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --spin) SPIN="${2:-}"; shift 2 ;;
    --order) ORDER="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

[ -n "$SPIN" ] || { echo "error: --spin required" >&2; usage; exit 2; }
[ -n "$ORDER" ] || { echo "error: --order required" >&2; usage; exit 2; }
case "$ORDER" in
  *[!0-9]*|"") echo "error: --order must be a non-negative integer, got '$ORDER'" >&2; exit 2 ;;
esac

N=$((2 + ORDER))
TAG="v0.14.$N"
case "$TAG" in
  v0.14.[0-9]*) ;;
  *) echo "error: generated tag '$TAG' violates exact format v0.14.N" >&2; exit 2 ;;
esac

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

fail() { echo "REJECT: $1" >&2; exit 1; }
info() { echo "$1"; }

info "merge-runner: spin=$SPIN order=$ORDER tag=$TAG dry_run=$DRY_RUN"
info "merge-runner: base=$(git rev-parse --short HEAD) branch=$(git branch --show-current)"

# 1. target branch must be main (real mode). dry-run may execute from a
#    worktree on any branch, but main ref must exist.
if [ "$DRY_RUN" -eq 0 ]; then
  [ "$(git branch --show-current)" = "main" ] \
    || fail "not on main (on '$(git branch --show-current)') -- checkout main first"
else
  git rev-parse --verify --quiet refs/heads/main >/dev/null \
    || fail "local main ref missing -- fetch/checkout main first"
fi

# 2. clean tree (tracked + untracked). stash or clean before merging.
[ -z "$(git status --porcelain)" ] \
  || { echo "dirty tree:" >&2; git status --porcelain >&2; fail "dirty working tree -- commit/stash first"; }

# 3. spin branch must exist.
git rev-parse --verify --quiet "refs/heads/$SPIN" >/dev/null \
  || fail "spin branch '$SPIN' does not exist"

# 4. ff-only possible: main must be an ancestor of spin ...
git merge-base --is-ancestor main "$SPIN" \
  || fail "non-fast-forward -- main is not an ancestor of '$SPIN' (needs rebase, see docs/merge-runner.md)"
# ... and there must be something to merge.
[ "$(git rev-parse main)" != "$(git rev-parse "$SPIN")" ] \
  || fail "nothing to merge -- '$SPIN' already equals main"

# 5. tag must be free (clash = order already taken -> re-coordinate via inbox).
git rev-parse --verify --quiet "refs/tags/$TAG" >/dev/null \
  && fail "tag $TAG already exists -- merge order $ORDER taken, re-coordinate via inbox"
info "merge-runner: tag $TAG free"

# 6. PRE gate: bun test green on main, before merge.
info "merge-runner: PRE bun test on main ..."
PRE_LOG="$(mktemp)"
if ! bun test >"$PRE_LOG" 2>&1; then
  tail -20 "$PRE_LOG" >&2
  rm -f "$PRE_LOG"
  fail "PRE bun test red -- merge blocked"
fi
PRE_SUMMARY="$(grep -E '^[[:space:]]*[0-9]+ (pass|fail)' "$PRE_LOG" | tr '\n' ' ' || true)"
rm -f "$PRE_LOG"
case "$PRE_SUMMARY" in
  *" 0 fail"*|*"0 fail"*) ;;
  *) fail "PRE bun test summary has no '0 fail' (got: '$PRE_SUMMARY')" ;;
esac
info "merge-runner: PRE green ($PRE_SUMMARY)"

if [ "$DRY_RUN" -eq 1 ]; then
  info "DRY-RUN OK: would run: git merge --ff-only $SPIN && bun test && git tag $TAG"
  info "DRY-RUN OK: no branch, tag, or working tree was mutated"
  exit 0
fi

# 7. actual merge (ff-only; --ff-only makes non-ff a hard error even if the
#    check above raced).
git merge --ff-only "$SPIN" \
  || fail "git merge --ff-only $SPIN failed"

# 8. POST gate: bun test green on merged main.
info "merge-runner: POST bun test on merged main ..."
POST_LOG="$(mktemp)"
if ! bun test >"$POST_LOG" 2>&1; then
  tail -20 "$POST_LOG" >&2
  rm -f "$POST_LOG"
  fail "POST bun test red after merge -- main is merged but UNTAGGED, escalate before tagging"
fi
POST_SUMMARY="$(grep -E '^[[:space:]]*[0-9]+ (pass|fail)' "$POST_LOG" | tr '\n' ' ' || true)"
rm -f "$POST_LOG"
case "$POST_SUMMARY" in
  *" 0 fail"*|*"0 fail"*) ;;
  *) fail "POST bun test summary has no '0 fail' (got: '$POST_SUMMARY')" ;;
esac
info "merge-runner: POST green ($POST_SUMMARY)"

# 9. exact tag, only on green post-merge main.
git tag "$TAG" || fail "git tag $TAG failed"
info "merge-runner: DONE merged $SPIN -> main, tagged $TAG"
