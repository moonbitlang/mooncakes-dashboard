# MoonBit Build Dashboard (TypeScript)

Monitor, build, and compare the health of all MoonBit packages published on **mooncakes (MoonBit's package registry)**
plus a curated set of Git repositories. The dashboard tracks buildability across OS (Linux / macOS / Windows), backend
targets (wasm / wasm-gc / js / native), and channels (stable vs nightly) to surface regressions and inconsistencies
quickly.

## ✨ What This Project Does

- Enumerates every MoonBit package from the local mooncakes index (`~/.moon/registry/index/user`).
- Applies per-package overrides from `resources/repos.yml` and exclusion rules from `resources/exclude.yml`.
- Clones configured GitHub repos and downloads mooncakes package archives.
- Runs a matrix of `moon check`, `moon build`, `moon test` (test currently build-only) across selected backends & OS.
- Captures stdout/stderr, timing, success/failure per command/backend.
- Writes structured line-delimited JSON (`.jsonl`) for later rendering in the web UI.
- Compares nightly vs stable channel results and labels:
  - `regression` – nightly failed but stable succeeded (potential toolchain regression)
  - `inconsistent` – results differ across platforms
  - `ok` – consistent success or uniformly skipped

## 🧱 Architecture Overview

| Layer                     | File(s)                                       | Responsibility                                                      |
| ------------------------- | --------------------------------------------- | ------------------------------------------------------------------- |
| CLI parsing               | `lib/cli.ts`                                  | Parse args (`--channel`, `--repos`, `--exclude`, `--only`).         |
| Source discovery          | `lib/source.ts#getMooncakeSources`            | Merge mooncakes index + repos config + exclusions.                  |
| Mooncakes index access    | `lib/mooncakesio.ts`                          | Read local index, filter out test-only packages, discover versions. |
| Download / clone          | `lib/mooncakesio.ts#downloadTo`, `lib/git.ts` | Fetch package zip or clone git repo at rev.                         |
| Execution wrapper         | `lib/moon.ts#runMoon`                         | Run `moon` commands with timeout & capture output.                  |
| Build + log orchestration | `lib/build.ts`, `lib/log.ts`                  | Build matrix execution + per-command log file creation.             |
| Result aggregation        | `lib/core.ts#stat`                            | Collect metadata (run id, toolchain version, timestamps).           |
| Type system / schemas     | `lib/types.ts`, `schema.ts`                   | Zod schemas, JSON schema emission.                                  |
| Web UI                    | `web.ts` + `index.html`                       | Render table, fetch published `.jsonl` artifacts, classify results. |

## 📦 Data Format

Each output file: `data/{os}-{channel}.jsonl`

First line: Metadata object:

```json
{
  "runId": "<CI_RUN_ID>",
  "runNumber": "<CI_RUN_NUMBER>",
  "startTime": "2025-10-20T00:00:00.000Z",
  "toolchainVersion": ["moon <version lines>"]
}
```

Subsequent lines: `BuildResult` objects:

```json
{
	"source": {"type": "mooncakes", "name": "foo", "version": "1.2.3"},
	"cbt": {
		"check": {"wasm": {"status": "Success", "elapsed": 123, ...}, ...},
		"build": { ... },
		"test": { ... }
	}
	// or "error": "Unable to download"
}
```

Skipped backends/commands use `{"status": "Skipped"}`.

## 🗃 External Log Storage (NEW)

Previously each `Result` embedded full `stdout` and `stderr` strings directly in the JSONL, producing very large files
and slow initial page loads.

Now logs are written to separate files under `data/logs/` and the JSONL stores lightweight path references:

```jsonc
// Example Result (success)
{
  "status": "Success",
  "start_time": "2025-10-20 10:00:00",
  "elapsed": 1234,
  "stdout_path": "logs/abcd1234ef567890.out.log",
  "stderr_path": "logs/abcd1234ef567890.err.log"
}
```

The file name uses a SHA-256 hash (first 16 hex chars) of the tuple `(type, sourceId, command, backend)` to keep names
short yet unique:

```
<hash>.out.log
<hash>.err.log
```

Frontend behavior: when you click a cell the UI fetches these two log files on demand instead of constructing a Blob
from embedded strings. This reduces bandwidth and speeds up initial render.

Benefits:

1. Much smaller `data/*.jsonl` artifacts.
2. Browser/CDN can cache individual log files.
3. Faster initial dashboard load with lazy log fetching.

Future migration script (planned): `deno run -A scripts/migrate-logs.ts <old.jsonl> <new.jsonl>` will extract embedded
logs from older artifacts into `data/logs/` and rewrite each line with path references.

If a log file is missing or fetch fails, the UI displays a clear error message in the opened tab.

## ⚙️ Configuration Files

- `resources/repos.yml` – whitelist of GitHub repos and mooncakes overrides (OS/backends/version pinning).
- `resources/exclude.yml` – list of mooncakes to skip globally.
- `schema.ts` – emits JSON Schemas: `resources/repos.schema.json`, `resources/exclude.schema.json`.

Run schema generation:

```sh
deno run -A schema.ts
```

### repos.yml Structure (simplified)

```yaml
github-repos:
	- name: corelib
		link: https://github.com/moonbitlang/corelib
		branch: main
		running_os: [linux, macos]
		running_backend: [wasm, native]
mooncakes:
	- name: foo
		version: 1.2.3
		running_os: [linux, macos, windows]
		running_backend: [wasm, wasm-gc, js, native]
```

## 🚀 Running the Collector

Requires the MoonBit toolchain (`moon` executable) in PATH and populated `~/.moon/registry/index/user`.

Stat run (default channel=stable):

```sh
deno run -A main.ts stat --channel nightly --repos resources/repos.yml --exclude resources/exclude.yml
```

Generates: `data/<os>-<channel>.jsonl` for the current OS only. (CI runs across all OS variants.)

### Options

- `--channel stable|nightly` – choose toolchain channel under test.
- `--repos PATH` – repos configuration file (default `repos.yml`).
- `--exclude PATH` – exclusion list (default `exclude.yml`).
- `--only` – only process entries explicitly listed in repos.yml (skip full index scan). Useful for debugging.
- `--max-concurrent-builds NUMBER` – maximum number of concurrent package builds (default: 3). Controls how many
  packages can be built simultaneously.

### Concurrency Control

To prevent timeouts caused by excessive parallelism, the dashboard implements concurrency control at the package level
using a simple `Promise.race` based approach.

**Package-level concurrency** (`--max-concurrent-builds`): Limits how many packages are built at the same time (default:
3).

You can configure this limit via:

- **CLI argument**: `--max-concurrent-builds`
- **Environment variable**: `MAX_CONCURRENT_BUILDS`

Example:

```sh
# Limit to 2 concurrent packages
deno run -A main.ts stat --max-concurrent-builds 2

# Or via environment variable
MAX_CONCURRENT_BUILDS=2 deno run -A main.ts stat
```

**Implementation details**: The `executeWithConcurrency` function uses standard Web APIs (Promise-based) without any
external dependencies:

- Maintains a Set of executing promises (避免数组 splice 导致的索引问题)
- When the concurrency limit is reached, waits for any task to complete using `Promise.race`
- Tasks automatically remove themselves from the Set when completed
- Ensures results maintain the same order as input tasks
- Compatible with both Deno and Node.js

Within each package, different backend targets (wasm, js, native, etc.) are built sequentially to avoid resource
contention.

## 📊 Analyzing Results Locally

The `analyze.ts` helper can scan a produced file and print slow (>1000ms) or failing tasks:

```sh
deno run -A analyze.ts data/linux-nightly.jsonl
```

Example output lines:

```
failed https://github.com/... - build - wasm
slow foo@1.2.3 - test - native - 2150ms
```

## 🌐 Web Dashboard

The frontend (`web.ts`) bundles to `web.js` and fetches published artifacts (e.g. from GitHub Pages). It:

- Merges per-source results across all (OS, channel) combinations.
- Computes a per-source label (`regression`, `inconsistent`, `ok`).
- Provides per-cell click to open raw logs (stdout/stderr + timing) for a specific command/backend.

Dev bundle (watch):

```sh
deno task dev
```

## 🔒 Timeouts & Stability

Each `moon` command is wrapped with a 60s timeout to avoid hanging builds/tests. Test runs use `--build-only` to prevent
potentially long-running suites.

## 🧪 Regression Detection Logic

For each platform: if nightly fails while stable succeeds → mark regression. If mixed success/failure exists across
platforms within a channel → inconsistent.

## 🧩 Key Design Choices

- Line-delimited JSON allows streaming parse in web UI and incremental processing.
- Separation of source discovery and build execution keeps logic modular.
- Zod schemas ensure config validation early and enable automatic JSON Schema generation.
- Stateless execution: each source builds in a fresh temp dir, avoiding cross-contamination.
- 2025-10 refactor: `core.ts` 精简为仅聚合与调度；新增 `source.ts` / `build.ts` / `log.ts`
  分离职责，提升可维护性与测试粒度。

## 🛠 Troubleshooting

- Missing `moon` binary → install MoonBit toolchain first.
- Empty index → ensure you have fetched packages (`moon update` to sync registry).
- Lots of `Skipped` statuses → current OS not in package `running_os`; check overrides in `repos.yml`.
- Timeout failures → inspect logs; consider increasing timeout logic if legitimately long builds.
