import 'dotenv/config';
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import {
  initMemory,
  ensureRules,
  readProfile,
  writeProfile,
  readState,
  writeState,
  bumpState,
  appendChat,
  appendLog,
  headerLine,
  parseNameIntent,
  asksForName,
  setPref,
  listPrefs,
  getPrefs,
  addRule,
  delRule,
  delRuleAt,
  listRules,
  replaceRule,
  rulesHash,
  ruleCounts,
  appendProgressEntry,
  getRecentChatLines,
  readScratch,
  writeScratch,
  resetScratch,
  clearRuleSection,
} from './lib/memory';
import {
  initProjectFiles,
  setActiveGoal,
  ensureGoal,
  readPlan,
  addPlanItem,
  insertPlanItem,
  markPlanDone,
  appendCheckpoint,
  projectCard,
  projectHeader,
  readProgressLast,
  readState as readProjState,
} from './lib/project';
import {
  initThreads,
  noteUser,
  noteAssistant,
  headerBits as threadHeader,
  resumeBanner,
  setActive as setActiveThread,
  setTopic,
  setReferent,
  pronounHintIfAny,
  loadThread,
} from './lib/thread';

function postProcess(
  finalText: string,
  profile: ReturnType<typeof readProfile>,
  prefs: ReturnType<typeof getPrefs>,
  rules: ReturnType<typeof listRules>,
): string {
  const limits = [20, 60, 90, 180];
  const vIdx = Math.max(0, Math.min(3, prefs.verbosity ?? 1));
  const cap = limits[vIdx];

  // 1) enforce verbosity (word cap)
  const words = finalText.split(/\s+/);
  if (words.length > cap) finalText = words.slice(0, cap).join(' ') + '…';

  // 2) tone
  if (prefs.tone === 'direct') {
    finalText = finalText.replace(/^(?:Sure|Happy to help|Absolutely|Of course|Gladly)[—,: ]\s*/i, '');
  } else if (prefs.tone === 'friendly') {
    if (!/^(Sure|Happy to help|Absolutely|Of course|Gladly)[—,: ]\s*/i.test(finalText)) {
      finalText = `Sure — ${finalText}`;
    }
  }

  // 3) anti-sycophancy (syc=true means anti is ON)
  if (prefs.syc === true) {
    const deny = /(great question|brilliant|excellent point|i[’']m impressed|fantastic idea)/gi;
    finalText = finalText.replace(deny, '').replace(/\s{2,}/g, ' ').trim();
  }

  // 4) rules
  const rs = rules.sections || [];
  const has = (id: string, substrs: string[]) =>
    !!rs.find(
      (s) =>
        s.id?.toLowerCase() === id &&
        s.items?.some((x: string) => substrs.every((k) => x.toLowerCase().includes(k))),
    );

  // greet by name
  if (profile.name && has('style', ['greet', 'name'])) {
    finalText = `${profile.name} — ${finalText}`;
  }
  // no cilantro
  const cilantroRule = has('preferences', ['never', 'cilantro']);
  if (cilantroRule) {
    finalText = finalText.replace(/\b(cilantro|coriander)\b/gi, 'parsley');
    const hasIngredientsHeading = /Ingredients/i.test(finalText);
    const hasBulletLine = /^\s*-\s+/m.test(finalText);
    const noteNeeded = hasIngredientsHeading && hasBulletLine;
    if (noteNeeded && !/cilantro avoided per your preference/i.test(finalText)) {
      finalText += '\n\n(Note: cilantro avoided per your preference; substituted with parsley.)';
    }
  }
  // codex-only (no code fences)
  if (has('output', ['only', 'codex', 'no code'])) {
    finalText = finalText.replace(/```[\s\S]*?```/g, '').trim();
  }

  return finalText;
}

function applyPostProcess(text: string): string {
  const prefs = getPrefs();
  const rules = listRules();
  const profile = readProfile();
  return postProcess(text, profile, prefs, rules);
}

const STOP = new Set([
  'the',
  'and',
  'that',
  'with',
  'from',
  'this',
  'into',
  'over',
  'they',
  'them',
  'have',
  'has',
  'for',
  'are',
  'was',
  'were',
  'than',
  'then',
  'also',
  'such',
  'very',
  'more',
  'most',
  'about',
  'your',
  'you',
  'can',
  'will',
  'able',
  'what',
  'which',
  'who',
  'whom',
  'whose',
  'when',
  'where',
  'why',
  'how',
  'please',
  'thanks',
  'thank',
  'frank',
  'peggy',
  'okay',
  'ok',
]);

function words(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function topKeywords(text: string, k = 2) {
  const freq: Record<string, number> = {};
  for (const w of words(text)) if (w.length > 3 && !STOP.has(w)) freq[w] = (freq[w] || 0) + 1;
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([w]) => w);
}

function isQuestion(s: string) {
  return /\?\s*$/.test(s) || /^(who|what|why|how|when|where|which)\b/i.test(s);
}

function isYesNo(s: string) {
  return /^(is|are|do|does|did|can|could|should|would|will|has|have|had)\b.*\?$/i.test(s);
}

function detectIntent(u: string, a: string): 'explain' | 'compare' | 'howto' | 'brainstorm' {
  if (/\bcompare|vs\.?|versus\b/i.test(u)) return 'compare';
  if (/\bhow to|steps?|procedure|setup|implement|wire\b/i.test(u)) return 'howto';
  if (/\bidea|brainstorm|options|approach(es)?\b/i.test(u)) return 'brainstorm';
  const sentences = a.split(/[.!?]\s+/).filter(Boolean).length;
  return sentences > 2 ? 'explain' : 'brainstorm';
}

function buildFollowUp(
  lastUser: string,
  lastAnswer: string,
  opts: { tone: 'direct' | 'neutral' | 'friendly' },
): string | null {
  if (isQuestion(lastUser)) return null;
  if (lastAnswer.split(/\s+/).length < 25) return null;

  const intent = detectIntent(lastUser, lastAnswer);
  const [a, b] = topKeywords(lastAnswer, 2);
  const soft = opts.tone === 'friendly' ? 'Sure — ' : '';

  switch (intent) {
    case 'explain':
      if (a && b) return `${soft}Want detail on ${a} or ${b}, or a quick summary?`;
      return `${soft}Want more detail, or a quick summary?`;
    case 'compare':
      if (a && b) return `${soft}Compare ${a} vs ${b}, or jump to a recommendation?`;
      return `${soft}Compare options, or jump to a recommendation?`;
    case 'howto':
      if (a && b) return `${soft}Start with step-by-step, pitfalls, or tools?`;
      return `${soft}Start with steps, pitfalls, or tools?`;
    case 'brainstorm':
      if (a && b) return `${soft}Explore angles on ${a} or ${b}, or move to next actions?`;
      return `${soft}Explore angles or move to next actions?`;
  }

  return null;
}

const PORT = Number(process.env.PORT || 5173);
const MODEL = process.env.MODEL || 'gpt-4o-mini';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function readPersona(): string {
  try {
    const p = path.join(process.cwd(), 'src', 'agent', 'persona.md');
    return fs.readFileSync(p, 'utf8');
  } catch {
    return 'You are a candid, concise assistant. Prefer "unknown with current context".';
  }
}

function tidyFragment(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/[\s.,!?;:]+$/g, '').trim();
}

function extractRecipeName(text: string): string | null {
  const recipeFor = text.match(/recipe\s+for\s+([^?.!]+)/i);
  if (recipeFor) {
    const name = tidyFragment(recipeFor[1]);
    if (name) return name;
  }
  const needRecipe = text.match(/(?:need|want|looking for|find|get|share|show me|give me|make)\s+(?:an?|the)?\s*([^?.!]+?)\s+recipe\b/i);
  if (needRecipe) {
    const name = tidyFragment(needRecipe[1]);
    if (name) return name;
  }
  const trailing = text.match(/([A-Za-z0-9][^?.!]+?)\s+recipe\b/i);
  if (trailing) {
    const name = tidyFragment(trailing[1]);
    if (name) return name;
  }
  return null;
}

function articleFor(phrase: string): 'a' | 'an' {
  return /^[aeiou]/i.test(phrase.trim()) ? 'an' : 'a';
}

function recordRecipeIntent(message: string) {
  const recipe = extractRecipeName(message);
  if (!recipe) return;
  writeScratch((scratch) => {
    const normalized = recipe.replace(/^(?:a|an|the)\s+/i, '').trim();
    if (!normalized) return scratch;
    const topic = normalized.length > 40 ? `${normalized.slice(0, 37)}…` : normalized;
    const nextTopics = scratch.last_topics.filter((item) => item !== topic);
    nextTopics.push(topic);
    while (nextTopics.length > 6) nextTopics.shift();
    return {
      ...scratch,
      last_recipe: normalized,
      last_topics: nextTopics,
    };
  });
}

function recordExplainIntent(message: string) {
  const match = message.trim().match(/^explain\s+(.+)/i);
  if (!match) return;
  const query = tidyFragment(match[1]);
  if (!query) return;
  writeScratch((scratch) => ({
    ...scratch,
    last_query: query,
  }));
}

function send(ws: any, obj: unknown) { try { ws.send(JSON.stringify(obj)); } catch {} }

function normalizeRuleInput(text: string): string {
  if (typeof text !== 'string') return '';
  return text.replace(/\s+/g, ' ').trim().replace(/[.]+$/, '').trim();
}

type SettingsCounts = { style: number; preferences: number; output: number };
type SettingsPayload = {
  rev: number;
  prefs: ReturnType<typeof getPrefs>;
  rs: string;
  rules_counts: SettingsCounts;
  active_goal: string | null;
  plan_next: number;
  plan_hash: string | null;
  thread: { topic: string | null; referent: string | null };
};

function buildSettingsPayload(stateOverride?: ReturnType<typeof readState>): SettingsPayload {
  const state = stateOverride ?? readState();
  const prefs = getPrefs();
  const counts = ruleCounts();
  const projState = readProjState();
  const header = projectHeader();
  const planHash = header.split('|').find((s) => s.startsWith('ph='))?.slice(3) ?? null;
  return {
    rev: state.rev,
    prefs,
    rs: rulesHash(),
    rules_counts: counts,
    active_goal: projState.active_goal ?? null,
    plan_next: projState.plan_cursor ?? 0,
    plan_hash: planHash,
    thread: { topic: loadThread().topic, referent: loadThread().referent },
  };
}

function sendSettingsUpdate(ws: any, stateOverride?: ReturnType<typeof readState>) {
  const value = buildSettingsPayload(stateOverride);
  send(ws, { type: 'settings', value });
  return value;
}

function hasCilantroPreferenceRule(): boolean {
  const rules = listRules();
  return !!(rules.sections ?? []).find(
    (section) =>
      section.id?.toLowerCase() === 'preferences' &&
      section.items?.some((item) => {
        const lower = item.toLowerCase();
        return lower.includes('never') && lower.includes('cilantro');
      }),
  );
}

initMemory();
ensureRules();
initProjectFiles();
initThreads();

const app = express();
app.use(express.static('public'));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/chat' });

wss.on('connection', (ws) => {
  const runHash = crypto.randomBytes(4).toString('hex');
  const st0 = readState();
  let lastUserText = '';
  send(ws, { type: 'system', text: 'ready.' });
  send(ws, { type: 'hash', value: runHash });
  send(ws, { type: 'mem', rev: st0.rev });
  sendSettingsUpdate(ws, st0);

  const banner = resumeBanner();
  if (banner) {
    const text = `Resuming your last thread:\n${banner}\n\nSay: "resume" to continue, "new topic: <name>" to branch, or ask directly.`;
    send(ws, { type: 'assistant_start' });
    send(ws, { type: 'assistant', text });
    noteAssistant(text);
  }

  ws.on('message', async (data: Buffer) => {
    // normalize input
    let text = data.toString();
    try { const m = JSON.parse(text); if (typeof m?.text === 'string') text = m.text; } catch {}

    noteUser(text);
    const profile = readProfile();
    const state = readState();
    const lowerText = text.trim().toLowerCase();
    lastUserText = text;

    // Always log user msg
    appendChat('user', text);
    recordRecipeIntent(text);
    recordExplainIntent(text);

    // Helper to stream deterministic replies
    type StreamOptions = { skipPostProcess?: boolean; sendSettings?: boolean; clarifying?: boolean };

    function maybeSendFollowUp(finalText: string, options: StreamOptions = {}) {
      if (options.clarifying) return;
      const prefsNow = getPrefs();
      if (prefsNow.chatty !== 1) return;
      if (/^(search|summarize):/i.test(lastUserText.trim())) return;
      const tone: 'direct' | 'neutral' | 'friendly' =
        prefsNow.tone === 'direct' ? 'direct' : prefsNow.tone === 'friendly' ? 'friendly' : 'neutral';
      const followUp = buildFollowUp(lastUserText, finalText, { tone });
      if (!followUp) return;
      send(ws, { type: 'assistant', text: followUp });
      appendChat('assistant', followUp);
      noteAssistant(followUp);
    }

    const streamReply = (reply: string, options: StreamOptions = {}) => {
      const processed = options.skipPostProcess ? reply : applyPostProcess(reply);
      send(ws, { type: 'assistant_start' });
      const lines = processed.split(/(\n)/);
      for (const part of lines) {
        if (!part) continue;
        send(ws, { type: 'assistant_chunk', text: part });
      }
      send(ws, { type: 'assistant', text: processed });
      appendChat('assistant', processed);
      noteAssistant(processed, { clarifying: options.clarifying });
      maybeSendFollowUp(processed, options);
    };

    const streamWithMem = (reply: string, options: StreamOptions = {}) => {
      streamReply(reply, options);
      const st = bumpState();
      send(ws, { type: 'mem', rev: st.rev });
      if (options.sendSettings) {
        sendSettingsUpdate(ws, st);
      }
    };

    const streamDeterministic = (
      finalText: string,
      options: { chunk?: string; skipPostProcess?: boolean; sendSettings?: boolean; clarifying?: boolean } = {},
    ) => {
      send(ws, { type: 'assistant_start' });
      if (options.chunk) {
        send(ws, { type: 'assistant_chunk', text: options.chunk });
      }
      const processed = options.skipPostProcess ? finalText : applyPostProcess(finalText);
      send(ws, { type: 'assistant', text: processed });
      appendChat('assistant', processed);
      noteAssistant(processed, { clarifying: options.clarifying });
      maybeSendFollowUp(processed, options);
      const st = bumpState();
      send(ws, { type: 'mem', rev: st.rev });
      if (options.sendSettings) {
        sendSettingsUpdate(ws, st);
      }
    };

    // 1) Name set intent (deterministic, no model call)
    const setTo = parseNameIntent(text);
    if (setTo) {
      const before = profile.name;
      profile.name = setTo;
      writeProfile(profile);
      appendLog('name_set', { before, after: setTo });
      streamWithMem(`Noted. I’ll use ${setTo}.`, { sendSettings: true });
      return;
    }

    // 2) Name query (deterministic, no model call)
    if (asksForName(text)) {
      const reply = profile.name
        ? `Your name is ${profile.name}.`
        : `unknown with current context. Say: "set my name to Frank".`;
      streamWithMem(reply);
      return;
    }

    // 3) Capability card (deterministic)
    if (/^what can you do\??$/i.test(lowerText)) {
      const card = [
        'Adjustable prefs:',
        '- verbosity (0–3): “set verbosity to 0/1/2/3”, or “be more/less verbose”',
        '- anti-sycophancy (on/off): “toggle anti-sycophancy”, “be more/less agreeable”',
        '- tone (direct/neutral/friendly): “set tone to friendly”',
        '- formality (low/med/high): “set formality to high”',
        '- guard (strict/normal): “set guard to strict”',
        '',
        'Durable rules (sectioned):',
        '- “remember that I never want cilantro in my recipes”  → preferences',
        '- “remember that I always want you to greet me with my name” → style',
        '- “remember that I only want codex responses and no code” → output',
        'Also: “add a rule to <section>: <text>”, “remove the rule from <section>: <text>”, “list my rules”',
        '',
        'Ask: “list my prefs” to see current settings.',
      ].join('\n');
      streamReply(card);
      return;
    }

    // 4) Preference setters
    const prefMatch = lowerText.match(/^set verbosity to\s+(\d)\b/);
    if (prefMatch) {
      const target = Math.max(0, Math.min(3, Number(prefMatch[1])));
      setPref('verbosity', target);
      appendLog('pref_set', { key: 'verbosity', value: target });
      streamWithMem(`Verbosity set to ${target}.`, { sendSettings: true });
      return;
    }

    if (/\bbe more verbose\b/.test(lowerText) || /\bbe less verbose\b/.test(lowerText)) {
      const current = profile.prefs.verbosity;
      const delta = /\bbe more verbose\b/.test(lowerText) ? 1 : -1;
      const target = Math.max(0, Math.min(3, current + delta));
      setPref('verbosity', target);
      appendLog('pref_set', { key: 'verbosity', value: target });
      streamWithMem(`Verbosity set to ${target}.`, { sendSettings: true });
      return;
    }

    if (/\btoggle\s+anti-?sycophancy\b/.test(lowerText)) {
      const current = profile.prefs.syc;
      const next = !current;
      setPref('syc', next);
      appendLog('pref_set', { key: 'syc', value: next });
      streamWithMem(`Anti-sycophancy ${next ? 'enabled' : 'disabled'}.`, { sendSettings: true });
      return;
    }

    const sycSwitch = lowerText.match(/anti-?sycophancy\s+(on|off)\b/);
    if (sycSwitch) {
      const next = sycSwitch[1] === 'on';
      setPref('syc', next);
      appendLog('pref_set', { key: 'syc', value: next });
      streamWithMem(`Anti-sycophancy ${next ? 'enabled' : 'disabled'}.`, { sendSettings: true });
      return;
    }

    if (/\bbe more agreeable\b/.test(lowerText) || /\bbe less agreeable\b/.test(lowerText)) {
      const next = /\bbe less agreeable\b/.test(lowerText);
      setPref('syc', next);
      appendLog('pref_set', { key: 'syc', value: next });
      streamWithMem(`Anti-sycophancy ${next ? 'enabled' : 'disabled'}.`, { sendSettings: true });
      return;
    }

    const toneMatch = lowerText.match(/set tone to\s+(direct|neutral|friendly)\b/);
    if (toneMatch) {
      const val = toneMatch[1] as 'direct' | 'neutral' | 'friendly';
      setPref('tone', val);
      appendLog('pref_set', { key: 'tone', value: val });
      streamWithMem(`Tone set to ${val}.`, { sendSettings: true });
      return;
    }

    const formalityMatch = lowerText.match(/set formality to\s+(low|med|high)\b/);
    if (formalityMatch) {
      const val = formalityMatch[1] as 'low' | 'med' | 'high';
      setPref('formality', val);
      appendLog('pref_set', { key: 'formality', value: val });
      streamWithMem(`Formality set to ${val}.`, { sendSettings: true });
      return;
    }

    const guardMatch = lowerText.match(/set guard to\s+(strict|normal)\b/);
    if (guardMatch) {
      const val = guardMatch[1] as 'strict' | 'normal';
      setPref('guard', val);
      appendLog('pref_set', { key: 'guard', value: val });
      streamWithMem(`Guard set to ${val}.`, { sendSettings: true });
      return;
    }

    const chattySwitch = lowerText.match(/^chatty\s+(on|off)$/);
    if (chattySwitch) {
      const next = chattySwitch[1] === 'on' ? 1 : 0;
      setPref('chatty', next);
      appendLog('pref_set', { key: 'chatty', value: next });
      streamReply(`Chatty: ${next ? 'on' : 'off'}.`);
      const st = bumpState();
      send(ws, { type: 'mem', rev: st.rev });
      sendSettingsUpdate(ws, st);
      return;
    }

    // 5) Preference queries
    if (/^list my prefs$/.test(lowerText)) {
      const prefs = listPrefs();
      const summary = JSON.stringify(prefs);
      streamReply(summary);
      return;
    }

    if (/^show settings$/.test(lowerText)) {
      const payload = buildSettingsPayload();
      const json = JSON.stringify(payload, null, 2);
      streamReply(json, { skipPostProcess: true });
      return;
    }

    // 1) Initialize a project with one-liner goal
    // "project: init <slug> - <one line goal>"
    if (/^project:\s*init\s+/i.test(text)) {
      const m = /^project:\s*init\s+([A-Za-z0-9\-_ ]+)\s*-\s*(.+)$/i.exec(text);
      if (m) {
        const slug = m[1];
        const one = m[2];
        ensureGoal(slug, one);
        const card = projectCard();
        const trimmed = slug.trim();
        streamDeterministic(`Created project "${trimmed}".\n${card}`, {
          chunk: `Created project "${trimmed}".\n`,
          skipPostProcess: true,
          sendSettings: true,
        });
        return;
      }
    }

    // 2) Set active goal
    // "set active goal to <slug>"
    {
      const m = /^set active goal to (.+)$/i.exec(text);
      if (m) {
        setActiveGoal(m[1]);
        const card = projectCard();
        streamDeterministic(card, { skipPostProcess: true, sendSettings: true, chunk: 'Active goal set.\n' });
        return;
      }
    }

    // 3) Show/resume project
    if (/^(project:\s*show|resume project|what (are we|am i) (doing|working on)\??)$/i.test(text)) {
      const card = projectCard();
      streamDeterministic(card, { skipPostProcess: true });
      return;
    }

    // 4) Plan operations
    {
      let m = /^plan:\s*add\s+(.+)$/i.exec(text);
      if (m) {
        addPlanItem(m[1]);
        const card = projectCard();
        streamDeterministic(card, {
          chunk: `Added: "${m[1].trim()}".\n`,
          skipPostProcess: true,
          sendSettings: true,
        });
        return;
      }

      m = /^plan:\s*insert\s+(\d+)\s+(.+)$/i.exec(text);
      if (m) {
        insertPlanItem(Number(m[1]), m[2]);
        streamDeterministic(`Inserted at ${m[1]}.`, { skipPostProcess: true, sendSettings: true });
        return;
      }

      m = /^plan:\s*done\s+(\d+)$/i.exec(text);
      if (m) {
        markPlanDone(Number(m[1]), true);
        const nx = readProjState().plan_cursor;
        const nxt = (nx ? readPlan()[nx - 1]?.text : null) || '—';
        const nextLine = nx ? `[${nx}] ${nxt}` : '—';
        streamDeterministic(`Marked ${m[1]} done. Next: ${nextLine}`, {
          skipPostProcess: true,
          sendSettings: true,
        });
        return;
      }

      if (/^plan:\s*next$/i.test(text)) {
        const nx = readProjState().plan_cursor;
        const nxt = (nx ? readPlan()[nx - 1]?.text : null) || '—';
        const nextLine = nx ? `[${nx}] ${nxt}` : 'No remaining steps.';
        streamDeterministic(nx ? `Next: ${nextLine}` : 'No remaining steps.', {
          skipPostProcess: true,
        });
        return;
      }
    }

    // 5) Checkpoints & progress
    {
      let m = /^checkpoint:\s+(.+)$/i.exec(text);
      if (m) {
        appendCheckpoint(m[1]);
        const last = readProgressLast(3).join('\n');
        streamDeterministic(`Checkpoint saved.\n${last}`, { skipPostProcess: true });
        return;
      }

      if (/^list progress$/i.test(text)) {
        const last = readProgressLast(5).join('\n') || '—';
        streamDeterministic(last, { skipPostProcess: true });
        return;
      }
    }

    if (/^what did i ask for last\??$/.test(lowerText)) {
      const scratch = readScratch();
      if (scratch.last_recipe) {
        const article = articleFor(scratch.last_recipe);
        streamReply(`Your last request was ${article} ${scratch.last_recipe} recipe.`);
      } else if (scratch.last_query) {
        const questionText = /[.!?]$/.test(scratch.last_query) ? scratch.last_query : `${scratch.last_query}.`;
        streamReply(`Your last question was: ${questionText}`);
      } else {
        streamReply('Unknown with current context.');
      }
      return;
    }

    if (/^clear scratch$/.test(lowerText)) {
      resetScratch();
      appendLog('scratch_reset', {});
      streamWithMem('Scratch cleared.');
      return;
    }

    // 6) Rules management commands
    if (/^rules:\s*show$/i.test(lowerText)) {
      const rules = listRules();
      const headerLineText = `rules rev ${rules.rev} rs=${rulesHash()}`;
      const lines = [headerLineText];
      for (const section of rules.sections ?? []) {
        lines.push(`${section.id}:`);
        if (!section.items || section.items.length === 0) {
          lines.push('- (none)');
          continue;
        }
        section.items.forEach((item, idx) => {
          lines.push(`${idx + 1}. ${item}`);
        });
      }
      streamReply(lines.join('\n'), { skipPostProcess: true });
      return;
    }

    const rulesAddCommand = text.match(/^rules:\s*add\s+([\w-]+)\s+(.+)/i);
    if (rulesAddCommand) {
      const section = rulesAddCommand[1];
      const rawRule = rulesAddCommand[2];
      const normalized = normalizeRuleInput(rawRule);
      if (!normalized) {
        streamReply('Please provide rule text to add.');
        return;
      }
      try {
        const targetSection = section.trim().toLowerCase();
        addRule(targetSection, normalized);
        appendLog('rule_add', { section: targetSection, text: normalized });
        streamWithMem(`Added rule to ${targetSection}: "${normalized}".`, { sendSettings: true });
      } catch (err: any) {
        streamReply(`Could not add rule: ${err?.message || String(err)}.`);
      }
      return;
    }

    const rulesReplaceCommand = text.match(/^rules:\s*replace\s+([\w-]+)\s+(\d+)\s*->\s*(.+)$/i);
    if (rulesReplaceCommand) {
      const section = rulesReplaceCommand[1];
      const index = Number(rulesReplaceCommand[2]);
      const replacement = normalizeRuleInput(rulesReplaceCommand[3]);
      if (!replacement) {
        streamReply('Please provide replacement text.');
        return;
      }
      try {
        const result = replaceRule(section, index, replacement);
        appendLog('rule_replace', { section: result.section, index: result.index, text: result.after });
        streamWithMem(`Replaced rule ${result.index} in ${result.section}: "${result.after}".`, { sendSettings: true });
      } catch (err: any) {
        streamReply(`Could not replace rule: ${err?.message || String(err)}.`);
      }
      return;
    }

    const rulesDeleteCommand = text.match(/^rules:\s*(?:del|delete)\s+([\w-]+)\s+(\d+)$/i);
    if (rulesDeleteCommand) {
      const section = rulesDeleteCommand[1];
      const index = Number(rulesDeleteCommand[2]);
      try {
        const result = delRuleAt(section, index);
        appendLog('rule_del', { section: result.section, index: result.index, text: result.text });
        streamWithMem(`Removed rule ${result.index} from ${result.section}.`, { sendSettings: true });
      } catch (err: any) {
        streamReply(`Could not delete rule: ${err?.message || String(err)}.`);
      }
      return;
    }

    const rulesClearCommand = text.match(/^rules:\s*clear\s+([\w-]+)$/i);
    if (rulesClearCommand) {
      const section = rulesClearCommand[1];
      try {
        const result = clearRuleSection(section);
        if (result.removed === 0) {
          streamReply(`No rules to clear in ${result.section}.`);
        } else {
          streamWithMem(`Cleared ${result.removed} rule(s) in ${result.section}.`, { sendSettings: true });
        }
      } catch (err: any) {
        streamReply(`Could not clear rules: ${err?.message || String(err)}.`);
      }
      return;
    }

    // 7) Rules add via "remember"
    const rememberMatch = text.match(/remember that\s+(.+)/i);
    if (rememberMatch) {
      const rawRule = rememberMatch[1];
      const normalized = normalizeRuleInput(rawRule);
      if (!normalized) {
        streamReply('Please provide a rule to remember.');
        return;
      }
      const lowered = normalized.toLowerCase();
      let section = 'preferences';
      if (/(greet|greeting|name)/i.test(lowered)) {
        section = 'style';
      } else if (/(codex|code)/i.test(lowered)) {
        section = 'output';
      } else if (/(recipe|food|ingredient|cilantro)/i.test(lowered)) {
        section = 'preferences';
      }
      try {
        addRule(section, normalized);
        appendLog('rule_add', { section, text: normalized });
        streamWithMem(`Added rule to ${section}: "${normalized}".`, { sendSettings: true });
      } catch (err: any) {
        streamReply(`Could not add rule: ${err?.message || String(err)}.`);
      }
      return;
    }

    const addRuleMatch = text.match(/add a rule to\s+(\w+):\s+(.+)/i);
    if (addRuleMatch) {
      const section = addRuleMatch[1].trim().toLowerCase();
      const normalized = normalizeRuleInput(addRuleMatch[2]);
      if (!normalized) {
        streamReply('Please provide rule text to add.');
        return;
      }
      try {
        addRule(section, normalized);
        appendLog('rule_add', { section, text: normalized });
        streamWithMem(`Added rule to ${section}: "${normalized}".`, { sendSettings: true });
      } catch (err: any) {
        streamReply(`Could not add rule: ${err?.message || String(err)}.`);
      }
      return;
    }

    const removeRuleMatch = text.match(/remove the rule from\s+(\w+):\s+(.+)/i);
    if (removeRuleMatch) {
      const section = removeRuleMatch[1].trim().toLowerCase();
      const normalized = normalizeRuleInput(removeRuleMatch[2]);
      if (!normalized) {
        streamReply('Please specify which rule to remove.');
        return;
      }
      const before = JSON.stringify(listRules());
      delRule(section, normalized);
      const after = JSON.stringify(listRules());
      if (before !== after) {
        appendLog('rule_del', { section, text: normalized });
        streamWithMem(`Removed rule from ${section}: "${normalized}".`, { sendSettings: true });
      } else {
        streamReply(`No matching rule found in ${section}: "${normalized}".`);
      }
      return;
    }

    if (/^list my rules$/.test(lowerText)) {
      const rules = listRules();
      const headerLineText = `rules rev ${rules.rev} rs=${rulesHash()}`;
      const lines = [headerLineText];
      for (const section of rules.sections) {
        const entries = section.items.slice(0, 5);
        lines.push(`${section.id}:`);
        if (entries.length === 0) {
          lines.push('- (none)');
        } else {
          for (const item of entries) {
            lines.push(`- ${item}`);
          }
          if (section.items.length > entries.length) {
            lines.push(`- … (${section.items.length - entries.length} more)`);
          }
        }
      }
      streamReply(lines.join('\n'));
      return;
    }

    if (lowerText === 'summarize session') {
      const recent = getRecentChatLines(30).filter((line) => line.role === 'user' || line.role === 'assistant');
      if (recent.length <= 1) {
        streamReply('Not enough conversation history to summarize.');
        return;
      }
      const trimmed = recent.slice(0, -1);
      const window = trimmed.slice(-10);
      if (window.length === 0) {
        streamReply('Not enough conversation history to summarize.');
        return;
      }
      const transcript = window
        .map((entry) => `${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.content}`)
        .join('\n');
      try {
        const prompt = `${text.trim()}\n\nRecent conversation (chronological):\n${transcript}\n\nProvide a clear summary in 90-120 words.`;
        const hint = pronounHintIfAny(text);
        const header = headerLine(profile, state.rev);
        const pHeader = projectHeader?.() || '';
        const thHeader = threadHeader();
        const mergedHeader = [header, pHeader, thHeader].filter(Boolean).join('|');
        const sysMsgs: ChatCompletionMessageParam[] = [
          { role: 'system', content: readPersona() },
          { role: 'system', content: mergedHeader },
        ];
        if (hint) sysMsgs.push({ role: 'system', content: hint });
        const completion = await openai.chat.completions.create({
          model: MODEL,
          messages: [
            ...sysMsgs,
            { role: 'user', content: prompt },
          ],
        });
        const summary = completion.choices?.[0]?.message?.content?.trim();
        if (!summary) {
          streamReply('Summary request failed.');
          return;
        }
        const words = summary.split(/\s+/).filter(Boolean);
        const limited = words.length > 120 ? words.slice(0, 120).join(' ') : summary;
        appendProgressEntry(`Summary: ${limited}`);
        const st = bumpState();
        const firstSentenceMatch = limited.match(/[^.!?]+[.!?]/);
        const firstSentence = (firstSentenceMatch ? firstSentenceMatch[0] : limited.split(/\n/)[0] || limited).trim();
        streamReply(`${firstSentence} (saved)`);
        send(ws, { type: 'mem', rev: st.rev });
      } catch (err: any) {
        streamReply(`Could not summarize: ${err?.message || String(err)}.`);
      }
      return;
    }

    // Guard behavior for unknown personal data
    const guardSensitive = text.match(/\b(my|mine)\s+(shoe size|birthday|age|height|weight|phone|email|address)\b/i);
    if (guardSensitive) {
      const field = guardSensitive[2].toLowerCase();
      const known = (profile as any)[field];
      if (known == null) {
        const prefsNow = getPrefs();
        const reply =
          prefsNow.guard === 'normal'
            ? `What is your ${field}?`
            : `unknown with current context. Provide one minimal fact (e.g., your ${field}).`;
        streamWithMem(reply);
        return;
      }
    }

    if (/^no cilantro\??$/i.test(text.trim())) {
      const hasRule = hasCilantroPreferenceRule();
      const reply = hasRule
        ? 'Yes — cilantro is avoided and replaced with parsley per your preference.'
        : 'No rule set. Say: "remember that I never want cilantro in my recipes".';
      streamReply(reply, { skipPostProcess: true });
      return;
    }

    {
      const m = /^referent:\s*(.+)$/i.exec(text);
      if (m) {
        setReferent(m[1]);
        const trimmed = m[1].trim();
        const msg = `Referent set to "${trimmed}".`;
        streamDeterministic(msg, { skipPostProcess: true, sendSettings: true });
        return;
      }
    }

    if (/^resume$/i.test(text)) {
      const card = resumeBanner() || 'No previous thread info.';
      streamDeterministic(card, { skipPostProcess: true });
      return;
    }

    {
      const m = /^(?:let'?s talk about|switch to|new topic:|we were talking about|talk about)\s+(.+?)(?:\.)?$/i.exec(text);
      if (m) {
        const topic = m[1].trim();
        setTopic(topic);
        setReferent(topic);
        const msg = `Topic set to "${topic}". I’ll treat "it" as ${topic}.`;
        streamDeterministic(msg, { skipPostProcess: true, sendSettings: true });
        return;
      }
    }

    if (/^(?:what (?:are we|am i) talking about|what (?:were we|was i) talking about|topic\??|context\??)$/i.test(text)) {
      const card = resumeBanner() || 'No active topic.';
      streamDeterministic(card, { skipPostProcess: true });
      return;
    }

    {
      const m =
        /^(?:look ?up|find|get)\s+(?:papers|articles|studies)(?:\s+on\s+(.*))?$/i.exec(text) ||
        /^(?:look ?up|find)\s+(?:that|this|them|it)$/i.exec(text) ||
        /^(?:give me a summary of|summarize)\s+(?:them|that|this|it)$/i.exec(text);
      if (m) {
        let q = (m[1] || '').trim();
        if (!q) {
          const hint = pronounHintIfAny('that');
          if (hint) q = hint.replace(/^User likely refers to:\s*/i, '');
        }
        if (!q) {
          const msg = 'Unknown referent for "that". Say: new topic: <name> or referent: <thing>.';
          streamDeterministic(msg, { skipPostProcess: true, clarifying: true });
          return;
        }
        const msg = process.env.BRAVE_API_KEY
          ? `Use: search: ${q}\nOr: summarize: ${q}`
          : `Web search isn’t configured. After adding BRAVE_API_KEY, say: search: ${q}`;
        streamDeterministic(msg, { skipPostProcess: true });
        return;
      }
    }

    if (/^\s*(that|this|it|them)\s*$/i.test(text)) {
      const hint = pronounHintIfAny(text);
      const msg = hint
        ? `Are you referring to ${hint.replace(/^User likely refers to:\s*/i, '')}?`
        : 'What is "that" referring to? Say: referent: <thing>.';
      streamDeterministic(msg, { skipPostProcess: true, clarifying: true });
      return;
    }

    // 8) Model path with compact header
    const hint = pronounHintIfAny(text);
    const header = headerLine(profile, state.rev);
    const pHeader = projectHeader?.() || '';
    const thHeader = threadHeader();
    const mergedHeader = [header, pHeader, thHeader].filter(Boolean).join('|');
    const sysMsgs: ChatCompletionMessageParam[] = [
      { role: 'system', content: readPersona() },
      { role: 'system', content: mergedHeader },
    ];
    if (hint) sysMsgs.push({ role: 'system', content: hint });
    send(ws, { type: 'assistant_start' });

    try {
      const stream = await openai.chat.completions.create({
        model: MODEL,
        stream: true,
        messages: [
          ...sysMsgs,
          { role: 'user', content: text },
        ],
      });

      let full = '';
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content || '';
        if (!delta) continue;
        full += delta;
        send(ws, { type: 'assistant_chunk', text: delta });
      }

      const processed = applyPostProcess(full);
      send(ws, { type: 'assistant', text: processed });
      appendChat('assistant', processed);
      noteAssistant(processed);
      const st = bumpState();
      send(ws, { type: 'mem', rev: st.rev });
      maybeSendFollowUp(processed);

    } catch (err: any) {
      const processed = applyPostProcess('unknown with current context (model error).');
      send(ws, { type: 'assistant', text: processed });
      appendChat('assistant', processed);
      noteAssistant(processed);
      maybeSendFollowUp(processed);
      send(ws, { type: 'system', text: `openai error: ${err?.message || String(err)}` });
      appendLog('error', { where: 'openai', msg: err?.message || String(err) });
    }
  });

  ws.on('error', (err: any) => {
    send(ws, { type: 'system', text: `ws error: ${String(err)}` });
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
