// Mooncakes.io 操作模块，对应 Rust 版本中的 mooncakesio.rs
import { join, relative } from '@std/path';
import { TextLineStream } from '@std/streams';
import { JsonParseStream } from '@std/json';
import * as fs from '@std/fs';

const BASE_URL = 'https://moonbitlang-mooncakes.s3.us-west-2.amazonaws.com/user';

export async function downloadTo(
  name: string,
  version: string,
  dst: string,
): Promise<void> {
  const versionEnc = encodeURIComponent(version);
  const url = `${BASE_URL}/${name}/${versionEnc}.zip`;
  const outputZip = join(dst, `${version}.zip`);
  const outputDir = join(dst, version);

  try {
    // 创建目标目录
    await Deno.mkdir(outputDir, { recursive: true });

    // 检测操作系统并相应地下载和解压
    const osInfo = Deno.build.os;

    if (osInfo === 'windows') {
      // Windows PowerShell 版本
      const downloadProcess = new Deno.Command('powershell', {
        args: [
          '-Command',
          `Invoke-WebRequest -Uri '${url}' -OutFile '${outputZip}'`,
        ],
        stdout: 'piped',
        stderr: 'piped',
      });

      const downloadResult = await downloadProcess.output();
      if (downloadResult.code !== 0) {
        throw new Error(
          `Download failed with exit code ${downloadResult.code}`,
        );
      }

      const extractProcess = new Deno.Command('powershell', {
        args: [
          '-Command',
          `Expand-Archive -Path '${outputZip}' -DestinationPath '${outputDir}'`,
        ],
        stdout: 'piped',
        stderr: 'piped',
      });

      const extractResult = await extractProcess.output();
      if (extractResult.code !== 0) {
        throw new Error(`Extract failed with exit code ${extractResult.code}`);
      }
    } else {
      // Unix 版本 (Linux, macOS)
      const downloadProcess = new Deno.Command('curl', { args: ['-o', outputZip, url] });

      const downloadResult = await downloadProcess.output();
      if (downloadResult.code !== 0) {
        throw new Error(
          `Download failed with exit code ${downloadResult.code}`,
        );
      }

      const extractProcess = new Deno.Command('unzip', { args: [outputZip, '-d', outputDir] });

      const extractResult = await extractProcess.output();
      if (extractResult.code !== 0) {
        throw new Error(`Extract failed with exit code ${extractResult.code}`);
      }
    }
  } catch (error) {
    throw new Error(
      `Failed to download ${name}/${version}`,
      { cause: error },
    );
  }
}

function getMoonHome(): string {
  const moonHome = Deno.env.get('MOON_HOME');
  if (moonHome) {
    return moonHome;
  }

  const homeDir = Deno.env.get('HOME') || Deno.env.get('USERPROFILE');
  if (!homeDir) {
    console.error('Failed to get home directory');
    Deno.exit(1);
  }

  const moonPath = join(homeDir, '.moon');

  try {
    Deno.statSync(moonPath);
  } catch {
    Deno.mkdirSync(moonPath, { recursive: true });
  }

  return moonPath;
}

function getIndexPath(): string {
  return join(getMoonHome(), 'registry', 'index');
}

export interface MooncakeInfo {
  version: string;
  keywords?: string[];
}

export class MooncakesDB {
  public db: Map<string, string[]> = new Map();

  getLatestVersion(name: string): string {
    const versions = this.db.get(name);
    if (!versions || versions.length === 0) {
      throw new Error(`No versions found for mooncake: ${name}`);
    }
    return versions[versions.length - 1];
  }

  containsKey(name: string): boolean {
    return this.db.has(name);
  }

  keys(): IterableIterator<string> {
    return this.db.keys();
  }
}

export async function getAllMooncakes(): Promise<MooncakesDB> {
  const db = new MooncakesDB();
  const indexDir = join(getIndexPath(), 'user');

  try {
    // 递归遍历目录查找 .index 文件
    for await (
      const entry of fs.walk(indexDir, {
        exts: ['.index'],
        includeDirs: false,
      })
    ) {
      const name = relative(indexDir, entry.path).replace(/\.index$/, '');

      try {
        using indexContent = await Deno.open(entry.path);
        let isMooncakesTest = false;
        const indexes: string[] = [];
        await indexContent.readable
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(new TextLineStream())
          .pipeThrough(new JsonParseStream()).pipeTo(
            new WritableStream<any>({
              write(obj: MooncakeInfo) {
                indexes.push(obj.version);
                if (obj.keywords?.includes('mooncakes-test')) {
                  isMooncakesTest = true;
                }
              },
            }),
          );

        if (!isMooncakesTest) {
          db.db.set(name, indexes);
        }
      } catch (error) {
        console.error(`Failed to process index file ${entry.path}:`, error);
      }
    }
  } catch (error) {
    throw new Error(
      'Failed to read mooncakes database',
      { cause: error },
    );
  }

  return db;
}
