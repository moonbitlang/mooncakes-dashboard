// MoonBit 构建日志通用分析工具
// 支持搜索任意内容模式,如旧操作符重载、特定库使用等

import { JsonParseStream } from '@std/json';
import { TextLineStream } from '@std/streams';
import { BuildResult, FailureResult, Status, SuccessResult } from './types.ts';
import { join } from '@std/path/join';
import { exists } from '@std/fs/exists';
import { getAllMooncakes, MooncakesDB } from './mooncakesio.ts';

interface PackageInfo {
  name: string;
  patterns: Set<string>;
  platforms: Set<string>;
  logFiles: string[];
  logCount: number;
  repository?: string;
}

export interface AnalyzeOptions {
  patterns?: string[];
  predefined?: 'old_operators' | 'immut_list' | 'moonbitlang_core' | 'json_usage';
  regex?: boolean;
  csv?: string;
  dataDir: string;
  file?: string;
  githubOrgs?: string[];
}

/**
 * 预定义的搜索模式集合
 */
function getPredefinedPatterns(patternName: string): string[] {
  const patterns: Record<string, string[]> = {
    'old_operators': [
      'op_add',
      'op_sub',
      'op_mul',
      'op_div',
      'op_mod',
      'op_eq',
      'op_ne',
      'op_lt',
      'op_le',
      'op_gt',
      'op_ge',
      'op_and',
      'op_or',
      'op_not',
      'op_neg',
      'op_pos',
      'op_equal',
      'op_compare',
      'op_get',
      'op_shl',
      'op_shr',
    ],
    'immut_list': ['@immut/list'],
    'moonbitlang_core': ['@moonbitlang/core'],
    'json_usage': ['JSON', 'json', 'parse_json', 'to_json'],
    'view_usage': ['@string.View', '@bytes.View', '@array.View'],
  };
  return patterns[patternName] || [];
}

/**
 * 在日志文件中搜索指定模式
 */
