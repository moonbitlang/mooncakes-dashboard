// 类型定义，对应 Rust 版本中的 dashboard.rs
import { z } from 'zod';

// ============================================
// Build Configuration (build-config.yml)
// ============================================

export const BackendSchema = z.enum(['wasm', 'wasm-gc', 'js', 'native']);
export type Backend = z.infer<typeof BackendSchema>;
export const backends = ['wasm', 'wasm-gc', 'js', 'native'] as Backend[];

export const OSSchema = z.enum(['linux', 'macos', 'windows']);
export type OS = z.infer<typeof OSSchema>;
export const oses = ['linux', 'macos', 'windows'] as OS[];

// Build configuration for a specific package/version combination
export const BuildConfigSchema = z.object({
  package: z.string().describe('Name of the package this build config applies to.'),
  version: z.string().describe(
    'Version constraint to match for this build config. See https://jsr.io/@std/semver#ranges for syntax.',
  ),
  running_os: z.array(OSSchema).optional().describe(
    'Operating systems to build on. If not specified, defaults to all supported OSes.',
  ),
  running_backend: z.array(BackendSchema).optional().describe(
    'Backends to build on. If not specified, defaults to all supported backends.',
  ),
});

export type BuildConfig = z.infer<typeof BuildConfigSchema>;

export const BuildConfigsSchema = z.object({
  configs: z.array(BuildConfigSchema),
});

export type BuildConfigs = z.infer<typeof BuildConfigsSchema>;

// ============================================
// Sources Selection (sources.yml)
// ============================================

// Git repository source
export const GitSourceSchema = z.object({
  name: z.string(),
  link: z.url(),
  branch: z.string(),
});

export type GitSource = z.infer<typeof GitSourceSchema>;

// Mooncake package source
export const MooncakeSourceSchema = z.object({
  name: z.string().describe('Name of the Mooncake package.'),
  version: z.string().default('*').describe("Version constraint to match. Default to '*'"),
});

export type MooncakeSource = z.infer<typeof MooncakeSourceSchema>;

export const SourcesSchema = z.object({
  'git-repos': z.array(GitSourceSchema).default([]).describe('List of Git repositories to include.'),
  mooncakes: z.array(MooncakeSourceSchema).default([]).describe('List of Mooncake packages to explicitly include.'),
  exclude: z.array(z.string()).default([]).describe('List of Mooncake packages to exclude.'),
  include_all_mooncakes: z.boolean().default(true).describe(
    'Whether to include all mooncakes from registry (default: true).',
  ),
});

export type Sources = z.infer<typeof SourcesSchema>;

export enum Status {
  Success = 'Success',
  Failure = 'Failure',
  WarningFailure = 'WarningFailure',
  Skipped = 'Skipped',
}

export interface MoonBitModule {
  type: 'mooncakesio' | 'git';
}

export interface MooncakesModule extends MoonBitModule {
  type: 'mooncakesio';
  name: string;
  version: string;
}

export interface GitModule extends MoonBitModule {
  type: 'git';
  url: string;
  rev: string;
}

export type Mooncake = MooncakesModule | GitModule;

export type MoonCommand = 'check' | 'build' | 'test';

export interface ExecuteResult {
  status: Status;
}

// Success/Failure 现在不再直接内嵌日志内容，改为引用日志路径，避免巨大 jsonl
export interface SuccessResult extends ExecuteResult {
  status: Status.Success;
  start_time: string;
  elapsed: number;
  // 相对于 data/ 目录的路径 (例如: logs/<slug>-check-wasm.out)
  stdout_path: string;
  stderr_path: string;
}

export interface FailureResult extends ExecuteResult {
  status: Status.Failure;
  start_time: string;
  elapsed: number;
  stdout_path: string;
  stderr_path: string;
}

export interface WarningFailureResult extends ExecuteResult {
  status: Status.WarningFailure;
  start_time: string;
  elapsed: number;
  stdout_path: string;
  stderr_path: string;
  matchedWarnings: string[];
}

export interface SkippedResult extends ExecuteResult {
  status: Status.Skipped;
}

export type Result = SuccessResult | FailureResult | WarningFailureResult | SkippedResult;

export interface BackendState extends Record<Backend, Result> {
  wasm: Result;
  'wasm-gc': Result;
  js: Result;
  native: Result;
}

export interface CBT extends Record<MoonCommand, BackendState> {
  check: BackendState;
  build: BackendState;
  test: BackendState;
}

export type ToolChainVersion = string[];

export interface MetaData {
  runId: string;
  runNumber: string;
  startTime: string;
  toolchainVersion: ToolChainVersion;
}

export type Source = {
  type: 'mooncakes';
  name: string;
  version: string;
} | {
  type: 'git';
  url: string;
  rev: string;
};

export type BuildResult = {
  source: Source;
  cbt?: CBT;
  error?: string;
};

export interface CommandOutput {
  duration: number;
  stdout_path: string;
  stderr_path: string;
  success: boolean;
}

export const SKIPPED: Result = {
  status: Status.Skipped,
};
