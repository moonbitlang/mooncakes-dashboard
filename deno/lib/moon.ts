// 工具函数模块，对应 Rust 版本中的 util.rs

import { CommandOutput } from './types.ts';

export class MoonOpsError extends Error {
  constructor(public cmd: string, public originalError: Error) {
    super(`Moon operations error: ${cmd} - ${originalError.message}`);
    this.name = 'MoonOpsError';
  }
}

export async function getMoonVersion(): Promise<string[]> {
  const cmd = 'moon version';
  try {
    const process = new Deno.Command('moon', { args: ['version', '--all'] });

    const { code, stdout } = await process.output();

    if (code !== 0) {
      throw new Error(`Command failed with exit code ${code}`);
    }

    const version = new TextDecoder().decode(stdout).trim();
    return version.split('\n').map((line) => line.trim());
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

    return {
      duration: elapsed,
      stdout: stdoutStr,
      stderr: stderrStr,
      success,
    };
  } catch (error) {
    throw new Error(
      `Failed to run 'moon ${args.join(' ')}'`,
      { cause: error },
    );
  }
}
