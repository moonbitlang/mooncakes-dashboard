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

| Layer                  | File(s)                                       | Responsibility                                                      |
| ---------------------- | --------------------------------------------- | ------------------------------------------------------------------- |
| CLI parsing            | `lib/cli.ts`                                  | Parse args (`--channel`, `--repos`, `--exclude`, `--only`).         |
| Source discovery       | `lib/core.ts#getMooncakeSources`              | Merge mooncakes index + repos config + exclusions.                  |
| Mooncakes index access | `lib/mooncakesio.ts`                          | Read local index, filter out test-only packages, discover versions. |
| Download / clone       | `lib/mooncakesio.ts#downloadTo`, `lib/git.ts` | Fetch package zip or clone git repo at rev.                         |
| Execution wrapper      | `lib/moon.ts#runMoon`                         | Run `moon` commands with timeout & capture output.                  |
| Build matrix           | `lib/core.ts#runMatrix`                       | Execute `check/build/test` for each backend on current OS.          |
| Result aggregation     | `lib/core.ts#stat`                            | Collect metadata (run id, toolchain version, timestamps).           |
| Type system / schemas  | `lib/types.ts`, `schema.ts`                   | Zod schemas, JSON schema emission.                                  |
| Web UI                 | `web.ts` + `index.html`                       | Render table, fetch published `.jsonl` artifacts, classify results. |

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

## 🛠 Troubleshooting

- Missing `moon` binary → install MoonBit toolchain first.
- Empty index → ensure you have fetched packages (`moon update` to sync registry).
- Lots of `Skipped` statuses → current OS not in package `running_os`; check overrides in `repos.yml`.
- Timeout failures → inspect logs; consider increasing timeout logic if legitimately long builds.
