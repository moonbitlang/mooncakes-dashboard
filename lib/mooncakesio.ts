// Mooncakes.io 操作模块,对应 Rust 版本中的 mooncakesio.rs
import { join, relative } from '@std/path';
import { TextLineStream } from '@std/streams';
import { JsonParseStream } from '@std/json';
import * as fs from '@std/fs';
import { BlobReader, BlobWriter, ZipReader } from '@zip-js/zip-js';

const BASE_URL = 'https://moonbitlang-mooncakes.s3.us-west-2.amazonaws.com/user';

export async function downloadTo(
  name: string,
  version: string,
  dst: string,
): Promise<void> {
  const versionEnc = encodeURIComponent(version);
  const url = `${BASE_URL}/${name}/${versionEnc}.zip`;
  const outputDir = dst;

  try {
    // 创建目标目录
    await Deno.mkdir(outputDir, { recursive: true });

    // 使用 fetch 下载文件
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download ${name}@${version}: ${response.status} ${response.statusText}`);
    }

    // 获取 zip 文件内容
    const zipBlob = await response.blob();

    // 使用 zip-js 解压文件
    const zipReader = new ZipReader(new BlobReader(zipBlob));
    const entries = await zipReader.getEntries();

    // 解压所有文件
    for (const entry of entries) {
      const entryPath = join(outputDir, entry.filename);

      if (entry.directory) {
        // 创建目录
        await Deno.mkdir(entryPath, { recursive: true });
      } else {
        // 确保父目录存在
        const parentDir = join(entryPath, '..');
        await Deno.mkdir(parentDir, { recursive: true });

        // 提取文件内容
        const blobWriter = new BlobWriter();
        const blob = await entry.getData!(blobWriter);
        const arrayBuffer = await blob.arrayBuffer();

        // 写入文件
        await Deno.writeFile(entryPath, new Uint8Array(arrayBuffer));
      }
    }

    await zipReader.close();
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
      const name = relative(indexDir, entry.path).replace(/\.index$/, '').replaceAll('\\', '/');

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
