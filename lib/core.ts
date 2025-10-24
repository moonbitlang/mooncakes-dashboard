/// <reference lib="deno.ns" />

// 核心业务逻辑模块，对应 Rust 版本中的 main.rs 核心功能
import { BuildResult, MetaData, type ToolChainVersion } from './types.ts';
import { StatSubcommand } from './cli.ts';
import { getMoonVersion } from './moon.ts';
import { getMooncakeSources } from './source.ts';
import { build } from './build.ts';

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
