// 自动更新 mooncakes 列表功能，对应 Rust 版本中的 auto_update.rs
import { type ExcludeConfig, ExcludeConfigSchema, type ReposConfig, ReposConfigSchema } from './types.ts';
import * as yaml from '@std/yaml';

/**
 * Execute an array of async tasks with controlled concurrency
 * Simple implementation using Promise.race to limit parallel execution
 *
 * 实现原理：
 * 1. 维护一个 executing Set，存储正在执行的 Promise
 * 2. 遍历所有任务，每次启动一个新任务
 * 3. 当正在执行的任务数达到并发限制时，使用 Promise.race 等待任何一个完成
 * 4. 任务完成后从 executing Set 中移除，为新任务腾出空间
 * 5. 保证结果数组的顺序与输入任务一致
 *
 * @param tasks Array of functions that return promises
 * @param concurrency Maximum number of tasks to run concurrently
 * @returns Array of results in the same order as input tasks
 */
export async function executeWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  const executing = new Set<Promise<void>>();

  for (let i = 0; i < tasks.length; i++) {
    const index = i;
    // 启动任务并保存结果到对应的索引位置
    const promise = tasks[index]().then((result) => {
      results[index] = result;
    });

    // 包装成一个在完成时从 Set 中移除自己的 Promise
    const wrappedPromise = promise.then(() => {
      executing.delete(wrappedPromise);
    });

    executing.add(wrappedPromise);

    // 如果达到并发限制，等待任意一个任务完成
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  // 等待所有剩余任务完成
  await Promise.all(executing);
  return results;
}

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
