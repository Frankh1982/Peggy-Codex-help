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
};

export type Profile = { name: string | null; prefs: Prefs };
export type RulesSection = { id: string; items: string[] };
export type RulesStore = { rev: number; sections: RulesSection[] };
export type AgentState = { rev: number; last_seen: string };

const root = process.cwd();
const memDir = path.join(root, 'memory');
const userDir = path.join(memDir, 'user');
const agentDir = path.join(memDir, 'agent');
const chatDir = path.join(memDir, 'chat');
const logsDir = path.join(root, 'logs');
const rulesPath = path.join(agentDir, 'rules.json');

const defaultPrefs: Prefs = {
  verbosity: 1,
  syc: true,
  tone: 'direct',
  formality: 'low',
  guard: 'strict',
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

function normalizePrefs(prefs: Partial<Prefs> | undefined): Prefs {
  const candidate = prefs ?? {};
  const normalized: Prefs = { ...defaultPrefs };
  const verbCandidate = typeof candidate.verbosity === 'number' ? candidate.verbosity : Number(candidate.verbosity);
  const verbosity = Number.isFinite(verbCandidate) ? verbCandidate : defaultPrefs.verbosity;
  normalized.verbosity = Math.max(0, Math.min(3, Math.round(verbosity))) as Prefs['verbosity'];
  const sycCandidate = typeof candidate.syc === 'string' ? candidate.syc.toLowerCase() : candidate.syc;
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
  mkdirp(userDir); mkdirp(agentDir); mkdirp(chatDir); mkdirp(logsDir);
  const profilePath = path.join(userDir, 'profile.json');
  const statePath   = path.join(agentDir,'state.json');
  if (!fs.existsSync(profilePath)) {
    fs.writeFileSync(profilePath, JSON.stringify({ name: null, prefs: { ...defaultPrefs } } as Profile, null, 2));
  }
  if (!fs.existsSync(statePath)) {
    fs.writeFileSync(statePath, JSON.stringify({ rev: 1, last_seen: new Date().toISOString() } as AgentState, null, 2));
  }
  ensureRules();
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
  return { ...readProfile().prefs };
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
  }
  profile.prefs = prefs;
  writeProfile(profile);
  appendLog('op', { op: 'PREF', key, value: profile.prefs[key] });
}

export function readState(): AgentState {
  return JSON.parse(fs.readFileSync(path.join(agentDir,'state.json'),'utf8'));
}
export function bumpState(){
  const st = readState();
  st.rev += 1;
  st.last_seen = new Date().toISOString();
  fs.writeFileSync(path.join(agentDir,'state.json'), JSON.stringify(st));
  return st;
}

export function appendChat(role: 'user'|'assistant'|'system', content: string){
  const f = path.join(chatDir, `chat-${today()}.ndjson`);
  fs.appendFileSync(f, JSON.stringify({ t: new Date().toISOString(), role, content }) + '\n');
}

export function appendLog(type: string, payload: Record<string, unknown>){
  const f = path.join(logsDir, `run-${today()}.ndjson`);
  fs.appendFileSync(f, JSON.stringify({ t: new Date().toISOString(), type, ...payload }) + '\n');
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
  return cloneRules(ensureRules());
}

export function addRule(section: string, text: string){
  const trimmed = text.trim();
  if (!trimmed) return;
  if (trimmed.length > 120) {
    throw new Error('Rule text too long');
  }
  const rules = ensureRules();
  const id = section.trim().toLowerCase();
  if (!id) {
    throw new Error('Section id required');
  }
  let sec = rules.sections.find(s => s.id === id);
  if (!sec) {
    sec = { id, items: [] };
    rules.sections.push(sec);
  }
  const exists = sec.items.some(item => item.toLowerCase() === trimmed.toLowerCase());
  if (exists) {
    throw new Error('Duplicate rule');
  }
  sec.items.push(trimmed);
  rules.rev += 1;
  writeRulesFile(rules);
  appendLog('op', { op: 'RULE_ADD', section: id, text: trimmed, rev: rules.rev });
}

export function delRule(section: string, text: string){
  const trimmed = text.trim();
  if (!trimmed) return;
  const rules = ensureRules();
  const id = section.trim().toLowerCase();
  if (!id) return;
  const sec = rules.sections.find(s => s.id === id);
  if (!sec) return;
  const idx = sec.items.findIndex(item => item.toLowerCase() === trimmed.toLowerCase());
  if (idx === -1) return;
  sec.items.splice(idx, 1);
  rules.rev += 1;
  writeRulesFile(rules);
  appendLog('op', { op: 'RULE_DEL', section: id, text: trimmed, rev: rules.rev });
}

export function rulesHash(): string {
  const rules = ensureRules();
  return sha8(JSON.stringify(rules));
}

export function parseNameIntent(text: string): string | null {
  // Accept: "my name is X", "call me X"
  const m = /\b(my name is|call me)\s+([A-Za-z][\w\- ]{0,40})/i.exec(text);
  return m ? m[2].trim() : null;
}

export function asksForName(text: string): boolean {
  return /\b(what('?| i)s|what is|whats)\s+(my\s+)?name\b/i.test(text) || /\bwho am i\b/i.test(text);
}
