// 工具函数模块，对应 Rust 版本中的 util.rs

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
