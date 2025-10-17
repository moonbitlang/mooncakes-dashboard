// Git 操作模块，对应 Rust 版本中的 git.rs

export class GitOpsError extends Error {
  constructor(message: string, public originalError?: Error) {
    super(message);
    this.name = 'GitOpsError';
  }
}

export async function gitCloneTo(
  repo: string,
  workdir: string,
  branch: string,
  dst: string,
): Promise<void> {
  try {
    const process = new Deno.Command('git', { args: ['clone', repo, dst, '-b', branch, '--depth', '1'], cwd: workdir });

    const { code } = await process.output();

    if (code !== 0) {
      throw new GitOpsError(`Git clone failed with exit code ${code}`);
    }
  } catch (error) {
    throw new GitOpsError('Failed to clone repository', error as Error);
  }
}
