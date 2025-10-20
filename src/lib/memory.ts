// src/lib/memory.ts
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export type Prefs = {
  verbosity: 0 | 1 | 2 | 3;
  syc: boolean;
  tone: 'direct' | 'neutral' | 'friendly';
  formality: 'low' | 'med' | 'high';
  guard: 'strict' | 'normal';
  chatty: 0 | 1;
};

export type Profile = { name: string | null; prefs: Prefs };
export type RulesSection = { id: string; items: string[] };
export type RulesStore = { rev: number; sections: RulesSection[] };
export type AgentState = { rev: number; last_seen: string; active_goal: string | null };

const root = process.cwd();
const memDir = path.join(root, 'memory');
const userDir = path.join(memDir, 'user');
const agentDir = path.join(memDir, 'agent');
const logsDir = path.join(root, 'logs');
const rulesPath = path.join(agentDir, 'rules.json');
const statePath = path.join(agentDir, 'state.json');
const goalsPath = path.join(agentDir, 'goals.md');
const planPath = path.join(agentDir, 'plan.md');
const progressPath = path.join(agentDir, 'progress.md');
const scratchPath = path.join(agentDir, 'scratch.json');

export type ScratchState = {
  last_topics: string[];
  last_recipe: string | null;
  last_query: string | null;
};

const defaultScratch: ScratchState = {
  last_topics: [],
  last_recipe: null,
  last_query: null,
};

const defaultPrefs: Prefs = {
  verbosity: 1,
  syc: true,
  tone: 'direct',
  formality: 'low',
  guard: 'strict',
  chatty: 0,
};

const defaultSections: RulesSection[] = [
  { id: 'style', items: [] },
  { id: 'preferences', items: [] },
  { id: 'output', items: [] },
];

const defaultRules: RulesStore = {
  rev: 1,
  sections: defaultSections,
};

function mkdirp(p: string){ fs.mkdirSync(p, { recursive: true }); }
function today(){ const d=new Date(); return d.toISOString().slice(0,10); }
function sha8(s: string){ return crypto.createHash('sha256').update(s).digest('hex').slice(0,8); }

function truncateSnippet(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 120) return trimmed;
  return trimmed.slice(0, 117).trimEnd() + '…';
}

function normalizeScratch(input: Partial<ScratchState> | undefined): ScratchState {
  const candidate = input ?? {};
  const topics = Array.isArray(candidate.last_topics) ? candidate.last_topics : [];
  const normalizedTopics = topics
    .map((topic) => (typeof topic === 'string' ? topic.trim() : ''))
    .filter(Boolean)
    .slice(-6);
  const lastRecipe = typeof candidate.last_recipe === 'string' ? candidate.last_recipe.trim() : null;
  const lastQuery = typeof candidate.last_query === 'string' ? candidate.last_query.trim() : null;
  return {
    last_topics: normalizedTopics,
    last_recipe: lastRecipe && lastRecipe.length > 0 ? lastRecipe : null,
    last_query: lastQuery && lastQuery.length > 0 ? lastQuery : null,
  };
}

function ensureScratchFile() {
  if (!fs.existsSync(scratchPath)) {
    fs.writeFileSync(scratchPath, JSON.stringify(defaultScratch, null, 2));
  }
}

