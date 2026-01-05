/// <reference lib="deno.ns" />

// 核心业务逻辑模块，对应 Rust 版本中的 main.rs 核心功能
import { BuildResult, MetaData, type ToolChainVersion } from './types.ts';
import { StatSubcommand } from './cli.ts';
import { getMoonVersion } from './moon.ts';
import { getMooncakeSources } from './source.ts';
import { build } from './build.ts';
import { executeWithConcurrency, getBuildConfigs } from './utils.ts';

// 默认最大并发构建数量，可通过环境变量 MAX_CONCURRENT_BUILDS 覆盖
const DEFAULT_MAX_CONCURRENT_BUILDS = 3;

export async function stat(cmd: StatSubcommand, dir: string): Promise<{ metadata: MetaData; result: BuildResult[] }> {
  const runId = Deno.env.get('GITHUB_ACTION_RUN_ID') || '0';
  const runNumber = Deno.env.get('GITHUB_ACTION_RUN_NUMBER') || '0';

  // 优先使用 CLI 参数，其次是环境变量，最后是默认值
  const maxConcurrentBuilds = cmd.maxConcurrentBuilds ??
    parseInt(Deno.env.get('MAX_CONCURRENT_BUILDS') || String(DEFAULT_MAX_CONCURRENT_BUILDS), 10);
  const configs = await getBuildConfigs(cmd.buildConfig || 'resources/build-config.yml');

  const startTime = new Date().toISOString();

  try {
    const moonVersion = await getMoonVersion();
    const toolchain: ToolChainVersion = moonVersion;

    const mooncakeSources = await getMooncakeSources(cmd);

    const buildResult = await executeWithConcurrency(
      mooncakeSources.map((source) => () => build(source, dir, configs, cmd.channel)),
      maxConcurrentBuilds,
    );

    return {
      metadata: { runId, runNumber, startTime, toolchainVersion: toolchain },
      result: buildResult,
    };
  } catch (error) {
    throw new Error('Failed to run stat command', { cause: error });
  }
}
