// mend — one patch tool for every AI edit format.
//
// Applies a patch to the files under the current directory. Four formats:
// unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits, matched
// at three tiers (exact, trailing whitespace, leading and trailing
// whitespace). Edits apply in order to the tree as earlier edits left it;
// if any edit fails, no file is written at all. Node 22+, standard library
// only; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly renamed = new Map<string, string>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file as lines plus its own line break and whether it ends with one. */
type FileText = { lines: string[]; br: string; final: boolean };

function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/* Three tiers of line matching: exact, trailing whitespace stripped, then
   leading and trailing whitespace stripped. */

type Tier = 0 | 1 | 2;

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

function normFor(tier: Tier): (s: string) => string {
  return tier === 0 ? (s) => s : tier === 1 ? stripTrail : stripBoth;
}

/** Every position where `pat` occurs in `lines` at or after `from`, at one tier. */
function occurrences(lines: string[], pat: string[], from: number, tier: Tier): number[] {
  const norm = normFor(tier);
  const out: number[] = [];
  if (pat.length === 0) return out;
  for (let i = from; i + pat.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (norm(lines[i + j]!) !== norm(pat[j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * The first tier (exact, then trailing, then both) with a match, and the
 * first occurrence at that tier. --strict tries the exact tier only.
 */
function firstMatch(lines: string[], pat: string[], from: number, strict: boolean): { at: number; tier: Tier } | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const hits = occurrences(lines, pat, from, tier);
    if (hits.length > 0) return { at: hits[0]!, tier };
  }
  return null;
}

/**
 * The occurrence nearest to `target` at the first tier with a match (ties go
 * to the earlier one). --strict tries the exact tier only.
 */
function nearestMatch(lines: string[], pat: string[], target: number, strict: boolean): { at: number; tier: Tier } | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const hits = occurrences(lines, pat, 0, tier);
    if (hits.length === 0) continue;
    let best = hits[0]!;
    for (const h of hits) {
      if (Math.abs(h - target) < Math.abs(best - target)) best = h;
    }
    return { at: best, tier };
  }
  return null;
}

/** One line of a hunk or chunk: context (kept), removed, or added. */
type Op = { kind: 'ctx'; text: string } | { kind: 'del'; text: string } | { kind: 'add'; text: string };

function oldOf(ops: Op[]): string[] {
  return ops.filter((o) => o.kind !== 'add').map((o) => o.text);
}

/**
 * Rewrite `lines` by replacing the matched block at `at` (whose old lines are
 * the context and removed lines of `ops`) with the context and added lines.
 * Context lines are written as the file's own matched lines; at the third
 * tier, added lines are re-indented from the old block's first line to the
 * file's first matched line, except empty or whitespace-only ones.
 */
function applyOps(lines: string[], at: number, tier: Tier, ops: Op[]): string[] {
  const oldLines = oldOf(ops);
  const out: string[] = [];
  let oi = 0;
  const p = tier === 2 && oldLines.length > 0 ? leadWs(oldLines[0]!) : '';
  const f = tier === 2 && oldLines.length > 0 ? leadWs(lines[at]!) : '';
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(lines[at + oi]!);
      oi++;
    } else if (op.kind === 'del') {
      oi++;
    } else if (tier === 2 && oldLines.length > 0 && op.text.trim() !== '' && op.text.startsWith(p)) {
      out.push(f + op.text.slice(p.length));
    } else {
      out.push(op.text);
    }
  }
  return [...lines.slice(0, at), ...out, ...lines.slice(at + oldLines.length)];
}

/** Which format a patch is, from its first lines, or null when none fits. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* Unified diffs. */

type Hunk = { a: number; b: number; c: number; d: number; ops: Op[]; noEol: boolean };
type USection = {
  from: string | null;
  to: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
};

