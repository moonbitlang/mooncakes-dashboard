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
import { join } from '@std/path/join';

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

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const arr = Array.from(new Uint8Array(digest));
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function makeLogSlug(
  source: Mooncake,
): Promise<string> {
  const base = source.type === 'git'
    ? `${source.type}|${source.url}|${source.rev}`
    : `${source.type}|${source.name}|${source.version}`;
  const hash = await sha256Hex(base);
  return `${hash.slice(0, 16)}`;
}

async function writeLogFiles(
  slug: string,
  dir: string,
  command: MoonCommand,
  backend: Backend,
  stdout: string,
  stderr: string,
): Promise<{ stdout_path: string; stderr_path: string }> {
  try {
    await Deno.mkdir(join(dir, 'logs'), { recursive: true });
  } catch (e) {
    if (!(e instanceof Deno.errors.AlreadyExists)) {
      throw e;
    }
  }
  const stdoutPath = join(dir, 'logs', `${slug}-${backend}-${command}.out.log`);
  const stderrPath = join(dir, 'logs', `${slug}-${backend}-${command}.err.log`);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(stdoutPath, stdout).catch((e) => console.error('Failed to write stdout log', stdoutPath, e));
  await Deno.writeTextFile(stderrPath, stderr).catch((e) => console.error('Failed to write stderr log', stderrPath, e));
  // jsonl 中希望存储相对于 data/ 的路径，方便前端构造 URL
  return { stdout_path: stdoutPath, stderr_path: stderrPath };
}

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
  runningOs: OS[],
  runningBackend: Backend[],
  dir: string,
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
          dir,
        );
        if (result[command][backend].status === Status.Failure) {
          break;
        }
      }
    }));
  }

  return result;
}

export async function build(source: Mooncake, dir: string): Promise<BuildResult> {
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
          dir,
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
          dir,
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

export async function stat(cmd: StatSubcommand, dir: string): Promise<{ metadata: MetaData; result: BuildResult[] }> {
  const runId = Deno.env.get('GITHUB_ACTION_RUN_ID') || '0';
  const runNumber = Deno.env.get('GITHUB_ACTION_RUN_NUMBER') || '0';

  const startTime = new Date().toISOString();

  try {
    const moonVersion = await getMoonVersion();
    const toolchain: ToolChainVersion = moonVersion;

    const mooncakeSources = await getMooncakeSources(cmd);
    const buildResult = await Promise.all(mooncakeSources.map((source) => build(source, dir)));

    return {
      metadata: { runId, runNumber, startTime, toolchainVersion: toolchain },
      result: buildResult,
    };
  } catch (error) {
    throw new Error('Failed to run stat command', { cause: error });
  }
}
