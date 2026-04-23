import {
  Backend,
  BuildConfigs,
  BuildResult,
  CBT,
  Channel,
  Mooncake,
  MoonCommand,
  MoonExecution,
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
  channel: Channel,
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

async function matchWarningFailuresInLogs(execution: MoonExecution): Promise<string[]> {
  const matches = new Set<string>();

  for (const path of [execution.stdout_path, execution.stderr_path]) {
    for (const matched of await matchWarningFailuresInFile(path)) {
      matches.add(matched);
    }
  }

  return Array.from(matches);
}

async function executeLoggedMoonCommand(
  workdir: string,
  source: Mooncake,
  dir: string,
  command: MoonCommand,
  backend: Backend,
  channel: Channel,
): Promise<MoonExecution> {
  const slug = await makeLogSlug(source);
  const paths = await prepareLogFiles(slug, dir, command, backend);
  return await runMoon(
    workdir,
    getMoonArgs(command, backend, channel),
    paths.stdout_path,
    paths.stderr_path,
  );
}

async function probeWarningOnlyFailure(
  workdir: string,
  backend: Backend,
  channel: Channel,
  execution: MoonExecution,
): Promise<string[] | null> {
  const matchedWarnings = await matchWarningFailuresInLogs(execution);
  if (matchedWarnings.length === 0) {
    return null;
  }

  const probeStdoutPath = await Deno.makeTempFile({ suffix: '.moon-check-probe.out.log' });
  const probeStderrPath = await Deno.makeTempFile({ suffix: '.moon-check-probe.err.log' });

  try {
    const probe = await runMoon(
      workdir,
      getMoonArgs('check', backend, channel, false),
      probeStdoutPath,
      probeStderrPath,
    );
    return probe.success ? matchedWarnings : null;
  } catch (_error) {
    // Treat probe failures conservatively as real check failures.
    return null;
  } finally {
    await Deno.remove(probeStdoutPath).catch(() => {});
    await Deno.remove(probeStderrPath).catch(() => {});
  }
}

async function classifyCheckExecution(
  workdir: string,
  backend: Backend,
  channel: Channel,
  execution: MoonExecution,
): Promise<
  { status: Status.Success } | { status: Status.Failure } | {
    status: Status.WarningFailure;
    matchedWarnings: string[];
  }
> {
  if (execution.success) {
    return { status: Status.Success };
  }

  if (channel === 'stable') {
    return { status: Status.Failure };
  }

  const matchedWarnings = await probeWarningOnlyFailure(workdir, backend, channel, execution);
  if (matchedWarnings !== null) {
    return { status: Status.WarningFailure, matchedWarnings };
  }

  return { status: Status.Failure };
}

function classifyExecution(execution: MoonExecution): { status: Status.Success } | { status: Status.Failure } {
  if (execution.success) {
    return { status: Status.Success };
  }

  return { status: Status.Failure };
}

function toResult(
  startTime: string,
  execution: MoonExecution,
  classified: { status: Status.Success } | { status: Status.Failure } | {
    status: Status.WarningFailure;
    matchedWarnings: string[];
  },
): Result {
  if (classified.status === Status.WarningFailure) {
    return {
      status: Status.WarningFailure,
      start_time: startTime,
      elapsed: execution.duration,
      stdout_path: execution.stdout_path,
      stderr_path: execution.stderr_path,
      matchedWarnings: classified.matchedWarnings,
    };
  }

  return {
    status: classified.status,
    start_time: startTime,
    elapsed: execution.duration,
    stdout_path: execution.stdout_path,
    stderr_path: execution.stderr_path,
  };
}

async function writeExecutionFailure(
  source: Mooncake,
  dir: string,
  command: MoonCommand,
  backend: Backend,
  error: unknown,
): Promise<{ stdout_path: string; stderr_path: string }> {
  const slug = await makeLogSlug(source);
  const paths = await prepareLogFiles(slug, dir, command, backend);
  await writeLogFiles(slug, dir, command, backend, '', error instanceof Error ? error.message : String(error));
  return paths;
}

export async function statMooncake(
  workdir: string,
  source: Mooncake,
  command: MoonCommand,
  backend: Backend,
  dir: string,
  channel: Channel,
): Promise<Result> {
  const startTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  try {
    const execution = await executeLoggedMoonCommand(workdir, source, dir, command, backend, channel);
    const classified = command === 'check'
      ? await classifyCheckExecution(workdir, backend, channel, execution)
      : classifyExecution(execution);
    return toResult(startTime, execution, classified);
  } catch (error) {
    console.error(`RUN moon ${command} for ${JSON.stringify(source)}`, error);
    const paths = await writeExecutionFailure(source, dir, command, backend, error);
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
  channel: Channel,
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
  channel: Channel,
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