/** The path after a --- or +++ marker: up to the first tab, trimmed, a/ or b/ stripped. */
function diffPath(raw: string): string | null {
  const t = raw.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  return t.replace(/^[ab]\//, '');
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Read one hunk starting at lines[i] (a @@ header). Returns the hunk and the
 * index after its body (and any trailing \ line).
 */
function readHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_HEAD.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = Number(m[1]);
  const b = m[2] === undefined ? 1 : Number(m[2]);
  const c = Number(m[3]);
  const d = m[4] === undefined ? 1 : Number(m[4]);
  const ops: Op[] = [];
  let oldCount = 0;
  let newCount = 0;
  let lastKind: 'ctx' | 'del' | 'add' | null = null;
  let noEol = false;
  let j = i + 1;
  while (oldCount < b || newCount < d) {
    if (j >= lines.length) throw new Exit2(`error: parse ${lines.length}`);
    const l = lines[j]!;
    if (l === '') {
      ops.push({ kind: 'ctx', text: '' });
      oldCount++;
      newCount++;
      lastKind = 'ctx';
    } else if (l[0] === ' ') {
      ops.push({ kind: 'ctx', text: l.slice(1) });
      oldCount++;
      newCount++;
      lastKind = 'ctx';
    } else if (l[0] === '-') {
      ops.push({ kind: 'del', text: l.slice(1) });
      oldCount++;
      lastKind = 'del';
    } else if (l[0] === '+') {
      ops.push({ kind: 'add', text: l.slice(1) });
      newCount++;
      lastKind = 'add';
    } else if (l[0] === '\\') {
      // A \ line mid-body marks no final break only after a context or added
      // line at the end of the body; here it is ignored.
    } else {
      throw new Exit2(`error: parse ${j + 1}`);
    }
    j++;
  }
  if (oldCount !== b || newCount !== d) throw new Exit2(`error: parse ${Math.max(i + 1, j)}`);
  // A \ line directly after the last context or + line of the body.
  if (j < lines.length && lines[j]![0] === '\\' && (lastKind === 'ctx' || lastKind === 'add')) {
    noEol = true;
    j++;
  }
  return { hunk: { a, b, c, d, ops, noEol }, next: j };
}

/**
 * Read one section starting at lines[start] (a diff --git line, or a ---
 * line followed by a +++ line). Returns the section and the index after it.
 */
function readUSection(lines: string[], start: number, hasDiffGit: boolean): { sec: USection; next: number } {
  const sec: USection = { from: null, to: null, renameFrom: null, renameTo: null, create: false, del: false, hunks: [] };
  let i = start;
  if (hasDiffGit) {
    const rest = lines[i]!.slice('diff --git '.length).trim();
    const parts = rest.split(/\s+/);
    if (parts.length >= 2) {
      sec.from = parts[0]!.replace(/^a\//, '');
      sec.to = parts[1]!.replace(/^b\//, '');
    }
    i++;
  }
  let havePaths = false;
  let inHunks = false;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('@@ ')) {
      const r = readHunk(lines, i);
      sec.hunks.push(r.hunk);
      inHunks = true;
      i = r.next;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (!havePaths && !inHunks && (lines[i + 1] ?? '').startsWith('+++ ')) {
        sec.from = diffPath(l.slice(4));
        sec.to = diffPath(lines[i + 1]!.slice(4));
        havePaths = true;
        i += 2;
        continue;
      }
      if ((lines[i + 1] ?? '').startsWith('+++ ')) break;
      if (!havePaths && !inHunks) throw new Exit2(`error: parse ${i + 1}`);
      break;
    }
    if (l.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 1}`);
    if (inHunks) break;
    if (l.startsWith('new file mode')) sec.create = true;
    else if (l.startsWith('deleted file mode')) sec.del = true;
    else if (l.startsWith('rename from ')) sec.renameFrom = l.slice('rename from '.length).trim();
    else if (l.startsWith('rename to ')) sec.renameTo = l.slice('rename to '.length).trim();
    i++;
  }
  return { sec, next: i };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const r = readUSection(lines, i, true);
      edits.push(unifiedEdit(r.sec, strict));
      i = r.next;
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const r = readUSection(lines, i, false);
      edits.push(unifiedEdit(r.sec, strict));
      i = r.next;
    } else {
      i++;
    }
  }
  return edits;
}

/** Apply a section's hunks in order to a file's text. */
function applyUHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const o = oldOf(h.ops);
    const newLines = h.ops.filter((op) => op.kind !== 'del').length;
    if (o.length === 0) {
      // A hunk with no old lines inserts after the first A+d lines, clamped.
      const at = Math.min(Math.max(h.a + d, 0), f.lines.length);
      const atEnd = at === f.lines.length;
      const added = h.ops.filter((op) => op.kind === 'add').map((op) => op.text);
      f.lines = [...f.lines.slice(0, at), ...added, ...f.lines.slice(at)];
      if (atEnd) f.final = !h.noEol;
    } else {
      const target = h.a - 1 + d;
      const m = nearestMatch(f.lines, o, target, strict);
      if (m === null) throw new Fail('no-match', path);
      const touchesEnd = m.at + o.length === f.lines.length;
      f.lines = applyOps(f.lines, m.at, m.tier, h.ops);
      if (touchesEnd) f.final = !h.noEol;
    }
    d += newLines - o.length;
  }
  return joinFile(f);
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    if (sec.renameFrom !== null && sec.renameTo !== null) {
      const from = sec.renameFrom;
      const to = sec.renameTo;
      if (!safe(from)) throw new Fail('unsafe', from);
      if (!safe(to)) throw new Fail('unsafe', to);
      const cur = tree.get(from);
      if (cur === null) throw new Fail('missing', from);
      if (from === to) {
        tree.now.set(from, applyUHunks(cur, sec.hunks, strict, from));
        return;
      }
      if (tree.get(to) !== null) throw new Fail('exists', to);
      const content = applyUHunks(cur, sec.hunks, strict, from);
      tree.now.set(from, null);
      tree.now.set(to, content);
      tree.renamed.set(from, to);
      return;
    }
    if (sec.create) {
      const to = sec.to ?? sec.from;
      if (to === null) throw new Fail('missing', '');
      if (!safe(to)) throw new Fail('unsafe', to);
      if (tree.get(to) !== null) throw new Fail('exists', to);
      const lines: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        for (const op of h.ops) {
          if (op.kind === 'add') lines.push(op.text);
        }
        if (h.noEol) noEol = true;
      }
      tree.now.set(to, lines.length === 0 ? '' : lines.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (sec.del) {
      const from = sec.from ?? sec.to;
      if (from === null) throw new Fail('missing', '');
      if (!safe(from)) throw new Fail('unsafe', from);
      if (tree.get(from) === null) throw new Fail('missing', from);
      tree.now.set(from, null);
      return;
    }
    const p = sec.to ?? sec.from;
    if (p === null) throw new Fail('missing', '');
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    tree.now.set(p, applyUHunks(cur, sec.hunks, strict, p));
  };
}

/* SEARCH/REPLACE blocks. */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    // The path is the nearest non-blank, non-fence line before the SEARCH
    // line, looking back only as far as the previous block ended.
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trimStart().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchLine + 1}`);
    }
    let sep = -1;
    let end = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (sep < 0 && l.trimEnd() === '=======') {
        sep = j;
        continue;
      }
      if (sep >= 0 && l.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (sep < 0 || end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      // An empty old block creates the file.
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = splitFile(cur);
    const tiers: Tier[] = strict ? [0] : [0, 1, 2];
    let found: { at: number; tier: Tier } | null = null;
    let count = 0;
    for (const tier of tiers) {
      const hs = occurrences(f.lines, oldLines, 0, tier);
      if (hs.length > 0) {
        found = { at: hs[0]!, tier };
        count = hs.length;
        break;
      }
    }
    if (found === null) throw new Fail('no-match', path);
    if (count > 1) throw new Fail('ambiguous', path);
    const ops: Op[] = [
      ...oldLines.map((t) => ({ kind: 'del' as const, text: t })),
      ...newLines.map((t) => ({ kind: 'add' as const, text: t })),
    ];
    f.lines = applyOps(f.lines, found.at, found.tier, ops);
    tree.now.set(path, joinFile(f));
  };
}

/* V4A patches. */

type VChunk = { anchor: string | null; ops: Op[]; eof: boolean };

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File:')) {
      const path = l.slice('*** Add File:'.length).trim();
      const body: string[] = [];
      const bodyStart = i + 1;
      i++;
      while (i < last && !lines[i]!.startsWith('*** ')) {
        body.push(lines[i]!);
        i++;
      }
      const fileLines: string[] = [];
      for (let k = 0; k < body.length; k++) {
        const bl = body[k]!;
        if (bl.startsWith('+')) fileLines.push(bl.slice(1));
        else if (bl === '') fileLines.push('');
        else throw new Exit2(`error: parse ${bodyStart + k + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }
    if (l.startsWith('*** Delete File:')) {
      const path = l.slice('*** Delete File:'.length).trim();
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      i++;
      continue;
    }
    if (l.startsWith('*** Update File:')) {
      const updateLine = i;
      const path = l.slice('*** Update File:'.length).trim();
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to:')) {
        moveTo = lines[i]!.slice('*** Move to:'.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const finishChunk = () => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const cl = lines[i]!;
        if (cl.startsWith('*** End of File')) {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          finishChunk();
          i++;
          continue;
        }
        if (cl.startsWith('*** ')) break;
        if (cl.startsWith('@@')) {
          finishChunk();
          const anchor = cl.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, ops: [], eof: false };
          i++;
          continue;
        }
        if (cur === null) cur = { anchor: null, ops: [], eof: false };
        if (cl === '') cur.ops.push({ kind: 'ctx', text: '' });
        else if (cl[0] === ' ') cur.ops.push({ kind: 'ctx', text: cl.slice(1) });
        else if (cl[0] === '-') cur.ops.push({ kind: 'del', text: cl.slice(1) });
        else if (cl[0] === '+') cur.ops.push({ kind: 'add', text: cl.slice(1) });
        else throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      finishChunk();
      // Trailing blank lines at the end of a section are not part of it.
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        while (lastChunk.ops.length > 0) {
          const op = lastChunk.ops[lastChunk.ops.length - 1]!;
          if ((op.kind === 'ctx' || op.kind === 'add') && op.text === '') lastChunk.ops.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && moveTo !== path && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(cur);
    let cursor = 0;
    for (const chunk of chunks) {
      const o = oldOf(chunk.ops);
      if (chunk.anchor !== null) {
        const a = firstMatch(f.lines, [chunk.anchor], cursor, strict);
        if (a === null) throw new Fail('no-match', path);
        cursor = a.at + 1;
      }
      if (o.length === 0) {
        // An empty old block inserts at the cursor, or at the end of the file.
        const at = chunk.eof ? f.lines.length : cursor;
        const added = chunk.ops.filter((op) => op.kind === 'add').map((op) => op.text);
        f.lines = [...f.lines.slice(0, at), ...added, ...f.lines.slice(at)];
        cursor = at + added.length;
        continue;
      }
      let found: { at: number; tier: Tier } | null = null;
      const tiers: Tier[] = strict ? [0] : [0, 1, 2];
      for (const tier of tiers) {
        const hs = occurrences(f.lines, o, cursor, tier);
        if (chunk.eof) {
          const eofHits = hs.filter((h) => h + o.length === f.lines.length);
          if (eofHits.length > 0) {
            found = { at: eofHits[0]!, tier };
            break;
          }
        } else if (hs.length > 0) {
          found = { at: hs[0]!, tier };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', path);
      f.lines = applyOps(f.lines, found.at, found.tier, chunk.ops);
      cursor = found.at + chunk.ops.filter((op) => op.kind !== 'del').length;
    }
    const content = joinFile(f);
    if (moveTo !== null && moveTo !== path) {
      tree.now.set(path, null);
      tree.now.set(moveTo, content);
      tree.renamed.set(path, moveTo);
    } else {
      tree.now.set(path, content);
    }
  };
}

/* JSON edits. */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* The run: parse the command line, read the patch, run the edits, and write
   the tree out only when every edit succeeded. */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeRenamed = new Map(tree.renamed);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.renamed.clear();
      for (const [k, v] of beforeRenamed) tree.renamed.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Rows, sorted by path (a rename sorts by its old path). Each row carries
  // the write it needs, so --check can list without touching the disk.
  const rows: { key: string; text: string; write: () => void }[] = [];
  const renameTargets = new Set(tree.renamed.values());
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (tree.renamed.has(p)) {
      const to = tree.renamed.get(p)!;
      rows.push({
        key: p,
        text: `R ${p} -> ${to}`,
        write: () => {
          rmSync(p, { force: true });
          mkdirSync(dirname(to), { recursive: true });
          writeFileSync(to, tree.now.get(to)!);
        },
      });
      continue;
    }
    if (renameTargets.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({
      key: p,
      text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`,
      write: () => {
        if (now === null) rmSync(p, { force: true });
        else {
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, now);
        }
      },
    });
  }
  if (!check) for (const r of rows) r.write();
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
