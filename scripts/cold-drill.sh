#!/bin/sh
# cold-drill.sh - adapted cold-start drill for fielog (port of skill-8 SOLID).
#
# fielog has no cold tier (wave-1 fact), so the drill keeps ONLY the primary
# log (ledger.log), deletes everything else (sqlite read-model, snapshots,
# quarantine), and proves the node rises from the log alone via replay +
# verify with identical totals.
#
# usage:
#   scripts/cold-drill.sh [--n <events>] [--dir <path>] [--keep-dir]
#
# exit codes:
#   0  DRILL: PASS - totals and verify identical before/after
#   1  usage/environment error or DRILL: FAIL (state mismatch)

set -eu

N=50
DIR=""
KEEP=0

usage() {
  sed -n '2,15p' "$0"
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --n) N="${2:-}"; shift 2 ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --keep-dir) KEEP=1; shift ;;
    -h|--help) usage ;;
    *) echo "[cold-drill] unknown flag: $1" >&2; usage ;;
  esac
done

command -v bun >/dev/null 2>&1 || { echo "[cold-drill] bun not on PATH" >&2; exit 1; }
case "$N" in ''|*[!0-9]*|0) echo "[cold-drill] --n needs a positive integer" >&2; exit 1 ;; esac

TMPD="${TMPDIR:-${TEMP:-${TMP:-/tmp}}}"
[ -d "$TMPD" ] || { echo "[cold-drill] state dir missing: $TMPD" >&2; exit 1; }
[ -n "$DIR" ] || DIR="$(mktemp -d "$TMPD/fielog-cold-drill-XXXXXX")"

log() { printf '[cold-drill %s] %s\n' "$(date -u '+%H:%M:%S')" "$*"; }

SEED="$(mktemp "$TMPD/fielog-cold-seed-XXXXXX.ts")"
cat > "$SEED" <<'EOF'
const dir = process.env.DRILL_DIR!;
const n = Number(process.env.DRILL_N!);
const { createKernel } = await import(process.cwd() + '/src/kernel.ts');
const k = await createKernel({ file: dir + '/ledger.db', deviceId: 'cold-drill' });
let expected = 0;
for (let i = 0; i < n; i++) { expected += 1000 + i; await k.append({ type: 'payment', amount: 1000 + i, actor: 'cold-drill' }); }
const rows = await k.query<{ total: number }>('SELECT SUM(amount) AS total FROM payment WHERE voided = 0');
const v: any = k.verifyLog();
console.log(`BEFORE events=${k.health().events} total=${rows[0].total} expected=${expected} verify=${v.ok ? 'ok' : 'FAIL'}`);
const events = k.health().events;
k.close();
if (events !== n || rows[0].total !== expected || !v.ok) process.exit(3);
EOF
RISE="$(mktemp "$TMPD/fielog-cold-rise-XXXXXX.ts")"
cat > "$RISE" <<'EOF'
const dir = process.env.DRILL_DIR!;
const n = Number(process.env.DRILL_N!);
const { createKernel } = await import(process.cwd() + '/src/kernel.ts');
const k = await createKernel({ file: dir + '/ledger.db', deviceId: 'cold-drill' });
const rows = await k.query<{ total: number }>('SELECT SUM(amount) AS total FROM payment WHERE voided = 0');
const v: any = k.verifyLog();
let expected = 0;
for (let i = 0; i < n; i++) expected += 1000 + i;
console.log(`AFTER events=${k.health().events} total=${rows[0].total} expected=${expected} verify=${v.ok ? 'ok' : 'FAIL'} gaps=${JSON.stringify(v.gaps ?? [])}`);
const events = k.health().events;
k.close();
if (events !== n || rows[0].total !== expected || !v.ok) process.exit(3);
EOF

export DRILL_DIR="$DIR" DRILL_N="$N"
log "seed dir=$DIR n=$N"
DRILL_DIR="$DIR" DRILL_N="$N" bun "$SEED"
rm -f "$SEED"

LOG="$DIR/ledger.log"
LINES="$(grep -c . "$LOG")"
BYTES="$(wc -c < "$LOG" | tr -d ' ')"
log "log lines=$LINES bytes=$BYTES (want lines=$N)"
[ "$LINES" = "$N" ] || { echo "[cold-drill] DRILL: FAIL (log holds $LINES lines, want $N)" >&2; exit 1; }
log "before delete: $(ls -A "$DIR" | tr '\n' ' ')"

# Adaptation: delete everything EXCEPT the primary log.
for f in "$DIR"/*; do
  [ -e "$f" ] || continue
  [ "$f" = "$LOG" ] || rm -rf "$f"
done
log "after delete: $(ls -A "$DIR" | tr '\n' ' ')"
[ "$(ls -A "$DIR")" = "ledger.log" ] || { echo "[cold-drill] DRILL: FAIL (delete left: $(ls -A "$DIR" | tr '\n' ' '))" >&2; exit 1; }

DRILL_DIR="$DIR" DRILL_N="$N" bun "$RISE"
RC=$?
rm -f "$RISE"

if [ "$RC" = "0" ]; then
  log "DRILL: PASS (n=$N, replay from ledger.log only, totals identical, verify ok)"
else
  echo "[cold-drill] DRILL: FAIL (recover mismatch, rc=$RC)" >&2
  exit 1
fi

if [ "$KEEP" = "0" ]; then rm -rf "$DIR"; else log "kept dir=$DIR"; fi
