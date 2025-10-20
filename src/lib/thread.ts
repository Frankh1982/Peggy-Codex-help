import fs from 'fs';
import path from 'path';

const AGENT = path.join(process.cwd(), 'memory', 'agent');
const THREAD_DIR = path.join(AGENT, 'threads');
const ACTIVE = path.join(THREAD_DIR, 'active.json');
const SNAPS = path.join(THREAD_DIR, 'snaps');

type Turn = { t: string; role: 'user' | 'assistant'; snip: string };
export type Thread = {
  id: string;
  started_at: string;
  topic: string | null;
  referent: string | null;
  open_q: string | null;
  last_turns: Turn[];
  turn: number;
};

function mkdirp(p: string) {
  fs.mkdirSync(p, { recursive: true });
}
function now() {
  return new Date().toISOString();
}
function snip(s: string, n = 120) {
  const x = s.replace(/\s+/g, ' ').trim();
  return x.length > n ? x.slice(0, n - 1) + '…' : x;
}
function slugify(s: string) {
  return s.toLowerCase().trim().replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '');
}
function threadPath(id: string) {
  return path.join(SNAPS, `${id}.json`);
}

export function initThreads() {
  mkdirp(THREAD_DIR);
  mkdirp(SNAPS);
  if (!fs.existsSync(ACTIVE)) fs.writeFileSync(ACTIVE, JSON.stringify({ id: 'default' }, null, 2));
  const a = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
  const p = threadPath(a.id);
  if (!fs.existsSync(p)) {
    const th: Thread = {
      id: a.id,
      started_at: now(),
      topic: null,
      referent: null,
      open_q: null,
      last_turns: [],
      turn: 0,
    };
    fs.writeFileSync(p, JSON.stringify(th, null, 2));
  }
}

export function getActiveId(): string {
  const a = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
  return a.id;
}

export function loadThread(id?: string): Thread {
  const tid = id || getActiveId();
  return JSON.parse(fs.readFileSync(threadPath(tid), 'utf8')) as Thread;
}

export function saveThread(th: Thread) {
  fs.writeFileSync(threadPath(th.id), JSON.stringify(th, null, 2));
}

export function setActive(id: string) {
  fs.writeFileSync(ACTIVE, JSON.stringify({ id }, null, 2));
  if (!fs.existsSync(threadPath(id))) {
    const th: Thread = {
      id,
      started_at: now(),
      topic: null,
      referent: null,
      open_q: null,
      last_turns: [],
      turn: 0,
    };
    saveThread(th);
  }
}

export function noteUser(text: string) {
  const th = loadThread();
  th.turn += 1;
  if (!th.topic) th.topic = guessTopic(text) || th.topic;
  const ref = guessReferent(text);
  if (ref) th.referent = ref;
  th.open_q = null;
  th.last_turns.push({ t: now(), role: 'user', snip: snip(text) });
  th.last_turns = th.last_turns.slice(-6);
  saveThread(th);
}

export function noteAssistant(text: string, opts?: { clarifying?: boolean }) {
  const th = loadThread();
  th.last_turns.push({ t: now(), role: 'assistant', snip: snip(text) });
  th.last_turns = th.last_turns.slice(-6);
  if (opts?.clarifying) th.open_q = snip(text, 80);
  saveThread(th);
}

export function setTopic(topic: string) {
  const th = loadThread();
  th.topic = topic.trim() || null;
  saveThread(th);
}

export function setReferent(ref: string | null) {
  const th = loadThread();
  th.referent = ref && ref.trim() ? ref.trim() : null;
  saveThread(th);
}

export function headerBits(): string {
  const th = loadThread();
  const bits: string[] = [];
  if (th.topic) bits.push(`topic=${slugify(th.topic)}`);
  if (th.referent) bits.push(`ref=${slugify(th.referent)}`);
  if (th.open_q) bits.push(`oq=1`);
  return bits.join('|');
}

export function resumeBanner(): string | null {
  const th = loadThread();
  if (!th.topic && !th.referent && th.last_turns.length === 0) return null;
  const last = th.last_turns
    .slice(-2)
    .map((x) => `${x.role[0]}> ${x.snip}`)
    .join('\n');
  const topic = th.topic ? `Topic: ${th.topic}` : 'Topic: —';
  const ref = th.referent ? `Referent: ${th.referent}` : 'Referent: —';
  const oq = th.open_q ? `Open Q: ${th.open_q}` : '';
  return [topic, ref, oq, last ? 'Recent:\n' + last : ''].filter(Boolean).join('\n');
}

function guessTopic(text: string): string | null {
  const m =
    /(about|on|re)\s+([A-Za-z][\w\- ]{2,40})/i.exec(text) ||
    /^(explain|tell me about)\s+([A-Za-z][\w\- ]{2,40})/i.exec(text);
  return m ? m[2] : null;
}
function guessReferent(text: string): string | null {
  const m = /(agi|recipe|salsa|pesto|websocket|memory|plan|goal|project)/i.exec(text);
  return m ? m[1] : null;
}

export function pronounHintIfAny(userText: string): string | null {
  if (/\b(it|this|that|they|them)\b/i.test(userText)) {
    const th = loadThread();
    if (th.referent) return `User likely refers to: ${th.referent}`;
    if (th.topic) return `User likely refers to: ${th.topic}`;
  }
  return null;
}