function normalizePrefs(prefs: Partial<Prefs> | undefined): Prefs {
  const candidate = prefs ?? {};
  const normalized: Prefs = { ...defaultPrefs };
  const verbCandidate = typeof candidate.verbosity === 'number' ? candidate.verbosity : Number(candidate.verbosity);
  const verbosity = Number.isFinite(verbCandidate) ? verbCandidate : defaultPrefs.verbosity;
  normalized.verbosity = Math.max(0, Math.min(3, Math.round(verbosity))) as Prefs['verbosity'];
  const sycSource = (candidate as any).syc;
  const sycCandidate = typeof sycSource === 'string' ? sycSource.toLowerCase() : sycSource;
  if (typeof sycCandidate === 'boolean') {
    normalized.syc = sycCandidate;
  } else if (typeof sycCandidate === 'string') {
    normalized.syc = ['1', 'true', 'yes', 'on'].includes(sycCandidate);
  } else {
    normalized.syc = Boolean(sycCandidate);
  }
  const toneAllowed: Prefs['tone'][] = ['direct', 'neutral', 'friendly'];
  const toneCandidate = typeof candidate.tone === 'string' ? candidate.tone.toLowerCase() : '';
  normalized.tone = toneAllowed.includes(toneCandidate as Prefs['tone']) ? (toneCandidate as Prefs['tone']) : defaultPrefs.tone;
  const formalityAllowed: Prefs['formality'][] = ['low', 'med', 'high'];
  const formalityCandidate = typeof candidate.formality === 'string' ? candidate.formality.toLowerCase() : '';
  normalized.formality = formalityAllowed.includes(formalityCandidate as Prefs['formality']) ? (formalityCandidate as Prefs['formality']) : defaultPrefs.formality;
  const guardAllowed: Prefs['guard'][] = ['strict', 'normal'];
  const guardCandidate = typeof candidate.guard === 'string' ? candidate.guard.toLowerCase() : '';
  normalized.guard = guardAllowed.includes(guardCandidate as Prefs['guard']) ? (guardCandidate as Prefs['guard']) : defaultPrefs.guard;
  const chattyCandidate = (candidate as any).chatty;
  if (typeof chattyCandidate === 'number') {
    normalized.chatty = chattyCandidate >= 1 ? 1 : 0;
  } else if (typeof chattyCandidate === 'boolean') {
    normalized.chatty = chattyCandidate ? 1 : 0;
  } else if (typeof chattyCandidate === 'string') {
    const lower = chattyCandidate.toLowerCase();
    normalized.chatty = ['1', 'true', 'yes', 'on'].includes(lower) ? 1 : 0;
  } else {
    normalized.chatty = defaultPrefs.chatty;
  }
  return normalized;
}

function readRulesFile(): RulesStore {
  return JSON.parse(fs.readFileSync(rulesPath, 'utf8')) as RulesStore;
}

function cloneRules(rules: RulesStore): RulesStore {
  return {
    rev: rules.rev,
    sections: rules.sections.map(section => ({ id: section.id, items: [...section.items] })),
  };
}

function writeRulesFile(rules: RulesStore){
  fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2));
}

export function initMemory() {
  mkdirp(userDir); mkdirp(agentDir); mkdirp(logsDir);
  const profilePath = path.join(userDir, 'profile.json');
  if (!fs.existsSync(profilePath)) {
    fs.writeFileSync(profilePath, JSON.stringify({ name: null, prefs: { ...defaultPrefs } } as Profile, null, 2));
  }
  if (!fs.existsSync(statePath)) {
    const initial: AgentState = { rev: 1, last_seen: new Date().toISOString(), active_goal: null };
    fs.writeFileSync(statePath, JSON.stringify(initial, null, 2));
  }
  ensureFile(goalsPath);
  ensureFile(planPath);
  ensureFile(progressPath);
  ensureRules();
  ensureScratchFile();
}

export function readProfile(): Profile {
  const raw = JSON.parse(fs.readFileSync(path.join(userDir,'profile.json'),'utf8')) as Profile;
  raw.prefs = normalizePrefs(raw.prefs);
  return raw;
}
export function writeProfile(p: Profile){
  p.prefs = normalizePrefs(p.prefs);
  const full = JSON.stringify(p);
  fs.writeFileSync(path.join(userDir,'profile.json'), full);
  appendLog('op', { op: 'SET', key: 'profile', sha: sha8(full) });
}

export function getPrefs(): Prefs {
  const p = readProfile();
  const verbosity = Math.max(0, Math.min(3, Number((p as any).prefs?.verbosity ?? 1))) as Prefs['verbosity'];
  const tone = ((p as any).prefs?.tone ?? 'direct') as Prefs['tone'];
  const formality = ((p as any).prefs?.formality ?? 'low') as Prefs['formality'];
  const guard = ((p as any).prefs?.guard ?? 'strict') as Prefs['guard'];
  const syc = ((p as any).prefs?.syc ?? true) as Prefs['syc'];
  const chatty = Number((p as any).prefs?.chatty ?? 0) >= 1 ? 1 : 0;
  return { verbosity, tone, formality, guard, syc, chatty };
}

export function listPrefs(): Prefs {
  return getPrefs();
}

type PrefKey = keyof Prefs;

