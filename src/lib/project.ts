// src/lib/project.ts
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const AGENT_DIR = path.join(process.cwd(), 'memory', 'agent');
const GOALS_MD = path.join(AGENT_DIR, 'goals.md');     // lines: "<slug>: <one-liner>"
const PLAN_MD  = path.join(AGENT_DIR, 'plan.md');      // checklist: "- [ ] step" or "- [x] step"
const PROG_MD  = path.join(AGENT_DIR, 'progress.md');  // "- [YYYY-MM-DD HH:MM] note"
const STATE_JSON = path.join(AGENT_DIR, 'state.json');

function mkdirp(p: string){ fs.mkdirSync(p, { recursive: true }); }
function sha8(s: string){ return crypto.createHash('sha256').update(s).digest('hex').slice(0,8); }
function nowLocal(){ const d=new Date(); return d.toISOString().replace('T',' ').slice(0,16); }
function slugify(s: string){ return String(s).toLowerCase().trim().replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,''); }

export type PlanItem = { text: string; done: boolean };

export function initProjectFiles() {
  mkdirp(AGENT_DIR);
  if (!fs.existsSync(GOALS_MD)) fs.writeFileSync(GOALS_MD, '');
  if (!fs.existsSync(PLAN_MD))  fs.writeFileSync(PLAN_MD,  '');
  if (!fs.existsSync(PROG_MD))  fs.writeFileSync(PROG_MD,  '');
  if (!fs.existsSync(STATE_JSON)) fs.writeFileSync(STATE_JSON, JSON.stringify({ rev: 1, last_seen: new Date().toISOString(), active_goal: null, plan_cursor: 0 }, null, 2));
}

export function readState(): { rev:number; last_seen:string; active_goal:string|null; plan_cursor:number }{
  return JSON.parse(fs.readFileSync(STATE_JSON,'utf8'));
}
export function writeState(s: any){
  fs.writeFileSync(STATE_JSON, JSON.stringify(s, null, 2));
}

export function ensureGoal(slug: string, oneLine: string){
  slug = slugify(slug);
  const lines = readLines(GOALS_MD);
  const idx = lines.findIndex(l => l.startsWith(slug + ':'));
  if (idx === -1) lines.unshift(`${slug}: ${oneLine.trim()}`);
  else lines[idx] = `${slug}: ${oneLine.trim()}`;
  fs.writeFileSync(GOALS_MD, lines.join('\n'));
  const st = readState(); st.active_goal = slug; st.plan_cursor = nextIndex(readPlan());
  writeState(st);
}

export function setActiveGoal(slug: string){
  const st = readState(); st.active_goal = slugify(slug);
  st.plan_cursor = nextIndex(readPlan());
  writeState(st);
}

export function readGoals(): { slug:string; text:string }[] {
  return readLines(GOALS_MD)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const m = /^([^:]+):\s*(.*)$/.exec(l) || [];
      return { slug: (m[1]||'').trim(), text: (m[2]||'').trim() };
    });
}

export function readPlan(): PlanItem[] {
  return readLines(PLAN_MD).map(line => {
    const m = /^\s*-\s*\[( |x|X)\]\s*(.*)$/.exec(line);
    if (!m) return null;
    return { done: (m[1]||'').toLowerCase()==='x', text: (m[2]||'').trim() };
  }).filter(Boolean) as PlanItem[];
}

export function writePlan(items: PlanItem[]){
  const out = items.map(it => `- [${it.done?'x':' '}] ${it.text}`).join('\n');
  fs.writeFileSync(PLAN_MD, out + (out?'\n':''));
}

export function addPlanItem(text: string){
  const items = readPlan();
  items.push({ text: norm(text), done: false });
  writePlan(items);
  // update cursor if none
  const st = readState();
  if (st.plan_cursor <= 0) { st.plan_cursor = nextIndex(items); writeState(st); }
}

export function insertPlanItem(index: number, text: string){
  const items = readPlan();
  items.splice(Math.max(0, index-1), 0, { text: norm(text), done: false });
  writePlan(items);
  const st = readState(); st.plan_cursor = nextIndex(items); writeState(st);
}

export function markPlanDone(index: number, done = true){
  const items = readPlan();
  const i = Math.max(0, Math.min(items.length-1, index-1));
  if (items[i]) items[i].done = done;
  writePlan(items);
  const st = readState(); st.plan_cursor = nextIndex(items); writeState(st);
}

export function nextIndex(items?: PlanItem[]): number {
  const arr = items ?? readPlan();
  const i = arr.findIndex(it => !it.done);
  return i === -1 ? 0 : (i+1); // 1-based for humans; 0 = none left
}

export function planHash(): string {
  const items = readPlan().map(it => (it.done?'[x] ':'[ ] ') + it.text).join('\n');
  return sha8(items);
}

export function appendCheckpoint(note: string){
  fs.appendFileSync(PROG_MD, `- [${nowLocal()}] ${norm(note)}\n`);
}

export function readProgressLast(n=5): string[] {
  const lines = readLines(PROG_MD).filter(Boolean);
  return lines.slice(-n);
}

export function goalOneLiner(slug: string|null): string {
  if (!slug) return '';
  const g = readGoals().find(x => x.slug === slug);
  return g?.text ?? '';
}

export function projectHeader(): string {
  const st = readState();
  const nx = nextIndex();
  const ph = planHash();
  const bits = [];
  if (st.active_goal) bits.push(`goal=${st.active_goal}`);
  if (nx>0) bits.push(`nx=${nx}`);
  bits.push(`ph=${ph}`);
  return bits.join('|'); // appended to main header
}

export function projectCard(): string {
  const st = readState();
  const items = readPlan();
  const nx = nextIndex(items);
  const goal = goalOneLiner(st.active_goal);
  const recent = readProgressLast(5);
  const view = [];
  view.push(`Project: ${st.active_goal ?? 'none'}`);
  if (goal) view.push(`Goal: ${goal}`);
  if (nx>0) view.push(`Next: [${nx}] ${items[nx-1].text}`);
  const ahead = items
    .map((it,i)=>({i:i+1,it}))
    .filter(x=>!x.it.done)
    .slice(0,5)
    .map(x=>`${x.i}. [ ] ${x.it.text}`);
  view.push(`Plan (next ${ahead.length || 0}):`);
  view.push(ahead.length? ahead.join('\n') : '— none —');
  const done = items.filter(x=>x.done).length;
  view.push(`Progress: ${done}/${items.length} done`);
  if (recent.length) {
    view.push('Recent checkpoints:');
    view.push(recent.join('\n'));
  }
  view.push('Actions: plan add <text> | plan done <n> | plan insert <n> <text> | checkpoint: <note> | project show');
  return view.join('\n');
}

// helpers
function readLines(p: string){ return fs.readFileSync(p,'utf8').split(/\r?\n/); }
function norm(s: string){ return String(s).trim().replace(/\s+/g,' ').replace(/\.\s*$/,'') + '.'; }
