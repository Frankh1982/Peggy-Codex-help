// src/lib/memory.ts
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export type Profile = { name: string | null; prefs: { tone: 'direct'|'neutral'; syc: boolean } };
export type AgentState = { rev: number; last_seen: string };

const root = process.cwd();
const memDir = path.join(root, 'memory');
const userDir = path.join(memDir, 'user');
const agentDir = path.join(memDir, 'agent');
const chatDir = path.join(memDir, 'chat');
const logsDir = path.join(root, 'logs');

function mkdirp(p: string){ fs.mkdirSync(p, { recursive: true }); }
function today(){ const d=new Date(); return d.toISOString().slice(0,10); }
function sha8(s: string){ return crypto.createHash('sha256').update(s).digest('hex').slice(0,8); }

export function initMemory() {
  mkdirp(userDir); mkdirp(agentDir); mkdirp(chatDir); mkdirp(logsDir);
  const profilePath = path.join(userDir, 'profile.json');
  const statePath   = path.join(agentDir,'state.json');
  if (!fs.existsSync(profilePath)) {
    fs.writeFileSync(profilePath, JSON.stringify({ name: null, prefs: { tone: 'direct', syc:false } } as Profile, null, 2));
  }
  if (!fs.existsSync(statePath)) {
    fs.writeFileSync(statePath, JSON.stringify({ rev: 1, last_seen: new Date().toISOString() } as AgentState, null, 2));
  }
}

export function readProfile(): Profile {
  return JSON.parse(fs.readFileSync(path.join(userDir,'profile.json'),'utf8'));
}
export function writeProfile(p: Profile){
  const full = JSON.stringify(p);
  fs.writeFileSync(path.join(userDir,'profile.json'), full);
  appendLog('op', { op: 'SET', key: 'profile', sha: sha8(full) });
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
  const bits = [
    p.name ? `u=${p.name}` : null,
    `rev=${rev}`,
    `t=${p.prefs.tone}`,
    `syc=${p.prefs.syc?1:0}`
  ].filter(Boolean);
  return 'h:' + bits.join('|');
}

export function parseNameIntent(text: string): string | null {
  // Accept: "my name is X", "call me X"
  const m = /\b(my name is|call me)\s+([A-Za-z][\w\- ]{0,40})/i.exec(text);
  return m ? m[2].trim() : null;
}

export function asksForName(text: string): boolean {
  return /\b(what('?| i)s|what is|whats)\s+(my\s+)?name\b/i.test(text) || /\bwho am i\b/i.test(text);
}