export function setPref(key: PrefKey, value: unknown) {
  const profile = readProfile();
  const prefs = profile.prefs;
  switch (key) {
    case 'verbosity': {
      const numVal = typeof value === 'number' ? value : Number(value);
      const num = Number.isFinite(numVal) ? numVal : defaultPrefs.verbosity;
      prefs.verbosity = Math.max(0, Math.min(3, Math.round(num))) as Prefs['verbosity'];
      break;
    }
    case 'syc': {
      if (typeof value === 'string') {
        const lower = value.toLowerCase();
        prefs.syc = ['1', 'true', 'yes', 'on'].includes(lower);
      } else {
        prefs.syc = Boolean(value);
      }
      break;
    }
    case 'tone': {
      const allowed: Prefs['tone'][] = ['direct', 'neutral', 'friendly'];
      const str = typeof value === 'string' ? value.toLowerCase() : '';
      prefs.tone = allowed.includes(str as Prefs['tone']) ? (str as Prefs['tone']) : defaultPrefs.tone;
      break;
    }
    case 'formality': {
      const allowed: Prefs['formality'][] = ['low', 'med', 'high'];
      const str = typeof value === 'string' ? value.toLowerCase() : '';
      prefs.formality = allowed.includes(str as Prefs['formality']) ? (str as Prefs['formality']) : defaultPrefs.formality;
      break;
    }
    case 'guard': {
      const allowed: Prefs['guard'][] = ['strict', 'normal'];
      const str = typeof value === 'string' ? value.toLowerCase() : '';
      prefs.guard = allowed.includes(str as Prefs['guard']) ? (str as Prefs['guard']) : defaultPrefs.guard;
      break;
    }
    case 'chatty': {
      if (typeof value === 'string') {
        const lower = value.toLowerCase();
        prefs.chatty = ['1', 'true', 'yes', 'on'].includes(lower) ? 1 : 0;
      } else if (typeof value === 'number') {
        prefs.chatty = value >= 1 ? 1 : 0;
      } else {
        prefs.chatty = value ? 1 : 0;
      }
      break;
    }
  }
  profile.prefs = prefs;
  writeProfile(profile);
  appendLog('op', { op: 'PREF', key, value: profile.prefs[key] });
}

function ensureFile(p: string) {
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, '');
  }
}

export function readScratch(): ScratchState {
  ensureScratchFile();
  try {
    const raw = JSON.parse(fs.readFileSync(scratchPath, 'utf8')) as Partial<ScratchState>;
    return normalizeScratch(raw);
  } catch {
    fs.writeFileSync(scratchPath, JSON.stringify(defaultScratch, null, 2));
    return { ...defaultScratch };
  }
}

export function writeScratch(
  updater: (current: ScratchState) => ScratchState | void,
): ScratchState {
  const current = readScratch();
  const draft = updater ? updater({ ...current, last_topics: [...current.last_topics] }) || current : current;
  const normalized = normalizeScratch(draft);
  fs.writeFileSync(scratchPath, JSON.stringify(normalized, null, 2));
  return normalized;
}

export function resetScratch(): ScratchState {
  fs.writeFileSync(scratchPath, JSON.stringify(defaultScratch, null, 2));
  return { ...defaultScratch };
}

export function readState(): AgentState {
  if (!fs.existsSync(statePath)) {
    const fallback: AgentState = { rev: 1, last_seen: new Date().toISOString(), active_goal: null };
    fs.writeFileSync(statePath, JSON.stringify(fallback, null, 2));
    return fallback;
  }
  const raw = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Partial<AgentState>;
  const normalized: AgentState = {
    rev: typeof raw.rev === 'number' ? raw.rev : 1,
    last_seen: typeof raw.last_seen === 'string' ? raw.last_seen : new Date().toISOString(),
    active_goal: typeof raw.active_goal === 'string' ? raw.active_goal : null,
  };
  if (
    normalized.rev !== raw.rev ||
    normalized.last_seen !== raw.last_seen ||
    normalized.active_goal !== raw.active_goal
  ) {
    writeState(normalized);
  }
  return normalized;
}

export function writeState(state: AgentState) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function bumpState(){
  const st = readState();
  st.rev += 1;
  st.last_seen = new Date().toISOString();
  writeState(st);
  return st;
}

