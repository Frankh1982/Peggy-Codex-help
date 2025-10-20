import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const AGENT = path.join(process.cwd(), 'memory', 'agent');
const GOALS = path.join(AGENT, 'goals.md');      // "<slug>: <one-liner>"
const PLAN  = path.join(AGENT, 'plan.md');       // "- [ ] step" / "- [x] step"
const PROG  = path.join(AGENT, 'progress.md');   // "- [YYYY-MM-DD HH:MM] note"
const STATE = path.join(AGENT, 'state.json');    // {rev,last_seen,active_goal,plan_cursor}

function mkdirp(p: string){ fs.mkdirSync(p, { recursive: true }); }
function lines(p: string){ return fs.readFileSync(p, 'utf8').split(/\r?\n/); }
function write(p: string, s: string){ fs.writeFileSync(p, s); }
function nowLocal(){ const d = new Date(); return d.toISOString().replace('T',' ').slice(0,16); }
function slugify(s: string){ return String(s).trim().toLowerCase().replace(/[^\w]+/g,'-').replace(/^-+|-+$/g,''); }
function norm(s: string){ return String(s).trim().replace(/\s+/g,' ').replace(/\.\s*$/,'') + '.'; }
function sha8(s: string){ return crypto.createHash('sha256').update(s).digest('hex').slice(0,8); }

export type PlanItem = { text: string; done: boolean };

export function initProjectFiles(){
  mkdirp(AGENT);
  if (!fs.existsSync(GOALS)) write(GOALS, '');
  if (!fs.existsSync(PLAN))  write(PLAN,  '');
  if (!fs.existsSync(PROG))  write(PROG,  '');
  if (!fs.existsSync(STATE)) write(STATE, JSON.stringify({ rev:1, last_seen:new Date().toISOString(), active_goal:null, plan_cursor:0 }, null, 2));
}

export function readState(): { rev:number; last_seen:string; active_goal:string|null; plan_cursor:number } {
  return JSON.parse(fs.readFileSync(STATE, 'utf8'));
}
export function writeState(s: any){ write(STATE, JSON.stringify(s, null, 2)); }

export function readGoals(){ // [{slug,text}]
  return lines(GOALS).map(l=>l.trim()).filter(Boolean).map(l=>{
    const m = /^([^:]+):\s*(.*)$/.exec(l) || [];
    return { slug:(m[1]||'').trim(), text:(m[2]||'').trim() };
  });
}
export function ensureGoal(slug: string, oneLine: string){
  slug = slugify(slug); oneLine = norm(oneLine);
  const ls = lines(GOALS);
  const i = ls.findIndex(l=>l.startsWith(slug+':'));
  if (i === -1) ls.unshift(`${slug}: ${oneLine}`); else ls[i] = `${slug}: ${oneLine}`;
  write(GOALS, ls.join('\n'));
  const st = readState(); st.active_goal = slug; st.plan_cursor = nextIndex(readPlan()); writeState(st);
}
export function setActiveGoal(slug: string){
  const st = readState(); st.active_goal = slugify(slug); st.plan_cursor = nextIndex(readPlan()); writeState(st);
}

export function readPlan(): PlanItem[] {
  return lines(PLAN).map(l=>{
    const m = /^\s*-\s*\[( |x|X)\]\s*(.*)$/.exec(l);
    if (!m) return null;
    return { done: (m[1]||'').toLowerCase()==='x', text:(m[2]||'').trim() };
  }).filter(Boolean) as PlanItem[];
}
export function writePlan(items: PlanItem[]){
  write(PLAN, items.map(it=>`- [${it.done?'x':' '}] ${it.text}`).join('\n') + (items.length?'\n':''));
}
export function addPlanItem(text: string){ const a = readPlan(); a.push({text:norm(text),done:false}); writePlan(a); bumpCursor(a); }
export function insertPlanItem(index:number, text:string){ const a = readPlan(); a.splice(Math.max(0,index-1),0,{text:norm(text),done:false}); writePlan(a); bumpCursor(a); }
export function markPlanDone(index:number, done=true){ const a = readPlan(); const i=Math.max(0,Math.min(a.length-1,index-1)); if(a[i]) a[i].done=done; writePlan(a); bumpCursor(a); }
export function nextIndex(a?:PlanItem[]){ const arr = a ?? readPlan(); const i = arr.findIndex(x=>!x.done); return i===-1 ? 0 : i+1; }
function bumpCursor(a:PlanItem[]){ const st = readState(); st.plan_cursor = nextIndex(a); writeState(st); }

export function appendCheckpoint(note:string){ fs.appendFileSync(PROG, `- [${nowLocal()}] ${norm(note)}\n`); }
export function readProgressLast(n=5){ const ls = lines(PROG).filter(Boolean); return ls.slice(-n); }

export function goalOneLiner(slug:string|null){ if(!slug) return ''; const g = readGoals().find(x=>x.slug===slug); return g?.text ?? ''; }

export function projectHeader(){ // compact codes appended to main header
  const st = readState(); const a = readPlan();
  const bits:string[] = [];
  if (st.active_goal) bits.push(`goal=${st.active_goal}`);
  const nx = nextIndex(a); if (nx>0) bits.push(`nx=${nx}`);
  const ph = sha8(a.map(it=>(it.done?'[x] ':'[ ] ')+it.text).join('\n')); bits.push(`ph=${ph}`);
  return bits.join('|'); // "goal=slug|nx=3|ph=abc12345"
}

export function projectCard(){ // compact text for chat
  const st = readState(); const a = readPlan(); const nx = nextIndex(a);
  const goal = goalOneLiner(st.active_goal);
  const recent = readProgressLast(5);
  const ahead = a.map((it,i)=>({i:i+1,it})).filter(x=>!x.it.done).slice(0,5).map(x=>`${x.i}. [ ] ${x.it.text}`);
  const done = a.filter(x=>x.done).length;
  const out:string[] = [];
  out.push(`Project: ${st.active_goal ?? 'none'}`);
  if (goal) out.push(`Goal: ${goal}`);
  out.push(`Next: ${nx?`[${nx}] ${a[nx-1].text}`:'—'}`);
  out.push(`Plan (next ${ahead.length||0}):`); out.push(ahead.length? ahead.join('\n') : '— none —');
  out.push(`Progress: ${done}/${a.length} done`);
  if (recent.length){ out.push('Recent checkpoints:'); out.push(recent.join('\n')); }
  out.push('Actions: plan add <text> | plan done <n> | plan insert <n> <text> | checkpoint: <note> | project show');
  return out.join('\n');
}
