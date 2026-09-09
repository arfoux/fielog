// corrupt-gen: deterministic log corruptor for detector tests.
// port of skill-9 (corruption-generator, status HEALTHY) to fielog: three
// single-fault modes over the jsonl log at <db>.log. mid-file faults map to
// quarantine+gaps in src/log.ts openLog; tail faults map to repairedtail.
import { readFileSync, writeFileSync } from 'node:fs';

export interface BitflipInfo {
  path: string;
  line: number; // 1-based line number flipped
  before: string; // char before flip (always '"')
  after: string; // char after flip (always '#')
}

export interface TornTailInfo {
  path: string;
  line: number; // 1-based line number torn
  kept: number; // bytes of the last line kept
  dropped: number; // bytes cut off
}

export interface TruncateInfo {
  path: string;
  dropped: number; // complete tail lines removed
  kept: number; // content lines remaining
}

function contentLines(raw: string): { parts: string[]; lastIdx: number } {
  const parts = raw.split('\n');
  let lastIdx = parts.length - 1;
  while (lastIdx >= 0 && !parts[lastIdx].trim()) lastIdx--;
  if (lastIdx < 0) throw new Error('corrupt-gen: log is empty');
  return { parts, lastIdx };
}

// flip one bit in a mid-file line so json parse fails on reopen.
// targets index 1 ('"' -> '#'), never the last line (tail has its own mode).
export function bitflip(path: string, lineNo: number): BitflipInfo {
  const raw = readFileSync(path, 'utf8');
  const { parts, lastIdx } = contentLines(raw);
  const lastLine = lastIdx + 1;
  if (!Number.isInteger(lineNo) || lineNo < 1 || lineNo > lastLine) {
    throw new Error(`corrupt-gen bitflip: line ${lineNo} out of range 1..${lastLine}`);
  }
  if (lineNo === lastLine) {
    throw new Error('corrupt-gen bitflip: last line is torn-tail territory, use tornTail');
  }
  const line = parts[lineNo - 1];
  if (line.length < 2 || line[1] !== '"') {
    throw new Error('corrupt-gen bitflip: expected json object line starting {"');
  }
  const before = line[1];
  const after = String.fromCharCode(before.charCodeAt(0) ^ 1); // '"' (0x22) -> '#' (0x23)
  parts[lineNo - 1] = line.slice(0, 1) + after + line.slice(2);
  writeFileSync(path, parts.join('\n'));
  return { path, line: lineNo, before, after };
}

// cut the last content line in half with no trailing newline: a kill
// mid-append. openLog truncates it, sets repairedtail, keeps a forensic copy.
export function tornTail(path: string): TornTailInfo {
  const raw = readFileSync(path, 'utf8');
  const { parts, lastIdx } = contentLines(raw);
  const line = parts[lastIdx];
  const kept = Math.max(1, Math.floor(Buffer.byteLength(line, 'utf8') / 2));
  const buf = Buffer.from(line, 'utf8').subarray(0, kept).toString('utf8');
  parts[lastIdx] = buf;
  writeFileSync(path, parts.slice(0, lastIdx + 1).join('\n')); // no trailing newline
  return { path, line: lastIdx + 1, kept, dropped: Buffer.byteLength(line, 'utf8') - kept };
}

// drop the last n complete lines at a newline boundary: a lost suffix.
// the kept prefix stays hash-valid, so verify passes with fewer events.
export function truncateTail(path: string, dropLast: number): TruncateInfo {
  if (!Number.isInteger(dropLast) || dropLast < 1) {
    throw new Error(`corrupt-gen truncateTail: dropLast must be >= 1, got ${dropLast}`);
  }
  const raw = readFileSync(path, 'utf8');
  const { parts, lastIdx } = contentLines(raw);
  const total = lastIdx + 1;
  if (dropLast >= total) {
    throw new Error(`corrupt-gen truncateTail: dropLast ${dropLast} >= ${total} lines`);
  }
  const keptParts = parts.slice(0, total - dropLast);
  writeFileSync(path, keptParts.join('\n') + '\n');
  return { path, dropped: dropLast, kept: total - dropLast };
}
