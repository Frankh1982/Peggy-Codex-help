import { promises as fs } from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { Action } from './schema.js';
import { writeAtomic, readUtf8, mkdirp, rollByDate } from '../lib/fsutil.js';
import { logEvent } from '../lib/logging.js';
import { web_search } from '../tools/brave.js';
import { buildCapsule } from '../../_system/make_capsule.js';

export type ExecutorEnv = {
  root?: string;
};

const CHAT_DIR = 'memory/chat';
const LEDGER_FILE = 'memory/agent/ledger.ndjson';

async function appendChat(payload: Record<string, unknown>) {
  const dir = CHAT_DIR;
  await mkdirp(dir);
  const file = path.join(dir, rollByDate('chat', 'ndjson'));
  await fs.appendFile(file, JSON.stringify({ t: new Date().toISOString(), ...payload }) + '\n', 'utf8');
}

function resolvePath(root: string, rel: string) {
  const normalized = path.normalize(rel);
  if (!normalized.startsWith('memory/agent') && !normalized.startsWith('memory/user')) {
    throw new Error(`Path not permitted: ${rel}`);
  }
  return path.join(root, normalized);
}

async function ensureFile(pathname: string) {
  await mkdirp(path.dirname(pathname));
}

export type ExecutionOutput =
  | { type: 'MEM.READ'; path: string; content: string }
  | { type: 'WEB.SEARCH'; query: string; results: Array<{ title: string; url: string; snippet: string }> }
  | { type: 'CAPSULE.REBUILD'; hash: string }
  | { type: 'ASSERT'; message: string }
  | { type: 'INFO'; message: string };

export type ExecutionResult = {
  outputs: ExecutionOutput[];
  citations: string[];
};

export async function execute(actions: Action[], env: ExecutorEnv = {}): Promise<ExecutionResult> {
  const root = env.root ?? process.cwd();
  const outputs: ExecutionOutput[] = [];
  const citations = new Set<string>();

  for (const action of actions) {
    switch (action.type) {
      case 'GOAL.SET': {
        const goalPath = path.join(root, 'memory/agent/goals.md');
        await writeAtomic(goalPath, action.goal.trim() + '\n');
        await logEvent({ type: 'goal.set', payload: { goal: action.goal } });
        await appendChat({ kind: 'goal.set', goal: action.goal });
        break;
      }
      case 'PLAN.ADD': {
        const planPath = path.join(root, 'memory/agent/plan.md');
        let current = '';
        try {
          current = await readUtf8(planPath);
        } catch (err: any) {
          if (err.code !== 'ENOENT') throw err;
        }
        const line = `- (${action.id}) ${action.text}`;
        const updated = current ? `${current.trimEnd()}\n${line}\n` : `${line}\n`;
        await writeAtomic(planPath, updated);
        await logEvent({ type: 'plan.add', payload: { id: action.id, text: action.text } });
        await appendChat({ kind: 'plan.add', id: action.id, text: action.text });
        break;
      }
      case 'PLAN.UPDATE': {
        const planPath = path.join(root, 'memory/agent/plan.md');
        let current = '';
        try {
          current = await readUtf8(planPath);
        } catch (err: any) {
          if (err.code !== 'ENOENT') throw err;
        }
        const lines = current.split(/\r?\n/).filter(Boolean);
        const prefix = `- (${action.id})`;
        let replaced = false;
        const rewritten = lines.map((line) => {
          if (line.startsWith(prefix)) {
            replaced = true;
            return `${prefix} ${action.text}`;
          }
          return line;
        });
        if (!replaced) {
          rewritten.push(`${prefix} ${action.text}`);
        }
        const updated = rewritten.join('\n') + '\n';
        await writeAtomic(planPath, updated);
        await logEvent({ type: 'plan.update', payload: { id: action.id, text: action.text } });
        await appendChat({ kind: 'plan.update', id: action.id, text: action.text });
        break;
      }
      case 'LEDGER.APPEND': {
        const ledgerPath = path.join(root, LEDGER_FILE);
        await ensureFile(ledgerPath);
        const entry = { id: nanoid(6), message: action.message, t: new Date().toISOString() };
        await fs.appendFile(ledgerPath, JSON.stringify(entry) + '\n', 'utf8');
        await logEvent({ type: 'ledger.append', payload: entry });
        await appendChat({ kind: 'ledger.append', entry });
        break;
      }
      case 'FILE.WRITE': {
        const abs = resolvePath(root, action.path);
        let content = action.content;
        if (action.mode === 'append') {
          try {
            const existing = await readUtf8(abs);
            content = existing + content;
          } catch (err: any) {
            if (err.code !== 'ENOENT') throw err;
          }
        }
        await writeAtomic(abs, content);
        await logEvent({ type: 'file.write', payload: { path: action.path, mode: action.mode } });
        await appendChat({ kind: 'file.write', path: action.path, mode: action.mode });
        break;
      }
      case 'MEM.READ': {
        const abs = resolvePath(root, action.path);
        let content = '';
        try {
          content = await readUtf8(abs);
        } catch (err: any) {
          if (err.code === 'ENOENT') {
            content = '';
          } else {
            throw err;
          }
        }
        outputs.push({ type: 'MEM.READ', path: action.path, content });
        await logEvent({ type: 'mem.read', payload: { path: action.path } });
        await appendChat({ kind: 'mem.read', path: action.path });
        break;
      }
      case 'WEB.SEARCH': {
        const results = await web_search({ query: action.query, count: action.count });
        outputs.push({ type: 'WEB.SEARCH', query: action.query, results: results.results });
        await logEvent({ type: 'web.search', payload: { query: action.query, count: action.count } });
        await appendChat({ kind: 'web.search', query: action.query, count: action.count });
        break;
      }
      case 'CITE': {
        for (const url of action.urls) {
          citations.add(url);
        }
        await logEvent({ type: 'cite', payload: { urls: action.urls } });
        await appendChat({ kind: 'cite', urls: action.urls });
        break;
      }
      case 'CAPSULE.REBUILD': {
        const hash = await buildCapsule();
        outputs.push({ type: 'CAPSULE.REBUILD', hash });
        await logEvent({ type: 'capsule.rebuild', payload: { hash } });
        await appendChat({ kind: 'capsule.rebuild', hash });
        break;
      }
      case 'ASSERT': {
        outputs.push({ type: 'ASSERT', message: action.message });
        await logEvent({ type: 'assert', payload: { message: action.message } });
        await appendChat({ kind: 'assert', message: action.message });
        break;
      }
      default:
        throw new Error(`Unhandled action ${(action as any).type}`);
    }
  }

  return { outputs, citations: Array.from(citations) };
}