async function searchPatternsInLog(
  logPath: string,
  patterns: string[],
  useRegex: boolean,
): Promise<Set<string>> {
  const foundPatterns = new Set<string>();

  if (!await exists(logPath)) {
    return foundPatterns;
  }

  try {
    const content = await Deno.readTextFile(logPath);

    for (const pattern of patterns) {
      if (useRegex) {
        const regex = new RegExp(pattern, 'mi');
        if (regex.test(content)) {
          foundPatterns.add(pattern);
        }
      } else {
        // 简单字符串匹配 (词边界)
        const escapedPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escapedPattern}\\b`, 'i');
        if (regex.test(content)) {
          foundPatterns.add(pattern);
        }
      }
    }
  } catch (_error) {
    // 忽略读取错误
  }

  return foundPatterns;
}

/**
 * 规范化仓库URL，移除 .git 后缀
 */
function normalizeRepositoryUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return url.endsWith('.git') ? url.slice(0, -4) : url;
}

/**
 * 从JSONL条目中提取包信息
 */
function getPackageInfo(
  entry: BuildResult,
  mooncakesDB?: MooncakesDB,
): { packageName: string; packageUrl: string; repository?: string } {
  const source = entry.source;

  if (source.type === 'git') {
    const packageUrl = source.url;
    const packageName = packageUrl.split('/').pop() || 'unknown';
    return { packageName, packageUrl, repository: normalizeRepositoryUrl(packageUrl) };
  } else if (source.type === 'mooncakes') {
    const packageName = source.name;
    const packageUrl = `mooncakes:${packageName}`;
    const repository = normalizeRepositoryUrl(mooncakesDB?.getRepository(packageName));
    return { packageName, packageUrl, repository };
  } else {
    return { packageName: 'unknown', packageUrl: 'unknown' };
  }
}

/**
 * 分析包中的指定模式使用
 */
async function analyzePackages(
  patterns: string[],
  useRegex: boolean,
  dataDir: string,
  mooncakesDB?: MooncakesDB,
): Promise<{
  problematicPackages: Map<string, PackageInfo>;
  totalPackages: number;
  totalLogsChecked: number;
}> {
  const problematicPackages = new Map<string, PackageInfo>();
  let totalPackages = 0;
  let totalLogsChecked = 0;

  console.log(`搜索模式: ${patterns.join(', ')}`);
  console.log(`使用正则表达式: ${useRegex ? '是' : '否'}`);
  console.log('开始分析...');

  // 遍历所有平台和版本
  for (const platform of ['linux', 'mac', 'windows']) {
    for (const version of ['stable', 'nightly']) {
      const platformDataDir = join(dataDir, platform, version);
      const jsonlFile = join(platformDataDir, 'data.jsonl');

      if (!await exists(jsonlFile)) {
        continue;
      }

      console.log(`处理 ${platform}/${version}...`);

      using file = await Deno.open(jsonlFile, { read: true });

      const lines: BuildResult[] = [];
      await file.readable
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TextLineStream())
        .pipeThrough(new JsonParseStream())
        .pipeTo(
          new WritableStream({
            write(chunk) {
              lines.push(chunk as unknown as BuildResult);
            },
          }),
        );

      for (const entry of lines) {
        // 跳过元数据行
        if (!('source' in entry)) {
          continue;
        }

        const { packageName, packageUrl, repository } = getPackageInfo(entry, mooncakesDB);
        totalPackages++;

        // 检查所有日志文件
        const cbt = entry.cbt;
        if (!cbt) continue;

        for (const phase of ['check', 'build', 'test'] as const) {
          const phaseData = cbt[phase];
          if (!phaseData) continue;

          for (const target of ['wasm', 'wasm-gc', 'js', 'native'] as const) {
            const targetData = phaseData[target];
            if (!targetData) continue;

            for (const logType of ['stdout_path', 'stderr_path'] as const) {
              if (targetData.status === Status.Skipped) continue;

              const result = targetData as SuccessResult | FailureResult;
              const logRelPath = result[logType];
              if (logRelPath) {
                const logFullPath = join(
                  platformDataDir,
                  logRelPath.replace(`data/${platform}/${version}/`, ''),
                );

                if (await exists(logFullPath)) {
                  totalLogsChecked++;
                  const foundPatterns = await searchPatternsInLog(
                    logFullPath,
                    patterns,
                    useRegex,
                  );

                  if (foundPatterns.size > 0) {
                    if (!problematicPackages.has(packageUrl)) {
                      problematicPackages.set(packageUrl, {
                        name: packageName,
                        patterns: new Set(),
                        platforms: new Set(),
                        logFiles: [],
                        logCount: 0,
                        repository,
                      });
                    }

                    const info = problematicPackages.get(packageUrl)!;
                    foundPatterns.forEach((p) => info.patterns.add(p));
                    info.platforms.add(`${platform}/${version}`);
                    info.logFiles.push(logFullPath);
                    info.logCount++;
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return { problematicPackages, totalPackages, totalLogsChecked };
}

/**
 * 打印分析结果
 */
function printResults(
  _patterns: string[],
  problematicPackages: Map<string, PackageInfo>,
  totalPackages: number,
  totalLogsChecked: number,
) {
  console.log('\n' + '='.repeat(80));
  console.log('分析结果');
  console.log('='.repeat(80));
  console.log(`总包数: ${totalPackages}`);
  console.log(`检查日志数: ${totalLogsChecked}`);
  console.log(`匹配的包数: ${problematicPackages.size}`);
  console.log(`匹配比例: ${(problematicPackages.size / totalPackages * 100).toFixed(1)}%`);

  if (problematicPackages.size === 0) {
    console.log('\n🎉 没有发现使用指定模式的包！');
    return;
  }

  // 统计模式使用
  const allPatterns = new Map<string, number>();
  for (const info of problematicPackages.values()) {
    for (const pattern of info.patterns) {
      allPatterns.set(pattern, (allPatterns.get(pattern) || 0) + 1);
    }
  }

  console.log('\n模式使用统计:');
  console.log('-'.repeat(40));
  const sortedPatterns = Array.from(allPatterns.entries()).sort((a, b) => b[1] - a[1]);
  for (const [pattern, count] of sortedPatterns) {
    console.log(`${pattern.padEnd(20)}: 在 ${count} 个包中使用`);
  }

  // 按使用频率排序显示详细信息
  const sortedPackages = Array.from(problematicPackages.entries()).sort((a, b) => b[1].logCount - a[1].logCount);

  console.log('\n匹配的包详细信息 (按匹配频率排序):');
  console.log('='.repeat(80));

  sortedPackages.forEach(([packageUrl, info], i) => {
    console.log(`${String(i + 1).padStart(2)}. ${info.name}`);
    console.log(`    仓库: ${packageUrl}`);
    if (info.repository && info.repository !== packageUrl) {
      console.log(`    源代码: ${info.repository}`);
    }
    console.log(`    匹配的模式: ${Array.from(info.patterns).sort().join(', ')}`);
    console.log(`    涉及平台: ${Array.from(info.platforms).sort().join(', ')}`);
    console.log(`    日志文件数: ${info.logCount}`);

    // 显示部分日志文件路径
    if (info.logFiles.length > 0 && info.logFiles.length <= 5) {
      console.log('    日志文件:');
      info.logFiles.forEach((logFile) => {
        console.log(`      - ${logFile}`);
      });
    } else if (info.logFiles.length > 5) {
      console.log('    日志文件 (显示前5个):');
      info.logFiles.slice(0, 5).forEach((logFile) => {
        console.log(`      - ${logFile}`);
      });
      console.log(`      ... 以及其他 ${info.logFiles.length - 5} 个文件`);
    }
    console.log();
  });
}

/**
 * 导出结果到CSV文件
 */
async function exportCsv(
  filename: string,
  problematicPackages: Map<string, PackageInfo>,
) {
  if (problematicPackages.size === 0) {
    console.log('没有数据可导出');
    return;
  }

  const lines: string[] = [];
  lines.push('包名,仓库URL,源代码仓库,匹配的模式,涉及平台,日志文件数');

  for (const [packageUrl, info] of problematicPackages.entries()) {
    const row = [
      info.name,
      packageUrl,
      info.repository || '',
      Array.from(info.patterns).sort().join('; '),
      Array.from(info.platforms).sort().join('; '),
      String(info.logCount),
    ];
    lines.push(row.map((field) => `"${field.replace(/"/g, '""')}"`).join(','));
  }

  await Deno.writeTextFile(filename, lines.join('\n'));
  console.log(`结果已导出到: ${filename}`);
}

