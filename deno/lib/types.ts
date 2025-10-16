// 类型定义，对应 Rust 版本中的 dashboard.rs
import { z } from 'zod';

// Configurations for modules to be skipped
export const ExcludeConfigSchema = z.object({
  exclude: z.array(z.string()),
});

export type ExcludeConfig = z.infer<typeof ExcludeConfigSchema>;

// Configuration for repositories
export const BackendSchema = z.enum(['wasm', 'wasm-gc', 'js', 'native']);
export type Backend = z.infer<typeof BackendSchema>;

export const OSSchema = z.enum(['linux', 'macos', 'windows']);
export type OS = z.infer<typeof OSSchema>;

export const GitHubSourceSchema = z.object({
  name: z.string(),
  link: z.url(),
  branch: z.string(),
  running_os: z.array(OSSchema).optional(),
  running_backend: z.array(BackendSchema).optional(),
});

export const MooncakeSourceSchema = z.object({
  name: z.string(),
  version: z.string(),
  running_os: z.array(OSSchema).optional(),
  running_backend: z.array(BackendSchema).optional(),
});

export const ReposConfigSchema = z.object({
  'github-repos': z.array(GitHubSourceSchema),
  mooncakes: z.array(MooncakeSourceSchema),
});

export type ReposConfig = z.infer<typeof ReposConfigSchema>;

export type GitHubRepo = z.infer<typeof GitHubSourceSchema>;
export type MooncakeRepo = z.infer<typeof MooncakeSourceSchema>;

export enum Status {
  Success = 'Success',
  Failure = 'Failure',
  Skipped = 'Skipped',
}

export interface MoonBitModule {
  type: 'mooncakesio' | 'git';
  runningOs: OS[];
  runningBackend: Backend[];
}

export interface MooncakesModule extends MoonBitModule {
  type: 'mooncakesio';
  name: string;
  version: string[];
}

export interface GitModule extends MoonBitModule {
  type: 'git';
  url: string;
  rev: string[];
}

export type Mooncake = MooncakesModule | GitModule;

export type MoonCommand = 'check' | 'build' | 'test';

export interface ExecuteResult {
  status: Status;
}

export interface SuccessResult extends ExecuteResult {
  status: Status.Success;
  start_time: string;
  elapsed: number;
  stdout: string;
  stderr: string;
}

export interface FailureResult extends ExecuteResult {
  status: Status.Failure;
  start_time: string;
  elapsed: number;
  stdout: string;
  stderr: string;
}

export interface SkippedResult extends ExecuteResult {
  status: Status.Skipped;
}

export type Result = SuccessResult | FailureResult | SkippedResult;

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
  stdout: string;
  stderr: string;
  success: boolean;
}

export const SKIPPED: Result = {
  status: Status.Skipped,
};
