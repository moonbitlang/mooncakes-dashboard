# Agents.md

This file documents the current status and architecture of the MoonBit Build Dashboard project.

## Project Overview

The MoonBit Build Dashboard is a TypeScript/Deno-based tool that monitors, builds, and compares the health of all
MoonBit packages published on mooncakes (MoonBit's package registry) plus a curated set of Git repositories. It tracks
buildability across OS (Linux/macOS/Windows), backend targets (wasm/wasm-gc/js/native), and channels (stable/nightly).

## Current Architecture

### Core Components

| Component           | File(s)                            | Responsibility                                                      |
| ------------------- | ---------------------------------- | ------------------------------------------------------------------- |
| CLI Parsing         | `lib/cli.ts`                       | Parse command-line arguments, including channel selection (`stable` |
| Source Discovery    | `lib/source.ts`                    | Merge mooncakes index, repos config, and exclusions                 |
| Mooncakes Access    | `lib/mooncakesio.ts`               | Read local index, filter test-only packages, discover versions      |
| Download/Clone      | `lib/mooncakesio.ts`, `lib/git.ts` | Fetch package zips or clone git repos                               |
| Execution Wrapper   | `lib/moon.ts`                      | Run `moon` commands with timeout & capture output                   |
| Build Orchestration | `lib/build.ts`, `lib/log.ts`       | Build matrix execution + log file creation                          |
| Result Aggregation  | `lib/core.ts`                      | Collect metadata and coordinate builds                              |
| Type System         | `lib/types.ts`                     | Zod schemas, type definitions                                       |
| Web UI              | `web.ts`, `index.html`             | Render dashboard, fetch artifacts, classify results                 |
| Log Analysis        | `lib/analyze.ts`                   | Search build logs for patterns                                      |

### Channel System (Current)

The project currently supports **two channels**:

- `stable` - Stable MoonBit toolchain releases
- `nightly` - Nightly MoonBit toolchain builds

The nightly channel adds the `--warn-list @deprecated` flag during builds.

### Data Flow

1. **Input Sources**:
   - Local mooncakes index (`~/.moon/registry/index/user`)
   - `resources/sources.yml` - Git repos and mooncakes packages
   - `resources/build-config.yml` - Per-package build configuration

2. **Build Process**:
   - Clone/download each source to a temp directory
   - Run `moon check`, `moon build`, `moon test --build-only` across configured backends
   - Execute sequentially for each backend within a package (no parallelism at backend level)
   - Support concurrency control at package level (default: 3 concurrent packages, configurable via
     `--max-concurrent-builds`)

3. **Output Format**:
   - Metadata line + BuildResult lines in `data/{os}/{channel}/data.jsonl`
   - Separate log files in `data/{os}/{channel}/logs/{hash}.out.log` and `data/{os}/{channel}/logs/{hash}.err.log`
   - Log files are named using SHA-256 hash of (type, sourceId, command, backend)

### Regression Detection Logic

For each platform, the web UI compares nightly vs stable results:

- **regression** - nightly failed but stable succeeded (potential toolchain regression)
- **inconsistent** - mixed success/failure within a channel across platforms
- **ok** - consistent success or uniformly skipped

### Type Definitions

Key types in `lib/types.ts`:

- `Backend` - 'wasm' | 'wasm-gc' | 'js' | 'native'
- `OS` - 'linux' | 'macos' | 'windows'
- `Status` - 'Success' | 'Failure' | 'Skipped'
- `BuildResult` - Contains source, CBT (check/build/test results), or error
- `Result` - SuccessResult | FailureResult | SkippedResult (with log file paths)

### Web UI Data Structure

The dashboard merges results across all (OS, channel) combinations:

```typescript
type RowData = {
  identifier: string;
  source: BuildResult['source'];
  'mac/nightly': BuildResult | null;
  'mac/stable': BuildResult | null;
  'linux/nightly': BuildResult | null;
  'linux/stable': BuildResult | null;
  'windows/nightly': BuildResult | null;
  'windows/stable': BuildResult | null;
  label: 'regression' | 'inconsistent' | 'ok' | '';
};
```

## CLI Commands

### stat

Collects build statistics across all configured packages.

```bash
deno run -A main.ts stat --channel <stable|nightly> --sources <path> --build-config <path> --max-concurrent-builds <number>
```

### analyze

Searches build logs for specific patterns (operators, library usage, etc.).

```bash
deno run -A main.ts analyze --file <data.jsonl> --patterns <pattern...> --predefined <set> --csv <file>
```

### schema

Generates JSON schema files for configuration validation.

```bash
deno run -A main.ts schema
```

## Configuration Files

### sources.yml

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

### build-config.yml

```yaml
configs:
  - package: foo
    version: '>=1.0.0'
    running_os: [linux, macos]
    running_backend: [wasm, native]
```

## Design Decisions

- **Line-delimited JSON** - Allows streaming parse and incremental processing
- **Separate log files** - Reduces JSONL size, enables lazy loading in web UI
- **Stateless execution** - Each source builds in a fresh temp directory
- **Sequential backend execution** - Within each package, backends build sequentially to avoid resource contention
- **Package-level concurrency** - Multiple packages build in parallel (configurable)
- **Zod schemas** - Early validation and automatic JSON Schema generation

## Dependencies

Key dependencies from `deno.json`:

- `@std/json`, `@std/path`, `@std/fs`, `@std/cli`, `@std/datetime`, `@std/semver`, `@std/streams`, `@std/yaml`
- `@zip-js/zip-js` - For package archive handling
- `zod` - For schema validation
- `npm:htm/preact` - For web UI rendering

## Development Workflow

```bash
# Development (watch mode)
deno task dev

# Check types
deno task check

# Format code
deno task fmt

# Lint
deno task lint
```

## File Structure

```
moon-build-dashboard/
├── lib/              # Core library modules
│   ├── analyze.ts    # Log pattern analysis
│   ├── build.ts      # Build orchestration
│   ├── cli.ts        # CLI parsing
│   ├── core.ts       # Main business logic
│   ├── git.ts        # Git operations
│   ├── log.ts        # Log file handling
│   ├── moon.ts       # Moon command execution
│   ├── mooncakesio.ts # Mooncakes registry access
│   ├── source.ts     # Source discovery
│   ├── types.ts      # Type definitions
│   └── utils.ts      # Utility functions
├── resources/        # Configuration files
│   ├── build-config.yml
│   ├── build-config.schema.json
│   ├── sources.yml
│   └── sources.schema.json
├── data/             # Output data directory
├── docs/             # Documentation
├── main.ts           # Entry point
├── web.ts            # Web UI
└── index.html        # Web UI HTML
```

## Testing

- Tests are in `lib/source_test.ts`
- No test command is currently defined in `deno.json`

## Limitations & Known Issues

- Only two channels supported (stable, nightly)
- Regression detection only compares nightly vs stable
- Web UI hardcodes channel arrays in multiple places
- No automated testing pipeline configured
