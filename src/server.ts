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
  listRules,
  rulesHash,
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
  if (has('preferences', ['never', 'cilantro'])) {
    finalText = finalText.replace(/\b(cilantro|coriander)\b/gi, 'parsley');
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

function send(ws: any, obj: unknown) { try { ws.send(JSON.stringify(obj)); } catch {} }

initMemory();
ensureRules();

const app = express();
app.use(express.static('public'));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/chat' });

wss.on('connection', (ws) => {
  const runHash = crypto.randomBytes(4).toString('hex');
  const st0 = readState();
  send(ws, { type: 'system', text: 'ready.' });
  send(ws, { type: 'hash', value: runHash });
  send(ws, { type: 'mem', rev: st0.rev });

  ws.on('message', async (data: Buffer) => {
    // normalize input
    let text = data.toString();
    try { const m = JSON.parse(text); if (typeof m?.text === 'string') text = m.text; } catch {}

    const profile = readProfile();
    const state = readState();
    const lowerText = text.trim().toLowerCase();

    // Always log user msg
    appendChat('user', text);

    // Helper to stream deterministic replies
    const streamReply = (reply: string) => {
      const processed = applyPostProcess(reply);
      send(ws, { type: 'assistant_start' });
      const lines = processed.split(/(\n)/);
      for (const part of lines) {
        if (!part) continue;
        send(ws, { type: 'assistant_chunk', text: part });
      }
      send(ws, { type: 'assistant', text: processed });
      appendChat('assistant', processed);
    };

    const streamWithMem = (reply: string) => {
      streamReply(reply);
      const st = bumpState();
      send(ws, { type: 'mem', rev: st.rev });
    };

    // 1) Name set intent (deterministic, no model call)
    const setTo = parseNameIntent(text);
    if (setTo) {
      const before = profile.name;
      profile.name = setTo;
      writeProfile(profile);
      appendLog('name_set', { before, after: setTo });
      streamWithMem(`Noted. I’ll use ${setTo}.`);
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
      streamWithMem(`Verbosity set to ${target}.`);
      return;
    }

    if (/\bbe more verbose\b/.test(lowerText) || /\bbe less verbose\b/.test(lowerText)) {
      const current = profile.prefs.verbosity;
      const delta = /\bbe more verbose\b/.test(lowerText) ? 1 : -1;
      const target = Math.max(0, Math.min(3, current + delta));
      setPref('verbosity', target);
      appendLog('pref_set', { key: 'verbosity', value: target });
      streamWithMem(`Verbosity set to ${target}.`);
      return;
    }

    if (/\btoggle\s+anti-?sycophancy\b/.test(lowerText)) {
      const current = profile.prefs.syc;
      const next = !current;
      setPref('syc', next);
      appendLog('pref_set', { key: 'syc', value: next });
      streamWithMem(`Anti-sycophancy ${next ? 'enabled' : 'disabled'}.`);
      return;
    }

    const sycSwitch = lowerText.match(/anti-?sycophancy\s+(on|off)\b/);
    if (sycSwitch) {
      const next = sycSwitch[1] === 'on';
      setPref('syc', next);
      appendLog('pref_set', { key: 'syc', value: next });
      streamWithMem(`Anti-sycophancy ${next ? 'enabled' : 'disabled'}.`);
      return;
    }

    if (/\bbe more agreeable\b/.test(lowerText) || /\bbe less agreeable\b/.test(lowerText)) {
      const next = /\bbe less agreeable\b/.test(lowerText);
      setPref('syc', next);
      appendLog('pref_set', { key: 'syc', value: next });
      streamWithMem(`Anti-sycophancy ${next ? 'enabled' : 'disabled'}.`);
      return;
    }

    const toneMatch = lowerText.match(/set tone to\s+(direct|neutral|friendly)\b/);
    if (toneMatch) {
      const val = toneMatch[1] as 'direct' | 'neutral' | 'friendly';
      setPref('tone', val);
      appendLog('pref_set', { key: 'tone', value: val });
      streamWithMem(`Tone set to ${val}.`);
      return;
    }

    const formalityMatch = lowerText.match(/set formality to\s+(low|med|high)\b/);
    if (formalityMatch) {
      const val = formalityMatch[1] as 'low' | 'med' | 'high';
      setPref('formality', val);
      appendLog('pref_set', { key: 'formality', value: val });
      streamWithMem(`Formality set to ${val}.`);
      return;
    }

    const guardMatch = lowerText.match(/set guard to\s+(strict|normal)\b/);
    if (guardMatch) {
      const val = guardMatch[1] as 'strict' | 'normal';
      setPref('guard', val);
      appendLog('pref_set', { key: 'guard', value: val });
      streamWithMem(`Guard set to ${val}.`);
      return;
    }

    // 5) Preference queries
    if (/^list my prefs$/.test(lowerText)) {
      const prefs = listPrefs();
      const summary = JSON.stringify(prefs);
      streamReply(summary);
      return;
    }

    // 6) Rules add via "remember"
    const rememberMatch = text.match(/remember that\s+(.+)/i);
    if (rememberMatch) {
      const rawRule = rememberMatch[1];
      const normalized = rawRule.trim().replace(/[.]+$/, '').replace(/\s+/g, ' ');
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
        streamWithMem(`Added rule to ${section}: "${normalized}".`);
      } catch (err: any) {
        streamReply(`Could not add rule: ${err?.message || String(err)}.`);
      }
      return;
    }

    const addRuleMatch = text.match(/add a rule to\s+(\w+):\s+(.+)/i);
    if (addRuleMatch) {
      const section = addRuleMatch[1].trim().toLowerCase();
      const normalized = addRuleMatch[2].trim().replace(/[.]+$/, '').replace(/\s+/g, ' ');
      try {
        addRule(section, normalized);
        appendLog('rule_add', { section, text: normalized });
        streamWithMem(`Added rule to ${section}: "${normalized}".`);
      } catch (err: any) {
        streamReply(`Could not add rule: ${err?.message || String(err)}.`);
      }
      return;
    }

    const removeRuleMatch = text.match(/remove the rule from\s+(\w+):\s+(.+)/i);
    if (removeRuleMatch) {
      const section = removeRuleMatch[1].trim().toLowerCase();
      const normalized = removeRuleMatch[2].trim().replace(/[.]+$/, '').replace(/\s+/g, ' ');
      const before = JSON.stringify(listRules());
      delRule(section, normalized);
      const after = JSON.stringify(listRules());
      if (before !== after) {
        appendLog('rule_del', { section, text: normalized });
        streamWithMem(`Removed rule from ${section}: "${normalized}".`);
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

    // 7) Model path with compact header
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

    } catch (err: any) {
      const processed = applyPostProcess('unknown with current context (model error).');
      send(ws, { type: 'assistant', text: processed });
      appendChat('assistant', processed);
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
