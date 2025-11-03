import { Backend, BuildConfigs, BuildResult, CBT, Mooncake, MoonCommand, Result, SKIPPED, Status } from './types.ts';
import { runMoon } from './moon.ts';
import { gitCloneTo } from './git.ts';
import { downloadTo } from './mooncakesio.ts';
import { makeLogSlug, writeLogFiles } from './log.ts';
import { findBuildConfig } from './source.ts';
import { join } from '@std/path';

// 从 core.ts 抽离：statMooncake / runMatrix / build （实现保持原样）

export async function statMooncake(
  workdir: string,
  source: Mooncake,
  command: MoonCommand,
  backend: Backend,
  dir: string,
): Promise<Result> {
  const startTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const slug = await makeLogSlug(source);
  try {
    const result = await runMoon(workdir, [
      command,
      '--target',
      backend,
      '--frozen',
      '--target-dir',
      `target/${backend}`,
      ...(command === 'test' ? ['--build-only'] : []),
    ]);
    const status = result.success ? Status.Success : Status.Failure;
    const paths = await writeLogFiles(slug, dir, command, backend, result.stdout, result.stderr);
    return {
      status,
      start_time: startTime,
      elapsed: result.duration,
      stdout_path: paths.stdout_path,
      stderr_path: paths.stderr_path,
    };
  } catch (error) {
    console.error(`RUN moon ${command} for ${JSON.stringify(source)}`, error);
    const paths = await writeLogFiles(
      slug,
      dir,
      command,
      backend,
      '',
      error instanceof Error ? error.message : String(error),
    );
    return {
      status: Status.Failure,
      start_time: startTime,
      elapsed: 0,
      stdout_path: paths.stdout_path,
      stderr_path: paths.stderr_path,
    };
  }
}

export async function runMatrix(
  workdir: string,
  source: Mooncake,
  runningOs: string[],
  runningBackend: Backend[],
  dir: string,
): Promise<CBT> {
  const currentOs = Deno.build.os;
  let shouldRun = false;

  for (const os of runningOs) {
    if ((os === currentOs) || (os === 'macos' && currentOs === 'darwin')) {
      shouldRun = true;
      break;
    }
  }

  const result: CBT = {
    check: { wasm: SKIPPED, 'wasm-gc': SKIPPED, js: SKIPPED, native: SKIPPED },
    build: { wasm: SKIPPED, 'wasm-gc': SKIPPED, js: SKIPPED, native: SKIPPED },
    test: { wasm: SKIPPED, 'wasm-gc': SKIPPED, js: SKIPPED, native: SKIPPED },
  };

  if (shouldRun) {
    // 顺序执行每个 backend 的构建（移除并发控制）
    for (const backend of runningBackend) {
      for (const command of ['check', 'build', 'test'] as MoonCommand[]) {
        result[command][backend] = await statMooncake(
          workdir,
          source,
          command,
          backend,
          dir,
        );
        if (result[command][backend].status === Status.Failure) {
          break;
        }
      }
    }
  }

  return result;
}

export async function build(source: Mooncake, dir: string, build_config: BuildConfigs): Promise<BuildResult> {
  const tmp = await Deno.makeTempDir();

  try {
    if (source.type === 'git') {
      try {
        await gitCloneTo(source.url, tmp, source.rev, tmp);
        await runMoon(tmp, ['install']);
        const config = JSON.parse(await Deno.readTextFile(join(tmp, 'moon.mod.json')));
        const name = config.name as string;
        const version = config.version as string;
        const buildConfig = findBuildConfig(name, version, build_config.configs);
        const cbt = await runMatrix(
          tmp,
          source,
          buildConfig.running_os,
          buildConfig.running_backend,
          dir,
        );
        return { source: { type: 'git', url: source.url, rev: source.rev }, cbt };
      } catch (error) {
        console.error(`Failed to checkout ${source.rev}:`, error);
        return { source: { type: 'git', url: source.url, rev: source.rev }, error: (error as Error).message };
      }
    } else {
      try {
        await downloadTo(source.name, source.version, tmp);
        await runMoon(tmp, ['install']);
        const buildConfig = findBuildConfig(source.name, source.version, build_config.configs);
        const cbt = await runMatrix(
          tmp,
          source,
          buildConfig.running_os,
          buildConfig.running_backend,
          dir,
        );
        return { source: { type: 'mooncakes', name: source.name, version: source.version }, cbt };
      } catch (error) {
        console.error(`Failed to download ${source.name}@${source.version}:`, error);
        return {
          source: { type: 'mooncakes', name: source.name, version: source.version },
          error: (error as Error).message,
        };
      }
    }
  } finally {
    try {
      await Deno.remove(tmp, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  }
}
