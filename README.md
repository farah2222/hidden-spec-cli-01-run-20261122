# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/farah2222/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/farah2222/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Entry for the [hidden-spec-cli-01-run-20261122 bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122): build `mend`, one command-line tool that applies the edits AI models write, in four formats, to a tree of files.

## Usage

```sh
node main.ts [options] [PATCH]
```

`PATCH` is a file, `-`, or omitted to read standard input. Options:

- `--format=<name>` — `auto` (the default: detect), `unified`, `search-replace`, `v4a`, `json`
- `--strict` — exact matching only (no whitespace-drift tiers)
- `--check` — report what would change, write nothing

Exit codes: `0` applied, `1` an edit failed (nothing was written), `2` usage, parse or format error.

## The four formats

- **Unified diffs** — `diff --git` or bare `---`/`+++` sections, hunks, `new file mode`, `deleted file mode`, renames (`rename from`/`to`, reported as one `R old -> new` line), `\ No newline at end of file`. A hunk applies at the occurrence nearest to its stated line number, so drifted line numbers still land.
- **SEARCH/REPLACE blocks** — a path line (or the previous block's path), `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`. An empty old block creates the file.
- **V4A patches** — `*** Begin Patch` … `*** End Patch`, with `Add File`, `Delete File` and `Update File` sections, `@@` anchors, `*** Move to:` and `*** End of File` chunks. A chunk works from a cursor that moves past each anchor and each block it writes.
- **JSON edits** — one object per line, or a JSON array: `create`, `str_replace` (exact, CRLF-aware) and `insert` (by line number).

## Matching

Lines match at three tiers, in order: exact, then trailing whitespace stripped, then leading and trailing whitespace stripped. At the third tier, added lines are re-indented from the old block's first line to the file's first matched line (empty lines are kept as they are). Unified diffs take the nearest occurrence; SEARCH/REPLACE and JSON refuse an ambiguous old block; V4A takes the first occurrence at or after its cursor.

## Safety

- Paths must be relative, with no empty, `.` or `..` segments and no backslash — anything else is `error: unsafe`.
- Edits apply in order to the tree as earlier edits left it. If any edit fails, **no file is written at all** (`failed: k of n edits`, exit 1).
- A file whose bytes are unchanged is not listed. Output rows are `A`/`D`/`M`/`R` sorted by path, then `ok: n file(s)`.
- A changed file keeps its own line break (CRLF files stay CRLF) and its final line break, except a unified `\` marker, which suppresses the final break when the hunk runs to the end of the file.

## Files

- `main.ts` — the whole tool. Node 22+ and its standard library alone.
- `runner.ts` — the kit's trial runner (kept as it is); `main.ts` hands a trial over to it when `MAKEFUN_ENV_URL` is set.
- `SPEC.md` — the full specification.
- `tests/edge.test.mjs` — 25 black-box edge cases (run with `node tests/edge.test.mjs`).
- `LICENSE` — MIT.

## Results

- Kit practice set: **100 of 100 passed, practice score 1000** (`node check.ts ../program/generator/practice.json` with the kit's `check.ts`).
- Edge tests: **25 of 25 passed** (`node tests/edge.test.mjs`).
- Speed: applying one patch to a 2,000-line file takes ~0.25 s per invocation end to end (dominated by Node startup; the patch work itself is a few milliseconds).

## License

MIT — see `LICENSE`.
