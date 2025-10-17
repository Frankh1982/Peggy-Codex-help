import 'dotenv/config';
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

const PORT = Number(process.env.PORT || 5173);
const MODEL = process.env.MODEL || 'gpt-4o-mini';

const app = express();
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/chat' });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function readPersona(): string {
  try {
    const p = path.join(process.cwd(), 'src', 'agent', 'persona.md');
    return fs.readFileSync(p, 'utf8');
  } catch {
    return 'You are a candid, concise assistant. Prefer "unknown with current context" over guessing.';
  }
}

function send(ws: any, obj: unknown) {
  try { ws.send(JSON.stringify(obj)); } catch {/* ignore */}
}

wss.on('connection', (ws) => {
  const runHash = crypto.randomBytes(4).toString('hex');
  send(ws, { type: 'system', text: 'ready.' });
  send(ws, { type: 'hash', value: runHash });

  ws.on('message', async (data: Buffer) => {
    // Normalize input: accept JSON {text} or raw text
    let userText = data.toString();
    try {
      const m = JSON.parse(userText);
      if (typeof m?.text === 'string') userText = m.text;
    } catch {/* raw string */}

    // Guard: empty message
    if (!userText || !userText.trim()) return;

    // Begin streaming
    send(ws, { type: 'assistant_start' });

    try {
      const stream = await openai.chat.completions.create({
        model: MODEL,
        stream: true,
        messages: [
          { role: 'system', content: readPersona() },
          { role: 'user', content: userText }
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

    } catch (err: any) {
      const msg = err?.message || String(err);
      send(ws, { type: 'system', text: `openai error: ${msg}` });
    }
  });

  ws.on('error', (err: any) => {
    send(ws, { type: 'system', text: `ws error: ${String(err)}` });
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
