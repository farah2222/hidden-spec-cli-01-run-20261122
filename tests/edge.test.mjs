// Edge-case tests for mend, beyond the kit's practice set. Run with:
//   node tests/edge.test.mjs
// Each case builds a fresh directory, runs `node main.ts` on it, and asserts
// the exit code, stdout and the files left behind. No network, no framework.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'main.ts');
let passed = 0;
let failed = 0;
const failures = [];

function runCase(name, setup, argv, stdin, want) {
  const dir = mkdtempSync(join(tmpdir(), 'mend-edge-'));
  try {
    for (const [p, content] of Object.entries(setup)) {
      const full = join(dir, p);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    const r = spawnSync(process.execPath, [MAIN, ...argv], {
      cwd: dir,
      input: stdin ?? '',
      encoding: 'utf8',
      timeout: 15000,
    });
    const problems = [];
    if (r.status !== want.exit) problems.push(`exit ${r.status}, expected ${want.exit}`);
    if (r.stdout !== want.stdout) problems.push(`stdout ${JSON.stringify(r.stdout)}, expected ${JSON.stringify(want.stdout)}`);
    for (const [p, content] of Object.entries(want.files ?? {})) {
      const full = join(dir, p);
      if (content === null) {
        if (existsSync(full)) problems.push(`${p} should not exist`);
      } else if (!existsSync(full)) {
        problems.push(`${p} should exist`);
      } else if (readFileSync(full, 'utf8') !== content) {
        problems.push(`${p} is ${JSON.stringify(readFileSync(full, 'utf8'))}, expected ${JSON.stringify(content)}`);
      }
    }
    if (problems.length === 0) {
      passed++;
    } else {
      failed++;
      failures.push(`${name}: ${problems.join('; ')}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- unified ---
runCase('unified: basic change + multi-hunk offset', { 'a.txt': 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n' }, ['-'], '--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n@@ -6,3 +6,4 @@\n six\n seven\n+SEVEN2\n eight\n', { exit: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'one\nTWO\nthree\nfour\nfive\nsix\nseven\nSEVEN2\neight\n' } });

runCase('unified: create + delete in one patch', { 'old.txt': 'gone\n' }, ['-'], 'diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\ndiff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-gone\n', { exit: 0, stdout: 'A new.txt\nD old.txt\nok: 2 files\n', files: { 'old.txt': null, 'new.txt': 'hello\nworld\n' } });

runCase('unified: pure rename, no content change', { 'a.txt': 'same\n' }, ['-'], 'diff --git a/a.txt b/b.txt\nsimilarity index 100%\nrename from a.txt\nrename to b.txt\n', { exit: 0, stdout: 'R a.txt -> b.txt\nok: 1 file\n', files: { 'a.txt': null, 'b.txt': 'same\n' } });

runCase('unified: no-newline marker suppresses the final break', { 'a.txt': 'one\ntwo\nthree\n' }, ['-'], '--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n two\n-three\n+THREE\n\\ No newline at end of file\n', { exit: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'one\ntwo\nTHREE' } });

runCase('unified: --check lists but writes nothing', { 'a.txt': 'one\ntwo\n' }, ['--check', '-'], '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n', { exit: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'one\ntwo\n' } });

runCase('unified: --strict refuses trailing-whitespace drift', { 'a.txt': 'one\ntwo\n' }, ['--strict', '-'], '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one \n-two\n+TWO\n', { exit: 1, stdout: 'error: no-match a.txt\nfailed: 1 of 1 edits\n', files: { 'a.txt': 'one\ntwo\n' } });

runCase('unified: a failed edit rolls the whole patch back', { 'a.txt': 'one\ntwo\n', 'b.txt': 'x\ny\n' }, ['-'], '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n--- a/b.txt\n+++ b/b.txt\n@@ -1,2 +1,2 @@\n x\n-nope\n+NOPE\n', { exit: 1, stdout: 'error: no-match b.txt\nfailed: 1 of 2 edits\n', files: { 'a.txt': 'one\ntwo\n', 'b.txt': 'x\ny\n' } });

// --- search-replace ---
runCase('search-replace: empty old block creates, second block reuses the path', {}, ['-'], 'a.txt\n<<<<<<< SEARCH\n=======\ncreated\n>>>>>>> REPLACE\n<<<<<<< SEARCH\ncreated\n=======\nkept\n>>>>>>> REPLACE\n', { exit: 0, stdout: 'A a.txt\nok: 1 file\n', files: { 'a.txt': 'kept\n' } });

runCase('search-replace: ambiguous old block fails', { 'a.txt': 'dup\ndup\n' }, ['-'], 'a.txt\n<<<<<<< SEARCH\ndup\n=======\none\n>>>>>>> REPLACE\n', { exit: 1, stdout: 'error: ambiguous a.txt\nfailed: 1 of 1 edits\n', files: { 'a.txt': 'dup\ndup\n' } });

runCase('search-replace: missing file', {}, ['-'], 'nope.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n', { exit: 1, stdout: 'error: missing nope.txt\nfailed: 1 of 1 edits\n', files: {} });

// --- V4A ---
runCase('v4a: add + update + delete, one patch', { 'u.txt': 'alpha\nbeta\n', 'd.txt': 'bye\n' }, ['-'], '*** Begin Patch\n*** Add File: n.txt\n+fresh\n*** Update File: u.txt\n alpha\n-beta\n+BETA\n*** Delete File: d.txt\n*** End Patch\n', { exit: 0, stdout: 'D d.txt\nA n.txt\nM u.txt\nok: 3 files\n', files: { 'n.txt': 'fresh\n', 'u.txt': 'alpha\nBETA\n', 'd.txt': null } });

runCase('v4a: move to a new path', { 'a.txt': 'one\ntwo\n' }, ['-'], '*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n one\n-two\n+TWO\n*** End Patch\n', { exit: 0, stdout: 'R a.txt -> b.txt\nok: 1 file\n', files: { 'a.txt': null, 'b.txt': 'one\nTWO\n' } });

runCase('v4a: anchored chunk finds the second copy', { 'a.txt': 'mark\nx\nmark\ny\n' }, ['-'], '*** Begin Patch\n*** Update File: a.txt\n@@ mark\n y\n+z\n*** End Patch\n', { exit: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'mark\nx\nmark\ny\nz\n' } });

runCase('v4a: EOF chunk must end at the last line', { 'a.txt': 'one\ntwo\nthree\n' }, ['-'], '*** Begin Patch\n*** Update File: a.txt\n-three\n+THREE\n*** End of File\n*** End Patch\n', { exit: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'one\ntwo\nTHREE\n' } });

runCase('v4a: missing End Patch is a parse error past the last line', { 'a.txt': 'one\n' }, ['-'], '*** Begin Patch\n*** Update File: a.txt\n one\n', { exit: 2, stdout: 'error: parse 4\n', files: { 'a.txt': 'one\n' } });

// --- JSON ---
runCase('json: array form with two edits', { 'a.txt': 'one\ntwo\n' }, ['-'], '[{"command":"str_replace","path":"a.txt","old_str":"two","new_str":"TWO"},{"command":"insert","path":"a.txt","insert_line":2,"new_str":"three"}]', { exit: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'one\nTWO\nthree\n' } });

runCase('json: insert past the end fails', { 'a.txt': 'one\n' }, ['-'], '{"command":"insert","path":"a.txt","insert_line":5,"new_str":"x"}', { exit: 1, stdout: 'error: no-match a.txt\nfailed: 1 of 1 edits\n', files: { 'a.txt': 'one\n' } });

runCase('json: bad line is a parse error at that line', { 'a.txt': 'one\n' }, ['-'], '{"command":"str_replace","path":"a.txt","old_str":"one","new_str":"ONE"}\nnot json\n', { exit: 2, stdout: 'error: parse 2\n', files: { 'a.txt': 'one\n' } });

// --- command line ---
runCase('cli: empty patch is a format error', {}, [], '', { exit: 2, stdout: 'error: format\n', files: {} });
runCase('cli: missing patch file', {}, ['nope.diff'], null, { exit: 2, stdout: 'error: no-patch\n', files: {} });
runCase('cli: unknown option', {}, ['--bogus', '-'], '', { exit: 2, stdout: 'error: usage\n', files: {} });
runCase('cli: two patch files', {}, ['a.diff', 'b.diff'], '', { exit: 2, stdout: 'error: usage\n', files: {} });
runCase('cli: --format=auto detects', { 'a.txt': 'one\ntwo\n' }, ['--format=auto', '-'], '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n', { exit: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'one\nTWO\n' } });
runCase('cli: unsafe absolute path is refused', {}, ['-'], '[{"command":"create","path":"/etc/x.js","file_text":"x"}]', { exit: 1, stdout: 'error: unsafe /etc/x.js\nfailed: 1 of 1 edits\n', files: {} });
runCase('cli: a no-op change is not listed', { 'a.txt': 'one\ntwo\n' }, ['-'], 'a.txt\n<<<<<<< SEARCH\ntwo\n=======\ntwo\n>>>>>>> REPLACE\n', { exit: 0, stdout: 'ok: 0 files\n', files: { 'a.txt': 'one\ntwo\n' } });

console.log(`${passed} passed, ${failed} failed`);
for (const f of failures) console.log(`FAIL: ${f}`);
process.exitCode = failed === 0 ? 0 : 1;
