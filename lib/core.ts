/// <reference lib="deno.ns" />

// 核心业务逻辑模块，对应 Rust 版本中的 main.rs 核心功能
import {
  Backend,
  BuildResult,
  type CBT,
  MetaData,
  type Mooncake,
  MoonCommand,
  OS,
  Result,
  SKIPPED,
  Status,
  type ToolChainVersion,
} from './types.ts';
import { StatSubcommand } from './cli.ts';
import { getMoonVersion, runMoon } from './moon.ts';
import { gitCloneTo } from './git.ts';
import { downloadTo, getAllMooncakes } from './mooncakesio.ts';
import { getExcludeConfig, getReposConfig } from './utils.ts';

export async function getMooncakeSources(
  cmd: StatSubcommand,
): Promise<Mooncake[]> {
  const repoList: Mooncake[] = [];
  const defaultRunningOs: OS[] = ['linux', 'macos', 'windows'];
  const defaultRunningBackend: Backend[] = ['wasm', 'wasm-gc', 'js', 'native'];

  try {
    const repos = await getReposConfig(cmd.repos);
    const exclude = await getExcludeConfig(cmd.exclude);
    const mooncakes = await getAllMooncakes();

    // Use white list for github repos
    // so there's no need to exclude them
    for (const repo of repos['github-repos']) {
      repoList.push({
        type: 'git',
        url: repo.link,
        rev: repo.branch,
        runningOs: repo.running_os || defaultRunningOs,
        runningBackend: repo.running_backend || defaultRunningBackend,
      });
    }
    if (cmd.only) {
      // For debug purpose, only process the ones listed in repos.yml
      for (const r of repos['mooncakes']) {
        if (exclude.exclude.some((m) => m === r.name)) {
          console.warn(`Skipping excluded mooncake: ${r.name}`);
          continue;
        }
        repoList.push({
          type: 'mooncakesio',
          name: r.name,
          version: r.version,
          runningOs: r.running_os || defaultRunningOs,
          runningBackend: r.running_backend || defaultRunningBackend,
        });
      }
    } else {
      // By default, include all mooncakes from mooncakes.io
      // And run all the backends x OS matrix
      for (const mooncake of mooncakes.keys()) {
        if (exclude.exclude.some((m) => m === mooncake)) {
          console.warn(`Skipping excluded mooncake: ${mooncake}`);
          continue;
        }

        // If there are any specific configuration in repos.yml, follow it
        const configs = repos.mooncakes.filter((m) => m.name === mooncake);
        if (configs.length > 1) {
          for (const config of configs) {
            repoList.push({
              type: 'mooncakesio',
              name: mooncake,
              version: config.version,
              runningOs: config.running_os || defaultRunningOs,
              runningBackend: config.running_backend || defaultRunningBackend,
            });
          }
        } else {
          repoList.push({
            type: 'mooncakesio',
            name: mooncake,
            version: mooncakes.getLatestVersion(mooncake),
            runningOs: defaultRunningOs,
            runningBackend: defaultRunningBackend,
          });
        }
      }
    }
  } catch (error) {
    throw new Error(`Failed to get mooncake sources: ${error}`);
  }
  console.info(`Total mooncake sources to process: ${repoList.length}`);
  return repoList;
}

export async function statMooncake(
  workdir: string,
  source: Mooncake,
  command: MoonCommand,
  backend: Backend,
): Promise<Result> {
  try {
    const startTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
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

    return {
      status,
      start_time: startTime,
      elapsed: result.duration,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    console.error(`RUN moon ${command} for ${JSON.stringify(source)}`, error);
    const now = new Date();
    const startTime = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    return {
      status: Status.Failure,
      start_time: startTime,
      elapsed: 0,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runMatrix(
  workdir: string,
  source: Mooncake,
  runningOs: OS[],
  runningBackend: Backend[],
): Promise<CBT> {
  const currentOs = Deno.build.os;
  let shouldRun = false;

  for (const os of runningOs) {
    if (
      (os === currentOs) || (os === 'macos' && currentOs === 'darwin')
    ) {
      shouldRun = true;
      break;
    }
  }

  const result = {
    check: {
      wasm: SKIPPED,
      'wasm-gc': SKIPPED,
      js: SKIPPED,
      native: SKIPPED,
    },
    build: {
      wasm: SKIPPED,
      'wasm-gc': SKIPPED,
      js: SKIPPED,
      native: SKIPPED,
    },
    test: {
      wasm: SKIPPED,
      'wasm-gc': SKIPPED,
      js: SKIPPED,
      native: SKIPPED,
    },
  };

  if (shouldRun) {
    await Promise.all(runningBackend.map(async (backend) => {
      for (const command of ['check', 'build', 'test'] as MoonCommand[]) {
        result[command][backend] = await statMooncake(
          workdir,
          source,
          command,
          backend,
        );
        if (result[command][backend].status === Status.Failure) {
          break;
        }
      }
    }));
  }

  return result;
}

export async function build(source: Mooncake): Promise<BuildResult> {
  const tmp = await Deno.makeTempDir();
  try {
    if (source.type === 'git') {
      try {
        await gitCloneTo(source.url, tmp, source.rev, tmp);
        await runMoon(tmp, ['install']);
        const cbt = await runMatrix(
          tmp,
          source,
          source.runningOs,
          source.runningBackend,
        );
        return {
          source: {
            type: 'git',
            url: source.url,
            rev: source.rev,
          },
          cbt: cbt,
        };
      } catch (error) {
        console.error(`Failed to checkout ${source.rev}:`, error);
        return {
          source: {
            type: 'git',
            url: source.url,
            rev: source.rev,
          },
          error: (error as Error).message,
        };
      }
    } else {
      try {
        await downloadTo(source.name, source.version, tmp);
        await runMoon(tmp, ['install']);
        const cbt = await runMatrix(
          tmp,
          source,
          source.runningOs,
          source.runningBackend,
        );
        return {
          source: {
            type: 'mooncakes',
            name: source.name,
            version: source.version,
          },
          cbt: cbt,
        };
      } catch (error) {
        console.error(`Failed to download ${source.name}@${source.version}:`, error);
        return {
          source: {
            type: 'mooncakes',
            name: source.name,
            version: source.version,
          },
          error: (error as Error).message,
        };
      }
    }
  } finally {
    try {
      await Deno.remove(tmp, { recursive: true });
    } catch {
      // 忽略清理失败
    }
  }
}

export async function stat(cmd: StatSubcommand): Promise<{ metadata: MetaData; result: BuildResult[] }> {
  const runId = Deno.env.get('GITHUB_ACTION_RUN_ID') || '0';
  const runNumber = Deno.env.get('GITHUB_ACTION_RUN_NUMBER') || '0';

  const startTime = new Date().toISOString();

  try {
    const moonVersion = await getMoonVersion();
    const toolchain: ToolChainVersion = moonVersion;

    const mooncakeSources = await getMooncakeSources(cmd);
    const buildResult = await Promise.all(mooncakeSources.map((source) => build(source)));

    return {
      metadata: { runId, runNumber, startTime, toolchainVersion: toolchain },
      result: buildResult,
    };
  } catch (error) {
    throw new Error('Failed to run stat command', { cause: error });
  }
}