/**
 * 检查仓库URL是否属于指定的GitHub组织
 */
function isFromGithubOrgs(repository: string | undefined, orgs: string[]): boolean {
  if (!repository) return false;

  // 规范化仓库URL，提取组织名
  const githubMatch = repository.match(/github\.com[\/:]([^\/]+)\//);
  if (!githubMatch) return false;

  const org = githubMatch[1];
  return orgs.includes(org);
}

/**
 * 输出需要修复的GitHub仓库列表
 */
function printGithubReposList(
  problematicPackages: Map<string, PackageInfo>,
  githubOrgs?: string[],
) {
  const repos = new Set<string>();

  for (const info of problematicPackages.values()) {
    if (info.repository) {
      // 如果指定了组织过滤，只添加匹配的仓库；否则添加所有仓库
      if (!githubOrgs || githubOrgs.length === 0 || isFromGithubOrgs(info.repository, githubOrgs)) {
        repos.add(info.repository);
      }
    }
  }

  if (repos.size === 0) {
    if (githubOrgs && githubOrgs.length > 0) {
      console.log(`\n🎉 没有在指定的GitHub组织 (${githubOrgs.join(', ')}) 中发现需要修复的仓库！`);
    } else {
      console.log('\n🎉 没有发现需要修复的仓库！');
    }
    return;
  }

  console.log('\n' + '='.repeat(80));
  if (githubOrgs && githubOrgs.length > 0) {
    console.log(`需要修复的GitHub仓库 (组织: ${githubOrgs.join(', ')})`);
  } else {
    console.log('需要修复的GitHub仓库');
  }
  console.log('='.repeat(80));
  console.log(`总数: ${repos.size}`);
  console.log();

  const sortedRepos = Array.from(repos).sort();
  sortedRepos.forEach((repo, i) => {
    console.log(`${String(i + 1).padStart(2)}. ${repo}`);
  });
  console.log();
}

/**
 * 简单分析模式 (原有的快速失败/慢速分析)
 */
async function simpleAnalyze(file: string) {
  const f = await Deno.open(file, { read: true });

  const results: BuildResult[] = [];

  await f.readable
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream())
    .pipeThrough(new JsonParseStream())
    .pipeTo(
      new WritableStream({
        write(chunk) {
          results.push(chunk as unknown as BuildResult);
        },
      }),
    );

  for (const result of results) {
    if (result.cbt) {
      for (const cmd of ['check', 'build', 'test'] as const) {
        const t = result.cbt[cmd];
        for (const backend of ['wasm', 'wasm-gc', 'js', 'native'] as const) {
          const r = t[backend];
          if (r.status === Status.Failure) {
            console.log(
              'failed',
              `${
                result.source.type === 'git' ? result.source.url + '@' + result.source.rev : result.source.name
              } - ${cmd} - ${backend}`,
            );
          }
          if (r.status === Status.Failure || r.status === Status.Success) {
            const execResult = r as SuccessResult | FailureResult;
            if (execResult.elapsed > 1000) {
              console.log(
                'slow',
                `${
                  result.source.type === 'git' ? result.source.url + '@' + result.source.rev : result.source.name
                } - ${cmd} - ${backend} - ${execResult.elapsed}ms`,
              );
            }
          }
        }
      }
    }
  }
}

