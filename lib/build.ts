import {
  Backend,
  BuildConfigs,
  BuildResult,
  CBT,
  CommandOutput,
  Mooncake,
  MoonCommand,
  Result,
  SKIPPED,
  Status,
} from './types.ts';
import { runMoon } from './moon.ts';
import { gitCloneTo } from './git.ts';
import { downloadTo } from './mooncakesio.ts';
import { makeLogSlug, prepareLogFiles, writeLogFiles } from './log.ts';
import { findBuildConfig } from './source.ts';
import { join } from '@std/path';

// 从 core.ts 抽离：statMooncake / runMatrix / build （实现保持原样）

const WARNING_FAILURE_PATTERNS = [
  { id: '@deprecated', pattern: /@deprecated\b/i },
  { id: 'deprecated', pattern: /\bdeprecated\b/i },
] as const;

function getMoonArgs(
  command: MoonCommand,
  backend: Backend,
  channel: 'stable' | 'nightly' | 'pre-release',
  includeWarnList = true,
): string[] {
  return [
    command,
    '--target',
    backend,
    '--frozen',
    '--target-dir',
    `target/${backend}`,
    ...(command === 'test' ? ['--build-only'] : []),
    ...(includeWarnList && (channel === 'nightly' || channel === 'pre-release') ? ['--warn-list', '@deprecated'] : []),
  ];
}

function matchWarningFailures(output: string): string[] {
  const matches = new Set<string>();
  for (const { id, pattern } of WARNING_FAILURE_PATTERNS) {
    if (pattern.test(output)) {
      matches.add(id);
    }
  }
  return Array.from(matches);
}

async function matchWarningFailuresInFile(path: string): Promise<string[]> {
  const file = await Deno.open(path, { read: true });
  const decoder = new TextDecoder();
  const chunk = new Uint8Array(8192);
  const matches = new Set<string>();
  let rest = '';

  try {
    while (true) {
      const read = await file.read(chunk);
      if (read === null) {
        break;
      }

      const text = rest + decoder.decode(chunk.subarray(0, read), { stream: true });
      const tailLength = 32;
      const searchable = text.slice(0, Math.max(0, text.length - tailLength));
      for (const matched of matchWarningFailures(searchable)) {
        matches.add(matched);
      }
      rest = text.slice(-tailLength);
    }

    const text = rest + decoder.decode();
    for (const matched of matchWarningFailures(text)) {
      matches.add(matched);
    }
  } finally {
    file.close();
  }

  return Array.from(matches);
}

async function matchWarningFailuresInLogs(result: CommandOutput): Promise<string[]> {
  const matches = new Set<string>();

  for (const path of [result.stdout_path, result.stderr_path]) {
    for (const matched of await matchWarningFailuresInFile(path)) {
      matches.add(matched);
    }
  }

  return Array.from(matches);
}

async function classifyStatus(
  workdir: string,
  backend: Backend,
  command: MoonCommand,
  channel: 'stable' | 'nightly' | 'pre-release',
  result: CommandOutput,
): Promise<
  { status: Status.Success } | { status: Status.Failure } | {
    status: Status.WarningFailure;
    matchedWarnings: string[];
  }
> {
  if (result.success) {
    return { status: Status.Success };
  }

  const usesWarnList = channel === 'nightly' || channel === 'pre-release';
  if (usesWarnList && command === 'check') {
    const matchedWarnings = await matchWarningFailuresInLogs(result);
    if (matchedWarnings.length > 0) {
      const rerunStdoutPath = await Deno.makeTempFile({ suffix: '.moon-check-rerun.out.log' });
      const rerunStderrPath = await Deno.makeTempFile({ suffix: '.moon-check-rerun.err.log' });
      try {
        const rerun = await runMoon(
          workdir,
          getMoonArgs('check', backend, channel, false),
          rerunStdoutPath,
          rerunStderrPath,
        );
        if (rerun.success) {
          return { status: Status.WarningFailure, matchedWarnings };
        }
      } catch (_error) {
        // Treat rerun failures conservatively as real check failures.
      } finally {
        await Deno.remove(rerunStdoutPath).catch(() => {});
        await Deno.remove(rerunStderrPath).catch(() => {});
      }
    }
  }

  return { status: Status.Failure };
}

export async function statMooncake(
  workdir: string,
  source: Mooncake,
  command: MoonCommand,
  backend: Backend,
  dir: string,
  channel: 'stable' | 'nightly' | 'pre-release',
): Promise<Result> {
  const startTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const slug = await makeLogSlug(source);
  const paths = await prepareLogFiles(slug, dir, command, backend);
  try {
    const result = await runMoon(
      workdir,
      getMoonArgs(command, backend, channel),
      paths.stdout_path,
      paths.stderr_path,
    );
    const classified = await classifyStatus(workdir, backend, command, channel, result);
    if (classified.status === Status.WarningFailure) {
      return {
        status: Status.WarningFailure,
        start_time: startTime,
        elapsed: result.duration,
        stdout_path: paths.stdout_path,
        stderr_path: paths.stderr_path,
        matchedWarnings: classified.matchedWarnings,
      };
    }
    return {
      status: classified.status,
      start_time: startTime,
      elapsed: result.duration,
      stdout_path: paths.stdout_path,
      stderr_path: paths.stderr_path,
    };
  } catch (error) {
    console.error(`RUN moon ${command} for ${JSON.stringify(source)}`, error);
    await writeLogFiles(slug, dir, command, backend, '', error instanceof Error ? error.message : String(error));
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
  channel: 'stable' | 'nightly' | 'pre-release',
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
          channel,
        );
        if (
          result[command][backend].status === Status.Failure ||
          result[command][backend].status === Status.WarningFailure
        ) {
          break;
        }
      }
    }
  }

  return result;
}

export async function build(
  source: Mooncake,
  dir: string,
  build_config: BuildConfigs,
  channel: 'stable' | 'nightly' | 'pre-release',
): Promise<BuildResult> {
  const tmp = await Deno.makeTempDir();

  try {
    if (source.type === 'git') {
      try {
        await gitCloneTo(source.url, tmp, source.rev, tmp);
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
          channel,
        );
        return { source: { type: 'git', url: source.url, rev: source.rev }, cbt };
      } catch (error) {
        console.error(`Failed to checkout ${source.rev}:`, error);
        return { source: { type: 'git', url: source.url, rev: source.rev }, error: (error as Error).message };
      }
    } else {
      try {
        await downloadTo(source.name, source.version, tmp);
        const buildConfig = findBuildConfig(source.name, source.version, build_config.configs);
        const cbt = await runMatrix(
          tmp,
          source,
          buildConfig.running_os,
          buildConfig.running_backend,
          dir,
          channel,
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
