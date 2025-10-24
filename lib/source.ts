import { Backend, OS, type Mooncake } from './types.ts';
import { StatSubcommand } from './cli.ts';
import { getExcludeConfig, getReposConfig } from './utils.ts';
import { getAllMooncakes } from './mooncakesio.ts';

/**
 * 获取待处理的 Mooncake 数据源列表。
 * 逻辑来源自原 `core.ts` 中的 `getMooncakeSources`，实现未改动，仅抽离文件。
 */
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

    // White list github repos; no need to exclude
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
      // Debug: only process listed mooncakes
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
      // Include all mooncakes from mooncakes.io by default
      for (const mooncake of mooncakes.keys()) {
        if (exclude.exclude.some((m) => m === mooncake)) {
          console.warn(`Skipping excluded mooncake: ${mooncake}`);
          continue;
        }
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
