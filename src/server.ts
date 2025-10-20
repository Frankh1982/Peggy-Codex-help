import 'dotenv/config';
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
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
  readProgressEntries,
  getRecentChatLines,
  readScratch,
  writeScratch,
  resetScratch,
  clearRuleSection,
} from './lib/memory';

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

function toKebabCase(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
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
};

function buildSettingsPayload(stateOverride?: ReturnType<typeof readState>): SettingsPayload {
  const state = stateOverride ?? readState();
  const prefs = getPrefs();
  const counts = ruleCounts();
  return {
    rev: state.rev,
    prefs,
    rs: rulesHash(),
    rules_counts: counts,
    active_goal: state.active_goal ?? null,
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

const app = express();
app.use(express.static('public'));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/chat' });

wss.on('connection', (ws) => {
  const runHash = crypto.randomBytes(4).toString('hex');
  const st0 = readState();
  let chattyFollowUps = 0;
  let chattyFollowUpIndex = 0;
  const chattyFollowUpMessages = [
    'Deeper on A or B, or move on?',
    'Clarify X or Y, or next?',
    'Need code, risks, or summary?',
  ];
  send(ws, { type: 'system', text: 'ready.' });
  send(ws, { type: 'hash', value: runHash });
  send(ws, { type: 'mem', rev: st0.rev });
  sendSettingsUpdate(ws, st0);

  ws.on('message', async (data: Buffer) => {
    // normalize input
    let text = data.toString();
    try { const m = JSON.parse(text); if (typeof m?.text === 'string') text = m.text; } catch {}

    const profile = readProfile();
    const state = readState();
    const lowerText = text.trim().toLowerCase();
    chattyFollowUps = 0;

    // Always log user msg
    appendChat('user', text);
    recordRecipeIntent(text);
    recordExplainIntent(text);

    // Helper to stream deterministic replies
    type StreamOptions = { skipPostProcess?: boolean; sendSettings?: boolean };

    function sendChattyFollowUp() {
      if (chattyFollowUps >= 2) return;
      if (chattyFollowUpMessages.length === 0) return;
      const followUp = chattyFollowUpMessages[chattyFollowUpIndex % chattyFollowUpMessages.length];
      chattyFollowUpIndex = (chattyFollowUpIndex + 1) % chattyFollowUpMessages.length;
      send(ws, { type: 'assistant_start' });
      send(ws, { type: 'assistant_chunk', text: followUp });
      send(ws, { type: 'assistant', text: followUp });
      appendChat('assistant', followUp);
      chattyFollowUps += 1;
    }

    function maybeSendChattyFollowUp() {
      const prefsNow = getPrefs();
      if (prefsNow.chatty !== 1) {
        chattyFollowUps = 0;
        chattyFollowUpIndex = 0;
        return;
      }
      if (chattyFollowUps >= 2) {
        return;
      }
      sendChattyFollowUp();
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
      maybeSendChattyFollowUp();
    };

    const streamWithMem = (reply: string, options: StreamOptions = {}) => {
      streamReply(reply, options);
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

    const activeGoalMatch = text.match(/^set active goal to\s+(.+)$/i);
    if (activeGoalMatch) {
      const rawGoal = activeGoalMatch[1].trim();
      const slug = toKebabCase(rawGoal);
      if (!slug) {
        streamReply('Please provide a goal name to set.');
        return;
      }
      const updated = {
        ...state,
        rev: state.rev + 1,
        last_seen: new Date().toISOString(),
        active_goal: slug,
      };
      writeState(updated);
      appendLog('goal_set', { active_goal: slug });
      streamReply(`Active goal set to ${slug}.`);
      send(ws, { type: 'mem', rev: updated.rev });
      sendSettingsUpdate(ws, updated);
      return;
    }

    const checkpointMatch = text.match(/^checkpoint:\s*(.+)$/i);
    if (checkpointMatch) {
      const note = checkpointMatch[1].trim();
      if (!note) {
        streamReply('Please provide a checkpoint note.');
        return;
      }
      appendProgressEntry(note);
      const st = bumpState();
      streamReply('Checkpoint saved.');
      send(ws, { type: 'mem', rev: st.rev });
      return;
    }

    if (lowerText === 'list progress') {
      const entries = readProgressEntries(5);
      const reply = entries.length ? entries.join('\n') : 'No progress logged yet.';
      streamReply(reply, { skipPostProcess: true });
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
        const completion = await openai.chat.completions.create({
          model: MODEL,
          messages: [
            { role: 'system', content: readPersona() },
            { role: 'system', content: headerLine(profile, state.rev) },
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

    // 8) Model path with compact header
    const header = headerLine(profile, state.rev);
    send(ws, { type: 'assistant_start' });

    try {
      const stream = await openai.chat.completions.create({
        model: MODEL,
        stream: true,
        messages: [
          { role: 'system', content: readPersona() },
          { role: 'system', content: header },
          { role: 'user', content: text }
        ]
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
      const st = bumpState();
      send(ws, { type: 'mem', rev: st.rev });
      maybeSendChattyFollowUp();

    } catch (err: any) {
      const processed = applyPostProcess('unknown with current context (model error).');
      send(ws, { type: 'assistant', text: processed });
      appendChat('assistant', processed);
      maybeSendChattyFollowUp();
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
