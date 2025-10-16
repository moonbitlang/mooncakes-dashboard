/// <reference lib="deno.ns" />

// CLI 模块，对应 Rust 版本中的 cli.rs
import { parseArgs } from '@std/cli/parse-args';

export interface StatSubcommand {
  channel: 'stable' | 'nightly';
  repos: string;
  exclude: string;
  only?: boolean;
}

export type MoonBuildDashBoardCli = {
  subcommand: 'stat';
  options: StatSubcommand;
};

export function parseCliArgs(args: string[]): MoonBuildDashBoardCli {
  const parsed = parseArgs(args, {
    string: ['channel', 'repos', 'exclude'],
    alias: {
      h: 'help',
    },
    boolean: ['help', 'only'],
  });

  if (parsed.help) {
    console.log(`
Moon Build Dashboard CLI

USAGE:
    deno run -A src/main.ts stat [OPTIONS]

SUBCOMMANDS:
    stat    Run statistics on repositories

OPTIONS:
    --repos <PATH>        Path to repos config file [default: repos.yml]
    --exclude <PATH>      Path to exclude config file [default: exclude.yml]
    --channel <CHANNEL>   Channel to use (stable or nightly) [default: stable]
    --only                Only process the ones listed in repos. For testing.
    -h, --help            Show this help message
`);
    Deno.exit(0);
  }

  // 默认子命令是 stat
  const subcommand = parsed._[0] as string || 'stat';

  switch (subcommand) {
    case 'stat':
      return {
        subcommand: 'stat',
        options: {
          channel: (parsed.channel === 'nightly' ? 'nightly' : 'stable') as 'stable' | 'nightly',
          repos: parsed.repos || 'repos.yml',
          exclude: parsed.exclude || 'exclude.yml',
          only: parsed.only || false,
        },
      };
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      Deno.exit(1);
  }
}
