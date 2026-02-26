# Repository Architecture and Operations

This document explains how the MoonBit Build Dashboard repository is structured and how it runs.

## What This Repo Does

This project runs MoonBit build health checks across:

- package sources: all published mooncakes packages plus selected Git repositories
- channels: `stable`, `nightly`, `pre-release`
- platforms: Linux, macOS, Windows
- backends: `wasm`, `wasm-gc`, `js`, `native`
- commands: `moon check`, `moon build`, `moon test --build-only`

Output is written as JSONL + separate log files under `data/<os>/<channel>/`.

## High-Level Flow

1. Parse CLI args in `main.ts` + `lib/cli.ts`.
2. Load source list from `resources/sources.yml` and build config from `resources/build-config.yml`.
3. Resolve concrete source versions in `lib/source.ts`.
4. For each source, clone/download and run Moon commands in `lib/build.ts`.
5. Capture stdout/stderr to log files in `lib/log.ts`.
6. Write metadata + `BuildResult` rows to `data/<os>/<channel>/data.jsonl`.
7. Render all OS/channel combinations in `web.ts`.

## Key Files

- `main.ts`: subcommands `stat`, `analyze`, `schema`
- `lib/core.ts`: top-level `stat` orchestration and package concurrency control
- `lib/build.ts`: per-package execution and CBT matrix generation
- `lib/moon.ts`: wrapper around `moon` process execution
- `lib/source.ts`: source discovery and build config matching
- `lib/types.ts`: core types (`BuildResult`, `Result`, `Status`, `Backend`, `OS`)
- `lib/analyze.ts`: log-pattern analysis utilities
- `web.ts`: dashboard table rendering and result classification
- `resources/sources.yml`: package and repository input set
- `resources/build-config.yml`: per-package OS/backend overrides

## Data Model You Should Know

Each `data.jsonl` file:

- first line: metadata (`runId`, `runNumber`, `startTime`, `toolchainVersion`)
- remaining lines: `BuildResult`

`BuildResult` shape:

- `source`: mooncakes package or git source descriptor
- `cbt`: nested map `check/build/test -> backend -> Result`
- `error`: source-level failure (download/clone/install) when present

`Result` currently represents one command/backend execution:

- `Success`
- `Failure`
- `WarningFailure` (check failed due configured warning checks, e.g. `--warn-list @deprecated`)
- `Skipped`

`Success` and `Failure` store:

- `start_time`
- `elapsed` (ms)
- `stdout_path`
- `stderr_path`

## Local Development

Prerequisites:

- Deno installed
- MoonBit toolchain (`moon`) in `PATH`
- local mooncakes index available at `~/.moon/registry/index/user`

Useful commands:

```bash
deno task check
deno task lint
deno task fmt
```

Run collection:

```bash
deno run -A main.ts stat --channel nightly
deno run -A main.ts stat --channel pre-release --max-concurrent-builds 5
```

Run analysis:

```bash
deno run -A main.ts analyze --file data/mac/nightly/data.jsonl
deno run -A main.ts analyze --predefined old_operators
```

Generate schemas:

```bash
deno run -A main.ts schema
```

## Common Change Points

When changing command execution behavior:

- start in `lib/build.ts` (`statMooncake`, `runMatrix`)
- verify type impact in `lib/types.ts`
- update UI interpretation in `web.ts`
- update analysis handling in `lib/analyze.ts`

When changing source filtering/version resolution:

- start in `lib/source.ts`
- validate assumptions with `resources/sources.yml` + `resources/build-config.yml`

When changing log format:

- start in `lib/log.ts`
- ensure `web.ts` can still fetch/open logs
- ensure `lib/analyze.ts` still resolves paths

## Operational Notes

- Backend execution inside one package is sequential by design.
- Package-level parallelism is controlled by `--max-concurrent-builds`.
- CI usually runs per OS separately; local runs only generate data for the current OS.
- `Skipped` usually means the package is excluded on current OS/backend by build config.

## Fast Debug Checklist

1. Confirm command and channel in CLI args.
2. Check whether source discovery returned expected package count.
3. Open `data/<os>/<channel>/data.jsonl` and inspect the specific package row.
4. Open referenced `stderr_path` and `stdout_path`.
5. Verify whether failure is source acquisition, `check`, `build`, or `test`.
6. Re-run that source manually in an isolated temp directory if needed.
