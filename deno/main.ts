// 主入口文件，对应 Rust 版本中的 main.rs
import { parseCliArgs } from './lib/cli.ts';
import { stat } from './lib/core.ts';
import { JsonStringifyStream } from '@std/json';

async function main(): Promise<void> {
  try {
    const cli = parseCliArgs(Deno.args);

    if (cli.subcommand === 'stat') {
      const dashboard = await stat(cli.statOptions);

      // 检测操作系统
      let os: string;
      switch (Deno.build.os) {
        case 'windows':
          os = 'windows';
          break;
        case 'linux':
          os = 'linux';
          break;
        case 'darwin':
          os = 'mac';
          break;
        default:
          console.error('Unsupported OS:', Deno.build.os);
          Deno.exit(1);
      }

      const metadata = dashboard.metadata;
      await Deno.mkdir(`webapp/public/${os}`, { recursive: true });
      await Deno.writeTextFile(
        `webapp/public/${os}/latest-${cli.statOptions.channel}-metadata.json`,
        JSON.stringify(metadata, null, 2),
        {
          create: true,
        },
      );

      using file = await Deno.open(`webapp/public/${os}/latest-${cli.statOptions.channel}.jsonl`, {
        write: true,
        create: true,
        truncate: true,
      });
      await ReadableStream.from(dashboard.result).pipeThrough(new JsonStringifyStream()).pipeThrough(
        new TextEncoderStream(),
      )
        .pipeTo(file.writable);

      console.log(`Dashboard data written for ${os} ${cli.statOptions.channel}`);
    }
  } catch (error) {
    console.error('Error running moon-build-dashboard:', error);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
