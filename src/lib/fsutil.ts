import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

export async function readUtf8(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

export async function mkdirp(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function writeAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdirp(dir);
  const tmpFile = path.join(tmpdir(), `peggy-${randomUUID()}`);
  await fs.writeFile(tmpFile, content, 'utf8');
  await fs.rename(tmpFile, filePath);
}

export function rollByDate(prefix: string, ext: string): string {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `${prefix}-${stamp}.${ext}`;
}
