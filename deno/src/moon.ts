// 工具函数模块，对应 Rust 版本中的 util.rs

import { RunMoonError } from './core.ts';
import { CommandOutput, Mooncake } from './types.ts';

export class MoonOpsError extends Error {
  constructor(public cmd: string, public originalError: Error) {
    super(`Moon operations error: ${cmd} - ${originalError.message}`);
    this.name = 'MoonOpsError';
  }
}

export async function getMoonVersion(): Promise<string> {
  const cmd = 'moon version';
  try {
    const process = new Deno.Command('moon', { args: ['version'] });

    const { code, stdout } = await process.output();

    if (code !== 0) {
      throw new Error(`Command failed with exit code ${code}`);
    }

    const version = new TextDecoder().decode(stdout).trim();
    return version;
  } catch (error) {
    throw new MoonOpsError(cmd, error as Error);
  }
}

export async function getMooncVersion(): Promise<string> {
  const cmd = 'moonc -v';
  try {
    const process = new Deno.Command('moonc', { args: ['-v'] });

    const { code, stdout } = await process.output();

    if (code !== 0) {
      throw new Error(`Command failed with exit code ${code}`);
    }

    const version = new TextDecoder().decode(stdout).trim();
    return version;
  } catch (error) {
    throw new MoonOpsError(cmd, error as Error);
  }
}

export async function runMoon(
  workdir: string,
  args: string[],
): Promise<CommandOutput> {
  const start = Date.now();

  try {
    const signal = new AbortController();
    const process = new Deno.Command('moon', { args, cwd: workdir, signal: signal.signal });
    const timeout = setTimeout(() => {
      signal.abort();
    }, 60000); // 1 minute timeout

    const { code, stdout, stderr } = await process.output();
    clearTimeout(timeout);

    const stdoutStr = new TextDecoder().decode(stdout);
    const stderrStr = new TextDecoder().decode(stderr);
    const elapsed = Date.now() - start;
    const success = code === 0;

    console.info(
      `moon ${args.join(' ')}, elapsed: ${elapsed}ms, ${success ? 'success' : 'failed'}`,
    );

    return {
      duration: elapsed,
      stdout: stdoutStr,
      stderr: stderrStr,
      success,
    };
  } catch (error) {
    throw new RunMoonError(
      `Failed to run moon command: ${args.join(' ')}`,
      error as Error,
    );
  }
}
