// 主入口文件，对应 Rust 版本中的 main.rs
import { join } from '@std/path/join';
import { parseCliArgs } from './lib/cli.ts';
import { stat } from './lib/core.ts';
import { JsonStringifyStream } from '@std/json';
import { analyze } from './lib/analyze.ts';
import z from 'zod';
import { BuildConfigsSchema, SourcesSchema } from './lib/types.ts';

// assume pwd is in the `deno` directory

try {
  const cli = parseCliArgs(Deno.args);

  if (cli.subcommand === 'stat') {
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
        throw new Error(`Unsupported OS: ${Deno.build.os}`);
    }
    const dir = `data/${os}/${cli.options.channel}`;
    const dashboard = await stat(cli.options, dir);

    const path = join(dir, `data.jsonl`);

    const metadata = dashboard.metadata;
    {
      await Deno.mkdir(dir, { recursive: true });
      using file = await Deno.open(path, {
        create: true,
        write: true,
        truncate: true,
      });
      await ReadableStream.from([metadata]).pipeThrough(new JsonStringifyStream()).pipeThrough(
        new TextEncoderStream(),
      )
        .pipeTo(file.writable);
    }
    {
      using file = await Deno.open(path, {
        append: true,
      });
      await ReadableStream.from(dashboard.result).pipeThrough(new JsonStringifyStream()).pipeThrough(
        new TextEncoderStream(),
      )
        .pipeTo(file.writable);
    }
  } else if (cli.subcommand === 'analyze') {
    await analyze(cli.options);
  } else if (cli.subcommand === 'schema') {
    // Generate schemas
    await Deno.writeTextFile(
      'resources/sources.schema.json',
      JSON.stringify(z.toJSONSchema(SourcesSchema), null, 2),
    );
    await Deno.writeTextFile(
      'resources/build-config.schema.json',
      JSON.stringify(z.toJSONSchema(BuildConfigsSchema), null, 2),
    );

    console.log('Generated schemas:');
    console.log('  - resources/sources.schema.json');
    console.log('  - resources/build-config.schema.json');
  }
} catch (error) {
  console.error('Error running moon-build-dashboard:', error);
  Deno.exit(1);
}
