import { parseArgs } from '@std/cli/parse-args';
import { JsonParseStream } from '@std/json';
import { TextLineStream } from '@std/streams';
import { BuildResult, Status } from './lib/types.ts';

const file = parseArgs(Deno.args)._[0];

if (!file || typeof file !== 'string') {
  console.error('Please provide a file path to analyze.');
  Deno.exit(1);
}

const f = await Deno.open(file, { read: true });

const results: BuildResult[] = [];

await f.readable.pipeThrough(new TextDecoderStream()).pipeThrough(new TextLineStream()).pipeThrough(
  new JsonParseStream(),
)
  .pipeTo(
    new WritableStream({
      write(chunk) {
        results.push(chunk as unknown as BuildResult);
      },
    }),
  );

for (const result of results) {
  if (result.cbt) {
    for (const cmd of ['check', 'build', 'test'] as const) {
      const t = result.cbt[cmd];
      for (const backend of ['wasm', 'wasm-gc', 'js', 'native'] as const) {
        const r = t[backend];
        if (r.status === Status.Failure) {
          console.log(
            'failed',
            `${
              result.source.type === 'git' ? result.source.url + '@' + result.source.rev : result.source.name
            } - ${cmd} - ${backend}`,
          );
        }
        if (r.status === Status.Failure || r.status === Status.Success) {
          if (r.elapsed > 1000) {
            console.log(
              'slow',
              `${
                result.source.type === 'git' ? result.source.url + '@' + result.source.rev : result.source.name
              } - ${cmd} - ${backend} - ${r.elapsed}ms`,
            );
          }
        }
      }
    }
  }
}
