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

- `resources/sources.yml` – configuration of package sources (Git repos and mooncakes packages).
- `resources/build-config.yml` – per-package build configuration (OS/backends/version constraints).
- `schema.ts` – emits JSON Schemas: `resources/sources.schema.json`, `resources/build-config.schema.json`.

Run schema generation:

```sh
deno run -A main.ts schema
```

### sources.yml Structure (simplified)

```yaml
git-repos:
  - name: corelib
    link: https://github.com/moonbitlang/corelib
    branch: main
mooncakes:
  - name: foo
    version: '1.2.3'
exclude:
  - deprecated-package
include_all_mooncakes: true
```

### build-config.yml Structure (simplified)

```yaml
configs:
  - package: foo
    version: '>=1.0.0'
    running_os: [linux, macos]
    running_backend: [wasm, native]
```

## 🚀 Running the Collector

The tool now provides a unified CLI with three subcommands: `stat`, `analyze`, and `schema`.

### Prerequisites

Requires the MoonBit toolchain (`moon` executable) in PATH and populated `~/.moon/registry/index/user`.

### Usage

```sh
deno run -A main.ts <SUBCOMMAND> [OPTIONS]
```

### Available Subcommands

#### 1. `stat` - Run Statistics on Repositories

Collects build statistics across all configured packages and generates JSONL data files.

```sh
deno run -A main.ts stat --channel nightly --sources resources/sources.yml --build-config resources/build-config.yml
```

**Options:**

- `--sources PATH` - Path to sources config file (default: `resources/sources.yml`)
- `--build-config PATH` - Path to build config file (default: `resources/build-config.yml`)
- `--channel stable|nightly` - Channel to use (default: `stable`)
- `--max-concurrent-builds NUMBER` - Maximum number of concurrent builds (default: 3)

Generates: `data/<os>/<channel>/data.jsonl` for the current OS only. (CI runs across all OS variants.)

#### 2. `analyze` - Analyze Build Logs for Patterns

Search build logs for specific patterns like old operator overloads, library usage, etc.

**Simple Analysis Mode** (quick failures/slow builds):

```sh
deno run -A main.ts analyze --file data/mac/nightly/data.jsonl
```

**Pattern Search Mode** (comprehensive log analysis):

```sh
# Use predefined patterns
deno run -A main.ts analyze --predefined old_operators

# Custom patterns
deno run -A main.ts analyze --patterns op_add op_mul @immut/list

# With regex
deno run -A main.ts analyze --patterns "op_\w+" --regex

# Export to CSV
deno run -A main.ts analyze --predefined old_operators --csv results.csv

# Simple output (package names only)
deno run -A main.ts analyze --predefined old_operators --simple

# Filter to specific GitHub organizations
deno run -A main.ts analyze --predefined old_operators --github-orgs moonbitlang moonbit-community
```

**Options:**

- `-f, --file PATH` - Analyze a single data.jsonl file (simple mode: shows failures and slow builds)
- `-p, --patterns PATTERN...` - Patterns to search for (can be specified multiple times)
- `-d, --predefined SET` - Use predefined pattern set: `old_operators`, `immut_list`, `moonbitlang_core`, `json_usage`
- `-r, --regex` - Treat patterns as regular expressions
- `-s, --simple` - Simple output mode (package names only)
- `-c, --csv FILENAME` - Export results to CSV file
- `-D, --data-dir PATH` - Data directory path (default: `data`)
- `-g, --github-orgs ORG...` - Filter results to specific GitHub organizations (e.g., moonbitlang, moonbit-community)

**Predefined Pattern Sets:**

- `old_operators` - Old operator overload syntax (op_add, op_mul, etc.)
- `immut_list` - Usage of @immut/list package
- `moonbitlang_core` - Usage of @moonbitlang/core package
- `json_usage` - JSON-related functionality usage

**GitHub Organization Filtering:**

When you specify `--github-orgs`, the tool will output an additional list of GitHub repositories from the specified organizations that need to be fixed. This is useful for focusing on packages maintained by specific organizations like `moonbitlang` or `moonbit-community`.

Example output:
```
================================================================================
需要修复的GitHub仓库 (组织: moonbitlang, moonbit-community)
================================================================================
总数: 5

 1. https://github.com/moonbitlang/core
 2. https://github.com/moonbitlang/x
 3. https://github.com/moonbit-community/async
 4. https://github.com/moonbit-community/http
 5. https://github.com/moonbit-community/json
```

#### 3. `schema` - Generate JSON Schemas

Generates JSON schema files for configuration validation.

```sh
deno run -A main.ts schema
```

Generates:

- `resources/sources.schema.json`
- `resources/build-config.schema.json`

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
