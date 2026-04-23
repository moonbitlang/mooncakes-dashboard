// 工具函数模块，对应 Rust 版本中的 util.rs

import { CommandOutput } from './types.ts';

const MOON_ENV = {
  MOON_IGNORE_PREBUILD: '1',
  MOON_NO_WORKSPACE: '1',
} as const;

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

    const { success, stdout, code, stderr } = await process.output();

    if (!success) {
      console.error('`moon version --all\` failed', `stderr: ${new TextDecoder().decode(stderr)}`);
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
  stdoutPath: string,
  stderrPath: string,
): Promise<CommandOutput> {
  const start = Date.now();
  const signal = new AbortController();
  const timeout = setTimeout(() => {
    signal.abort();
  }, 120000); // 2 minutes timeout

  try {
    const process = new Deno.Command('moon', {
      args,
      cwd: workdir,
      env: MOON_ENV,
      signal: signal.signal,
      stdout: 'piped',
      stderr: 'piped',
    });

    using stdoutFile = await Deno.open(stdoutPath, { create: true, write: true, truncate: true });
    using stderrFile = await Deno.open(stderrPath, { create: true, write: true, truncate: true });
    const child = process.spawn();
    const stdoutTask = child.stdout.pipeTo(stdoutFile.writable);
    const stderrTask = child.stderr.pipeTo(stderrFile.writable);
    const { success } = await child.status;
    await Promise.all([stdoutTask, stderrTask]);
    clearTimeout(timeout);
    const elapsed = Date.now() - start;

    return {
      duration: elapsed,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      success,
    };
  } catch (error) {
    throw new Error(
      `Failed to run 'moon ${args.join(' ')}'`,
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }
}
