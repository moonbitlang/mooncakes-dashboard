/// <reference lib="deno.ns" />

// CLI 模块，对应 Rust 版本中的 cli.rs
import { parseArgs } from '@std/cli/parse-args';

export interface StatSubcommand {
  channel: 'stable' | 'nightly';
  maxConcurrentBuilds?: number;
  sources?: string;
  buildConfig?: string;
}

export type MoonBuildDashBoardCli = {
  subcommand: 'stat';
  options: StatSubcommand;
};

export function parseCliArgs(args: string[]): MoonBuildDashBoardCli {
  const parsed = parseArgs(args, {
    string: ['channel', 'sources', 'build-config', 'max-concurrent-builds'],
    alias: {
      h: 'help',
    },
    boolean: ['help'],
  });

  if (parsed.help) {
    console.log(`
Moon Build Dashboard CLI

USAGE:
    deno run -A main.ts stat [OPTIONS]

SUBCOMMANDS:
    stat    Run statistics on repositories

OPTIONS:
    --sources <PATH>                      Path to sources config file [default: resources/sources.yml]
    --build-config <PATH>                 Path to build config file [default: resources/build-config.yml]
    --channel <CHANNEL>                   Channel to use (stable or nightly) [default: stable]
    --max-concurrent-builds <NUMBER>      Maximum number of concurrent builds [default: 3]
    -h, --help                            Show this help message
`);
    Deno.exit(0);
  }

  // 默认子命令是 stat
  const subcommand = parsed._[0] as string || 'stat';

  switch (subcommand) {
    case 'stat': {
      const maxConcurrentBuilds = parsed['max-concurrent-builds']
        ? parseInt(parsed['max-concurrent-builds'], 10)
        : undefined;

      return {
        subcommand: 'stat',
        options: {
          channel: (parsed.channel === 'nightly' ? 'nightly' : 'stable') as 'stable' | 'nightly',
          sources: parsed.sources,
          buildConfig: parsed['build-config'],
          maxConcurrentBuilds,
        },
      };
    }
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      Deno.exit(1);
  }
}
