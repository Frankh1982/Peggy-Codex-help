import { promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { truncate, compactWhitespace } from '../lib/strings.js';
import type { ModelMessage } from '../lib/openai.js';

const root = process.cwd();

let personaCache: string | null = null;
let guardrailsCache: string | null = null;
let loaderCache: string | null = null;

async function readOnce(relPath: string, cache: string | null): Promise<string> {
  if (cache) return cache;
  const abs = path.join(root, relPath);
  return fs.readFile(abs, 'utf8');
}

async function getPersona(): Promise<string> {
  if (!personaCache) {
    personaCache = await readOnce('src/agent/persona.md', personaCache);
  }
  return personaCache;
}

async function getGuardrails(): Promise<string> {
  if (!guardrailsCache) {
    guardrailsCache = await readOnce('_system/guardrails.md', guardrailsCache);
  }
  return guardrailsCache;
}

async function getLoaderSnippet(): Promise<string> {
  if (!loaderCache) {
    loaderCache = await readOnce('_system/loader_snippet.txt', loaderCache);
  }
  return loaderCache;
}

function hashCapsule(text: string): string {
  const hash = createHash('sha256').update(text).digest('hex');
  return hash.slice(0, 16);
}

function summarizeTurns(lastFew: { role: 'user' | 'assistant' | 'tool'; content: string }[]) {
  const recent = lastFew.slice(-2);
  if (!recent.length) return 'No recent turns.';
  return recent
    .map((turn) => {
      const label = turn.role.toUpperCase();
      const summary = truncate(compactWhitespace(turn.content), 200);
      return `${label}: ${summary}`;
    })
    .join('\n');
}

export async function buildMessages(
  userText: string,
  capsule: string,
  lastFew: { role: 'user' | 'assistant' | 'tool'; content: string }[]
): Promise<ModelMessage[]> {
  const [persona, guardrails, loader] = await Promise.all([
    getPersona(),
    getGuardrails(),
    getLoaderSnippet()
  ]);

  const capsuleHash = hashCapsule(capsule);
  const header = truncate(
    `Capsule hash: ${capsuleHash}\nLast turns:\n${summarizeTurns(lastFew)}`,
    600
  );

  return [
    {
      role: 'system',
      content: `${persona.trim()}\n\nGuardrails:\n${guardrails.trim()}\n\nLoader:\n${loader.trim()}`
    },
    {
      role: 'system',
      content: header
    },
    {
      role: 'user',
      content: userText
    }
  ];
}
