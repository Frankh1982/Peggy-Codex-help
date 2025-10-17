import 'dotenv/config';
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { initMemory, readProfile, writeProfile, readState, bumpState, appendChat, appendLog, headerLine, parseNameIntent, asksForName } from './lib/memory';

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

    // Always log user msg
    appendChat('user', text);

    // 1) Name set intent (deterministic, no model call)
    const setTo = parseNameIntent(text);
    if (setTo) {
      const before = profile.name;
      profile.name = setTo;
      writeProfile(profile);
      const st = bumpState();
      appendLog('name_set', { before, after: setTo });
      send(ws, { type: 'assistant_start' });
      send(ws, { type: 'assistant_chunk', text: `Noted. I’ll use ${setTo}.` });
      send(ws, { type: 'assistant', text: `Noted. I’ll use ${setTo}.` });
      appendChat('assistant', `Noted. I’ll use ${setTo}.`);
      send(ws, { type: 'mem', rev: st.rev });
      return;
    }

    // 2) Name query (deterministic, no model call)
    if (asksForName(text)) {
      const reply = profile.name ? `Your name is ${profile.name}.` : `unknown with current context. Say: "set my name to Frank".`;
      const st = bumpState();
      send(ws, { type: 'assistant_start' });
      send(ws, { type: 'assistant_chunk', text: reply });
      send(ws, { type: 'assistant', text: reply });
      appendChat('assistant', reply);
      send(ws, { type: 'mem', rev: st.rev });
      return;
    }

    // 3) Model path with compact header
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

      send(ws, { type: 'assistant', text: full });
      appendChat('assistant', full);
      const st = bumpState();
      send(ws, { type: 'mem', rev: st.rev });

    } catch (err: any) {
      send(ws, { type: 'assistant', text: 'unknown with current context (model error).'});
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
