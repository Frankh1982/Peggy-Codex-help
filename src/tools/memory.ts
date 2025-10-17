import { promises as fs } from 'fs';
import path from 'path';
import { readUtf8, writeAtomic, mkdirp } from '../lib/fsutil.js';
import { logEvent } from '../lib/logging.js';

const ROOTS = [path.normalize('memory/user'), path.normalize('memory/agent')];

function assertPath(relPath: string) {
  const normalized = path.normalize(relPath);
  if (!ROOTS.some((root) => normalized.startsWith(root))) {
    throw new Error('Path outside permitted memory roots');
  }
  return normalized;
}

export async function read_file(args: { path: string }) {
  const rel = assertPath(args.path);
  const abs = path.join(process.cwd(), rel);
  let content = '';
  try {
    content = await readUtf8(abs);
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
  await logEvent({ type: 'memory.read', payload: { path: rel } });
  return { path: rel, content };
}

export async function write_file(args: { path: string; mode: 'overwrite' | 'append'; content: string }) {
  const rel = assertPath(args.path);
  const abs = path.join(process.cwd(), rel);
  await mkdirp(path.dirname(abs));
  if (args.mode === 'append') {
    let existing = '';
    try {
      existing = await readUtf8(abs);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }
    await writeAtomic(abs, existing + args.content);
  } else {
    await writeAtomic(abs, args.content);
  }
  await logEvent({ type: 'memory.write', payload: { path: rel, mode: args.mode } });
  return { path: rel, mode: args.mode };
}

export async function list_dir(args: { dir: string }) {
  const rel = assertPath(args.dir);
  const abs = path.join(process.cwd(), rel);
  await mkdirp(abs);
  const entries = await fs.readdir(abs);
  await logEvent({ type: 'memory.list', payload: { dir: rel } });
  return { dir: rel, entries };
}
