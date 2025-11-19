/// <reference lib="deno.ns" />

// CLI 模块，对应 Rust 版本中的 cli.rs
import { parseArgs } from '@std/cli/parse-args';

export interface StatSubcommand {
  channel: 'stable' | 'nightly';
  maxConcurrentBuilds?: number;
  sources?: string;
  buildConfig?: string;
}

export interface AnalyzeSubcommand {
  patterns?: string[];
  predefined?: 'old_operators' | 'immut_list' | 'moonbitlang_core' | 'json_usage';
  regex?: boolean;
  simple?: boolean;
  csv?: string;
  dataDir: string;
  file?: string;
  githubOrgs?: string[];
}

export type MoonBuildDashBoardCli =
  | {
    subcommand: 'stat';
    options: StatSubcommand;
  }
  | {
    subcommand: 'analyze';
    options: AnalyzeSubcommand;
  }
  | {
    subcommand: 'schema';
  };

function showHelp() {
  console.log(`
Moon Build Dashboard CLI

USAGE:
    deno run -A main.ts <SUBCOMMAND> [OPTIONS]

SUBCOMMANDS:
    stat       Run statistics on repositories
    analyze    Analyze build logs for patterns
    schema     Generate JSON schemas for configuration files

GLOBAL OPTIONS:
    -h, --help                            Show this help message

Use "deno run -A main.ts <SUBCOMMAND> --help" for more information about a subcommand.
`);
}

function showStatHelp() {
  console.log(`
Run statistics on repositories

USAGE:
    deno run -A main.ts stat [OPTIONS]

OPTIONS:
    --sources <PATH>                      Path to sources config file [default: resources/sources.yml]
    --build-config <PATH>                 Path to build config file [default: resources/build-config.yml]
    --channel <CHANNEL>                   Channel to use (stable or nightly) [default: stable]
    --max-concurrent-builds <NUMBER>      Maximum number of concurrent builds [default: 3]
    -h, --help                            Show this help message

EXAMPLES:
    deno run -A main.ts stat --channel nightly
    deno run -A main.ts stat --channel stable --max-concurrent-builds 5
`);
}

function showAnalyzeHelp() {
  console.log(`
Analyze build logs for patterns

USAGE:
    deno run -A main.ts analyze [OPTIONS]

OPTIONS:
    -f, --file <PATH>                     Analyze a single data.jsonl file (simple mode)
    -p, --patterns <PATTERN>...           Patterns to search for (can be specified multiple times)
    -d, --predefined <SET>                Use predefined pattern set:
                                          old_operators, immut_list, moonbitlang_core, json_usage
    -r, --regex                           Treat patterns as regular expressions
    -s, --simple                          Simple output mode (package names only)
    -c, --csv <FILENAME>                  Export results to CSV file
    -D, --data-dir <PATH>                 Data directory path [default: data]
    -g, --github-orgs <ORG>...            Filter results to specific GitHub organizations
                                          (can be specified multiple times)
    -h, --help                            Show this help message

PREDEFINED PATTERN SETS:
    old_operators      - Old operator overload syntax (op_add, op_mul, etc.)
    immut_list         - Usage of @immut/list package
    moonbitlang_core   - Usage of @moonbitlang/core package
    json_usage         - JSON-related functionality usage

EXAMPLES:
    # Analyze with predefined patterns
    deno run -A main.ts analyze --predefined old_operators

    # Analyze with custom patterns
    deno run -A main.ts analyze --patterns op_add op_mul --regex

    # Analyze a single file (simple mode)
    deno run -A main.ts analyze --file data/linux/stable/data.jsonl

    # Export results to CSV
    deno run -A main.ts analyze --predefined old_operators --csv results.csv

    # Filter results to moonbitlang and moonbit-community organizations
    deno run -A main.ts analyze --predefined old_operators --github-orgs moonbitlang moonbit-community
`);
}

function showSchemaHelp() {
  console.log(`
Generate JSON schemas for configuration files

USAGE:
    deno run -A main.ts schema

OPTIONS:
    -h, --help                            Show this help message

DESCRIPTION:
    Generates JSON schema files for configuration validation:
    - resources/sources.schema.json
    - resources/build-config.schema.json

EXAMPLE:
    deno run -A main.ts schema
`);
}

function parseStatArgs(args: string[]): StatSubcommand {
  const parsed = parseArgs(args, {
    string: ['channel', 'sources', 'build-config', 'max-concurrent-builds'],
    alias: {
      h: 'help',
    },
    boolean: ['help'],
  });

  if (parsed.help) {
    showStatHelp();
    Deno.exit(0);
  }

  const maxConcurrentBuilds = parsed['max-concurrent-builds']
    ? parseInt(parsed['max-concurrent-builds'], 10)
    : undefined;

  return {
    channel: (parsed.channel === 'nightly' ? 'nightly' : 'stable') as 'stable' | 'nightly',
    sources: parsed.sources,
    buildConfig: parsed['build-config'],
    maxConcurrentBuilds,
  };
}

function parseAnalyzeArgs(args: string[]): AnalyzeSubcommand {
  const parsed = parseArgs(args, {
    string: ['predefined', 'csv', 'data-dir', 'file'],
    alias: {
      h: 'help',
      p: 'patterns',
      d: 'predefined',
      r: 'regex',
      s: 'simple',
      c: 'csv',
      D: 'data-dir',
      f: 'file',
      g: 'github-orgs',
    },
    boolean: ['help', 'regex', 'simple'],
    collect: ['patterns', 'github-orgs'],
  });

  if (parsed.help) {
    showAnalyzeHelp();
    Deno.exit(0);
  }

  return {
    patterns: parsed.patterns as string[] | undefined,
    predefined: parsed.predefined as
      | 'old_operators'
      | 'immut_list'
      | 'moonbitlang_core'
      | 'json_usage'
      | undefined,
    regex: parsed.regex,
    simple: parsed.simple,
    csv: parsed.csv,
    dataDir: parsed['data-dir'] || 'data',
    file: parsed.file,
    githubOrgs: parsed['github-orgs'] as string[] | undefined,
  };
}

function parseSchemaArgs(args: string[]): void {
  const parsed = parseArgs(args, {
    boolean: ['help'],
    alias: {
      h: 'help',
    },
  });

  if (parsed.help) {
    showSchemaHelp();
    Deno.exit(0);
  }
}

export function parseCliArgs(args: string[]): MoonBuildDashBoardCli {
  // Parse global options and get subcommand
  const globalParsed = parseArgs(args, {
    boolean: ['help'],
    alias: {
      h: 'help',
    },
    stopEarly: true, // Stop parsing at the first non-option argument (the subcommand)
  });

  if (globalParsed.help) {
    showHelp();
    Deno.exit(0);
  }

  // Get the subcommand (first positional argument)
  const subcommand = globalParsed._[0] as string;

  if (!subcommand) {
    console.error('Error: No subcommand specified. Use --help for usage information.');
    Deno.exit(1);
  }

  // Get remaining arguments after the subcommand
  const subcommandArgs = globalParsed._.slice(1).map(String);

  switch (subcommand) {
    case 'stat':
      return {
        subcommand: 'stat',
        options: parseStatArgs(subcommandArgs),
      };
    case 'analyze':
      return {
        subcommand: 'analyze',
        options: parseAnalyzeArgs(subcommandArgs),
      };
    case 'schema': {
      parseSchemaArgs(subcommandArgs);
      return {
        subcommand: 'schema',
      };
    }
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      console.error('Use --help for usage information.');
      Deno.exit(1);
  }
}
