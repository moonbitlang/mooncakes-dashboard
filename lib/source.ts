import { type Backend, backends, type BuildConfig, type Mooncake, OS, oses } from './types.ts';
import { StatSubcommand } from './cli.ts';
import { getSourcesConfig } from './utils.ts';
import { getAllMooncakes } from './mooncakesio.ts';
import * as semver from '@std/semver';

/**
 * Find build configuration for a package
 */
export function findBuildConfig(
  packageName: string,
  version: string,
  buildConfigs: BuildConfig[],
): { 'running_os': OS[]; 'running_backend': Backend[] } {
  // Find configs that match this package
  const matchingConfigs = buildConfigs.filter((config) => config.package === packageName);

  // Find the first config where the version matches the constraint
  for (const config of matchingConfigs) {
    try {
      const range = semver.parseRange(config.version);
      const semVersion = semver.parse(version);
      if (semver.satisfies(semVersion, range)) {
        return {
          running_os: config.running_os ?? oses,
          running_backend: config.running_backend ?? backends,
        };
      }
    } catch {
      console.error(
        `Failed to parse version or range for package ${packageName} with version ${version} and config version ${config.version}`,
      );
      continue;
    }
  }
  return {
    running_os: oses,
    running_backend: backends,
  };
}

/**
 * 获取待处理的 Mooncake 数据源列表。
 * Loads sources from sources.yml and applies build configs from build-config.yml
 */
export async function getMooncakeSources(
  cmd: StatSubcommand,
): Promise<Mooncake[]> {
  const repoList: Mooncake[] = [];

  try {
    const sources = await getSourcesConfig(cmd.sources || 'resources/sources.yml');
    const mooncakes = await getAllMooncakes();

    if (sources.include_all_mooncakes) {
      for (const key of mooncakes.keys()) {
        if (sources.exclude.includes(key)) {
          continue;
        }
        try {
          repoList.push({
            type: 'mooncakesio',
            name: key,
            version: semver.format(mooncakes.getLatestVersion(key).version),
          });
        } catch {
          console.error(
            `Failed to get latest version for mooncake: ${key}`,
            mooncakes.getVersions(key).map((v) => semver.format(v.version)),
          );
          continue;
        }
      }
    }

    for (const gitRepo of sources['git-repos']) {
      repoList.push({
        type: 'git',
        url: gitRepo.link,
        rev: gitRepo.branch,
      });
    }

    for (const included of sources.mooncakes) {
      if (sources.exclude.includes(included.name)) {
        continue;
      }
      try {
        const range = semver.parseRange(included.version || '*');
        const versions = mooncakes.getVersions(included.name).map((v) => v.version);
        repoList.push({
          type: 'mooncakesio',
          name: included.name,
          version: semver.format(semver.maxSatisfying(versions, range)!),
        });
      } catch {
        console.error(
          `Failed to parse version range for included mooncake: ${included.name} with version constraint: ${included.version}`,
        );
        continue;
      }
    }
  } catch (error) {
    throw new Error(`Failed to get mooncake sources: ${error}`);
  }

  console.info(`Total mooncake sources to process: ${repoList.length}`);
  return repoList;
}