/**
 * 主分析函数
 */
export async function analyze(options: AnalyzeOptions) {
  // 如果指定了 file 参数,使用简单分析模式
  if (options.file) {
    await simpleAnalyze(options.file);
    return;
  }

  // 确定搜索模式
  let patterns: string[];
  if (options.predefined) {
    patterns = getPredefinedPatterns(options.predefined);
    console.log(`使用预定义模式集合: ${options.predefined}`);
  } else if (options.patterns && options.patterns.length > 0) {
    patterns = options.patterns;
  } else {
    // 默认搜索旧操作符
    patterns = getPredefinedPatterns('old_operators');
    console.log('未指定模式，使用默认的旧操作符模式');
  }

  if (patterns.length === 0) {
    console.error('错误: 没有有效的搜索模式');
    Deno.exit(1);
  }

  // 加载 mooncakes 数据库以获取仓库信息
  console.log('加载 mooncakes 数据库...');
  let mooncakesDB: MooncakesDB | undefined;
  try {
    mooncakesDB = await getAllMooncakes();
    console.log(`已加载 ${Array.from(mooncakesDB.keys()).length} 个 mooncake 包的信息`);
  } catch (error) {
    console.warn('警告: 无法加载 mooncakes 数据库，将无法显示 mooncake 包的源代码仓库');
    console.warn('错误信息:', error);
  }

  const { problematicPackages, totalPackages, totalLogsChecked } = await analyzePackages(
    patterns,
    options.regex || false,
    options.dataDir,
    mooncakesDB,
  );

  printResults(patterns, problematicPackages, totalPackages, totalLogsChecked);

  // 输出需要修复的仓库列表（如果指定了 GitHub 组织，则只显示这些组织的仓库）
  printGithubReposList(problematicPackages, options.githubOrgs);

  if (options.csv) {
    await exportCsv(options.csv, problematicPackages);
  }
}