function timestamp(){
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function appendProgressEntry(note: string) {
  ensureFile(progressPath);
  const line = `- [${timestamp()}] ${note.trim()}`;
  fs.appendFileSync(progressPath, line + '\n');
  appendLog('progress', { note: note.trim() });
  return line;
}

export function readProgressEntries(limit: number): string[] {
  ensureFile(progressPath);
  const raw = fs.readFileSync(progressPath, 'utf8');
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (limit <= 0) return lines;
  return lines.slice(-limit);
}

export type ChatLine = { role: 'user' | 'assistant' | 'system'; content: string };

export function getRecentChatLines(limit: number): ChatLine[] {
  if (limit <= 0) return [];
  const files = fs
    .readdirSync(logsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^run-\d{4}-\d{2}-\d{2}\.ndjson$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const collected: ChatLine[] = [];
  for (const file of files) {
    const full = fs.readFileSync(path.join(logsDir, file), 'utf8');
    const rows = full.split(/\r?\n/).filter(Boolean);
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      try {
        const parsed = JSON.parse(rows[i]) as { type?: string; snippet?: string; extra?: { content?: string; role?: string } };
        if (parsed?.type !== 'user' && parsed?.type !== 'assistant') continue;
        const role = parsed.type as 'user' | 'assistant';
        const content = typeof parsed.snippet === 'string'
          ? parsed.snippet
          : typeof parsed.extra?.content === 'string'
            ? parsed.extra.content
            : '';
        if (!content) continue;
        collected.push({ role, content });
        if (collected.length >= limit) {
          return collected.reverse();
        }
      } catch {}
    }
  }
  return collected.reverse();
}

export function appendEvent(
  type: 'user' | 'assistant' | 'op',
  snippet: string,
  extra: Record<string, unknown> = {},
) {
  const safeSnippet = truncateSnippet(snippet);
  const entry: Record<string, unknown> = {
    t: new Date().toISOString(),
    type,
    snippet: safeSnippet,
  };
  const extraKeys = Object.keys(extra ?? {});
  if (extraKeys.length > 0) {
    entry.extra = extra;
  }
  mkdirp(logsDir);
  const file = path.join(logsDir, `run-${today()}.ndjson`);
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}

export function appendChat(role: 'user'|'assistant'|'system', content: string){
  const type: 'user' | 'assistant' | 'op' = role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : 'op';
  const extra = role === 'system' ? { role, content: truncateSnippet(content) } : {};
  appendEvent(type, content, extra);
}

export function appendLog(type: string, payload: Record<string, unknown>){
  const details = payload ?? {};
  const hasDetails = Object.keys(details).length > 0;
  const snippetBase = hasDetails ? `${type} ${JSON.stringify(details)}` : type;
  appendEvent('op', snippetBase, { event: type, ...details });
}

export function headerLine(p: Profile, rev: number){
  const prefs = normalizePrefs(p.prefs);
  const toneMap: Record<Prefs['tone'], string> = { direct: 'd', neutral: 'n', friendly: 'f' };
  const formalityMap: Record<Prefs['formality'], string> = { low: 'l', med: 'm', high: 'h' };
  const guardMap: Record<Prefs['guard'], string> = { strict: 's', normal: 'n' };
  const bits = [
    p.name ? `u=${p.name}` : null,
    `rev=${rev}`,
    `v=${prefs.verbosity}`,
    `syc=${prefs.syc?1:0}`,
    `c=${prefs.chatty}`,
    `t=${toneMap[prefs.tone]}`,
    `f=${formalityMap[prefs.formality]}`,
    `g=${guardMap[prefs.guard]}`,
    `rs=${rulesHash()}`,
  ].filter(Boolean);
  return 'h:' + bits.join('|');
}

export function ensureRules(): RulesStore {
  if (!fs.existsSync(rulesPath)) {
    writeRulesFile(cloneRules(defaultRules));
  }
  return readRulesFile();
}

export function listRules(): RulesStore {
  ensureRules();
  const fp = path.join(agentDir, 'rules.json');
  return JSON.parse(fs.readFileSync(fp, 'utf8')) as RulesStore;
}

function normalizeRuleTextInput(text: string): string {
  if (!text) return '';
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const withoutTrailingDot = collapsed.replace(/[.]+$/, '').trim();
  return withoutTrailingDot;
}

function normalizeSectionId(section: string): string {
  return section.trim().toLowerCase();
}

function getOrCreateSection(rules: RulesStore, section: string, create: boolean): RulesSection {
  const id = normalizeSectionId(section);
  if (!id) {
    throw new Error('Section id required');
  }
  let sec = rules.sections.find((s) => s.id === id);
  if (!sec && create) {
    sec = { id, items: [] };
    rules.sections.push(sec);
  }
  if (!sec) {
    throw new Error(`Section "${id}" not found`);
  }
  return sec;
}

export function addRule(section: string, text: string){
  const normalizedText = normalizeRuleTextInput(text);
  if (!normalizedText) return;
  if (normalizedText.length > 120) {
    throw new Error('Rule text too long');
  }
  const rules = ensureRules();
  const sec = getOrCreateSection(rules, section, true);
  const exists = sec.items.some(item => item.toLowerCase() === normalizedText.toLowerCase());
  if (exists) {
    throw new Error('Duplicate rule');
  }
  sec.items.push(normalizedText);
  rules.rev += 1;
  writeRulesFile(rules);
  appendLog('op', { op: 'RULE_ADD', section: sec.id, text: normalizedText, rev: rules.rev });
}

export function delRule(section: string, text: string){
  const normalizedText = normalizeRuleTextInput(text);
  if (!normalizedText) return;
  const rules = ensureRules();
  const id = normalizeSectionId(section);
  if (!id) return;
  const sec = rules.sections.find(s => s.id === id);
  if (!sec) return;
  const idx = sec.items.findIndex(item => item.toLowerCase() === normalizedText.toLowerCase());
  if (idx === -1) return;
  sec.items.splice(idx, 1);
  rules.rev += 1;
  writeRulesFile(rules);
  appendLog('op', { op: 'RULE_DEL', section: id, text: normalizedText, rev: rules.rev });
}

function coerceRuleIndex(index: number): number {
  if (!Number.isFinite(index)) {
    throw new Error('Rule index must be a number');
  }
  const normalized = Math.floor(index);
  if (normalized < 1) {
    throw new Error('Rule index must be ≥ 1');
  }
  return normalized;
}

export function replaceRule(section: string, index: number, text: string) {
  const normalizedText = normalizeRuleTextInput(text);
  if (!normalizedText) {
    throw new Error('Replacement rule text required');
  }
  if (normalizedText.length > 120) {
    throw new Error('Rule text too long');
  }
  const rules = ensureRules();
  const sec = getOrCreateSection(rules, section, false);
  const normalizedIndex = coerceRuleIndex(index);
  const zeroIdx = normalizedIndex - 1;
  if (!sec.items[zeroIdx]) {
    throw new Error('Rule index out of range');
  }
  const before = sec.items[zeroIdx];
  sec.items[zeroIdx] = normalizedText;
  rules.rev += 1;
  writeRulesFile(rules);
  appendLog('op', {
    op: 'RULE_REPLACE',
    section: sec.id,
    index: normalizedIndex,
    before,
    text: normalizedText,
    rev: rules.rev,
  });
  return { section: sec.id, index: normalizedIndex, before, after: normalizedText };
}

export function delRuleAt(section: string, index: number) {
  const rules = ensureRules();
  const sec = getOrCreateSection(rules, section, false);
  const normalizedIndex = coerceRuleIndex(index);
  const zeroIdx = normalizedIndex - 1;
  if (!sec.items[zeroIdx]) {
    throw new Error('Rule index out of range');
  }
  const [removed] = sec.items.splice(zeroIdx, 1);
  rules.rev += 1;
  writeRulesFile(rules);
  appendLog('op', {
    op: 'RULE_DEL_INDEX',
    section: sec.id,
    index: normalizedIndex,
    text: removed,
    rev: rules.rev,
  });
  return { section: sec.id, index: normalizedIndex, text: removed };
}

export function clearRuleSection(section: string) {
  const rules = ensureRules();
  const sec = getOrCreateSection(rules, section, false);
  if (sec.items.length === 0) {
    return { section: sec.id, removed: 0 };
  }
  const removed = sec.items.length;
  sec.items = [];
  rules.rev += 1;
  writeRulesFile(rules);
  appendLog('op', { op: 'RULE_CLEAR', section: sec.id, removed, rev: rules.rev });
  return { section: sec.id, removed };
}

export function rulesHash(): string {
  const rules = ensureRules();
  return sha8(JSON.stringify(rules));
}

export function ruleCounts(): { style: number; preferences: number; output: number } {
  const rules = ensureRules();
  const counts = { style: 0, preferences: 0, output: 0 };
  for (const section of rules.sections ?? []) {
    const key = section.id?.toLowerCase();
    if (key === 'style' || key === 'preferences' || key === 'output') {
      counts[key] = section.items.length;
    }
  }
  return counts;
}

export function parseNameIntent(text: string): string | null {
  // Accept: "my name is X", "call me X"
  const m = /\b(my name is|call me)\s+([A-Za-z][\w\- ]{0,40})/i.exec(text);
  return m ? m[2].trim() : null;
}

export function asksForName(text: string): boolean {
  return /\b(what('?| i)s|what is|whats)\s+(my\s+)?name\b/i.test(text) || /\bwho am i\b/i.test(text);
}
