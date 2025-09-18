// 自动更新 mooncakes 列表功能，对应 Rust 版本中的 auto_update.rs
import { type ExcludeConfig, ExcludeConfigSchema, type ReposConfig, ReposConfigSchema } from './types.ts';
import * as yaml from '@std/yaml';

// 解析排除配置文件
export async function getExcludeConfig(
  filePath: string,
): Promise<ExcludeConfig> {
  try {
    const content = await Deno.readTextFile(filePath);
    return ExcludeConfigSchema.parse(yaml.parse(content));
  } catch (error) {
    console.warn(`Failed to read exclude config from ${filePath}: ${error}`);
    return { exclude: [] };
  }
}

export async function getReposConfig(filePath: string): Promise<ReposConfig> {
  try {
    const content = await Deno.readTextFile(filePath);
    return ReposConfigSchema.parse(yaml.parse(content));
  } catch (error) {
    throw new Error(`Failed to read repos config from ${filePath}: ${error}`);
  }
}
