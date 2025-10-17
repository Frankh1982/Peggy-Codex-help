import 'dotenv/config';
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';

const PORT = Number(process.env.PORT || 5173);

const app = express();
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/chat' });

// simple heartbeats so the socket stays alive
wss.on('connection', (ws) => {
  const runHash = crypto.randomBytes(4).toString('hex');

  const send = (obj: unknown) => {
    try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
  };

  send({ type: 'system', text: 'ready.' });
  send({ type: 'hash', value: runHash });

  ws.on('message', (data) => {
    // Normalize input: accept JSON {text} or raw text
    let text: string;
    try {
      const m = JSON.parse(data.toString());
      text = typeof m?.text === 'string' ? m.text : data.toString();
    } catch {
      text = data.toString();
    }
    send({ type: 'assistant', text: `you said → ${text}` });
  });

  ws.on('error', (err) => {
    send({ type: 'system', text: `ws error: ${String(err)}` });
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
