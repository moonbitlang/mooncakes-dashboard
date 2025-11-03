import { Backend, type Mooncake, MoonCommand } from './types.ts';
import { join } from '@std/path/join';

// 原 core.ts 中的工具函数抽离：sha256Hex / makeLogSlug / writeLogFiles

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const arr = Array.from(new Uint8Array(digest));
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function makeLogSlug(source: Mooncake): Promise<string> {
  const base = source.type === 'git'
    ? `${source.type}|${source.url}|${source.rev}`
    : `${source.type}|${source.name}|${source.version}`;
  const hash = await sha256Hex(base);
  return `${hash.slice(0, 16)}`;
}

export async function writeLogFiles(
  slug: string,
  dir: string,
  command: MoonCommand,
  backend: Backend,
  stdout: string,
  stderr: string,
): Promise<{ stdout_path: string; stderr_path: string }> {
  try {
    await Deno.mkdir(join(dir, 'logs'), { recursive: true });
  } catch (e) {
    if (!(e instanceof Deno.errors.AlreadyExists)) {
      throw e;
    }
  }
  const stdoutPath = join(dir, 'logs', `${slug}-${backend}-${command}.out.log`);
  const stderrPath = join(dir, 'logs', `${slug}-${backend}-${command}.err.log`);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(stdoutPath, stdout).catch((e) => console.error('Failed to write stdout log', stdoutPath, e));
  await Deno.writeTextFile(stderrPath, stderr).catch((e) => console.error('Failed to write stderr log', stderrPath, e));
  return { stdout_path: stdoutPath, stderr_path: stderrPath };
}
