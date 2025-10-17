import { promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { writeAtomic, readUtf8 } from '../src/lib/fsutil.js';

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function safeRead(filePath: string): Promise<string> {
  try {
    return await readUtf8(filePath);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return '';
    }
    throw err;
  }
}

async function loadLines(filePath: string): Promise<string[]> {
  const data = await safeRead(filePath);
  return data
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function collectLogs(): Promise<string[]> {
  const dir = 'logs';
  let files: string[] = [];
  try {
    files = await fs.readdir(dir);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  const lines: { t: string; line: string }[] = [];
  for (const file of files.filter((f) => f.endsWith('.ndjson'))) {
    const full = path.join(dir, file);
    const content = await safeRead(full);
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        lines.push({ t: parsed.t ?? new Date().toISOString(), line });
      } catch {
        lines.push({ t: new Date().toISOString(), line });
      }
    }
  }
  return lines
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
    .slice(-5)
    .map((entry) => entry.line);
}

async function collectWorkset(): Promise<Array<{ path: string; sha8: string; purpose: string }>> {
  const important = [
    'src/server.ts',
    'src/dsl/executor.ts',
    'src/dsl/schema.ts',
    'src/lib/openai.ts',
    'src/agent/context.ts',
    'public/client.js',
    'public/index.html',
    'scripts/smoke.ts'
  ];
  const workset: Array<{ path: string; sha8: string; purpose: string }> = [];
  for (const rel of important.slice(0, 8)) {
    const content = await safeRead(rel);
    if (!content) continue;
    workset.push({
      path: rel,
      sha8: hashContent(content).slice(0, 8),
      purpose: 'capsule-tracking'
    });
  }
  return workset;
}

function renderSection(title: string, lines: string[]): string {
  if (!lines.length) return `## ${title}\n(none)\n`;
  return `## ${title}\n${lines.map((line) => `- ${line}`).join('\n')}\n`;
}

export async function buildCapsule(): Promise<string> {
  const goal = (await safeRead('memory/agent/goals.md')).trim();
  const planLines = await loadLines('memory/agent/plan.md');
  const facts = await loadLines('notes/facts.md');
  const decisions = await loadLines('notes/decisions.md');
  const events = await collectLogs();
  const workset = await collectWorkset();

  const capsule = [
    '# Capsule',
    `Project ID: peggy-codex-helper`,
    `Repo URL: local`,
    `Version: ${new Date().toISOString()}`,
    '',
    '## Goal',
    goal || '(none)',
    '',
    renderSection('Plan', planLines),
    renderSection('Facts', facts),
    renderSection('Open Decisions', decisions),
    renderSection('Last 5 Events', events),
    '## Active Workset',
    workset.length
      ? workset.map((item) => `- ${item.path} (${item.sha8}) ${item.purpose}`).join('\n')
      : '(none)'
  ].join('\n');

  const hash = hashContent(capsule);
  const final = `${capsule}\n\nCapsule Hash: ${hash}\n`;
  await writeAtomic('_system/capsule.md', final);
  console.log(hash);
  return hash;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildCapsule().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
