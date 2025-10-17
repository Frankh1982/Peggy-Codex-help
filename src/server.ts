import 'dotenv/config';
import { createServer } from 'http';
import path from 'path';
import { promises as fs } from 'fs';
import express from 'express';
import { WebSocketServer } from 'ws';
import { buildMessages } from './agent/context.js';
import { modelStep } from './lib/openai.js';
import { parseC3, validateC3 } from './dsl/schema.js';
import { execute } from './dsl/executor.js';
import { logEvent } from './lib/logging.js';
import { mkdirp, rollByDate, readUtf8 } from './lib/fsutil.js';
import { registerHealthRoute } from './routes/health.js';
import { buildCapsule } from '../_system/make_capsule.js';

type HistoryTurn = { role: 'user' | 'assistant' | 'tool'; content: string };

type SessionState = {
  history: HistoryTurn[];
};

const PORT = Number(process.env.PORT || 5173);

const app = express();
app.use(express.static('public'));
registerHealthRoute(app);

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/chat' });

async function appendChat(role: 'user' | 'assistant' | 'tool', content: string) {
  const dir = 'memory/chat';
  await mkdirp(dir);
  const file = path.join(dir, rollByDate('chat', 'ndjson'));
  await fs.appendFile(
    file,
    JSON.stringify({ t: new Date().toISOString(), role, content }) + '\n',
    'utf8'
  );
}

async function ensureCapsule(): Promise<{ text: string; hash: string }> {
  try {
    const text = await readUtf8('_system/capsule.md');
    const hash = extractHash(text);
    return { text, hash };
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
    const hash = await buildCapsule();
    const text = await readUtf8('_system/capsule.md');
    return { text, hash };
  }
}

function extractHash(capsule: string): string {
  const match = capsule.match(/Capsule Hash: ([0-9a-f]+)/i);
  return match ? match[1] : '';
}

wss.on('connection', async (socket) => {
  const session: SessionState = { history: [] };
  try {
    const { hash } = await ensureCapsule();
    socket.send(JSON.stringify({ type: 'init', capsuleHash: hash.slice(0, 16) }));
  } catch (err) {
    socket.send(
      JSON.stringify({ type: 'error', message: 'failed to load capsule: ' + (err as Error).message })
    );
  }

  socket.on('message', async (raw) => {
    let payload: any;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      socket.send(JSON.stringify({ type: 'error', message: 'invalid payload' }));
      return;
    }
    const userText = String(payload.text || '').trim();
    if (!userText) {
      socket.send(JSON.stringify({ type: 'error', message: 'empty text' }));
      return;
    }

    await logEvent({ type: 'chat.user', payload: { text: userText } });
    await appendChat('user', userText);
    session.history.push({ role: 'user', content: userText });

    let capsuleText = '';
    let capsuleHash = '';
    try {
      const capsule = await ensureCapsule();
      capsuleText = capsule.text;
      capsuleHash = capsule.hash;
    } catch (err) {
      socket.send(JSON.stringify({ type: 'error', message: 'capsule unavailable' }));
      return;
    }

    let messages;
    try {
      messages = await buildMessages(userText, capsuleText, session.history);
    } catch (err) {
      socket.send(JSON.stringify({ type: 'error', message: 'context failure' }));
      return;
    }

    const toolCitations = new Set<string>();
    const step = await modelStep(messages, [
      {
        name: 'web_search',
        description: 'Perform a Brave web search (guardrailed by executor).',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            count: { type: 'integer', minimum: 1, maximum: 5 }
          },
          required: ['query']
        },
        execute: async (args: any) => {
          const { query, count } = args || {};
          const result = await execute(
            [
              {
                type: 'WEB.SEARCH',
                query,
                count
              }
            ],
            {}
          );
          for (const cite of result.citations) {
            toolCitations.add(cite);
          }
          return result.outputs[0] ?? result;
        }
      }
    ]);

    let finalText = '';
    try {
      for await (const chunk of step.stream) {
        if (!chunk) continue;
        finalText += chunk;
        socket.send(JSON.stringify({ type: 'chunk', text: chunk }));
      }
    } catch (err) {
      socket.send(JSON.stringify({ type: 'error', message: 'stream interrupted' }));
      return;
    }

    const actions = parseC3(finalText);
    let citations = new Set(toolCitations);
    let aborted = false;
    if (actions.length) {
      const validation = validateC3(actions);
      if (!validation.ok) {
        socket.send(
          JSON.stringify({ type: 'error', message: `C3 validation failed: ${validation.errors?.join(', ')}` })
        );
        aborted = true;
      } else {
        try {
          const result = await execute(actions, {});
          for (const cite of result.citations) {
            citations.add(cite);
          }
          const rebuild = result.outputs.find((out) => out.type === 'CAPSULE.REBUILD');
          if (rebuild && 'hash' in rebuild) {
            capsuleHash = rebuild.hash;
          }
        } catch (err) {
          socket.send(JSON.stringify({ type: 'error', message: (err as Error).message }));
          aborted = true;
        }
      }
    }

    await logEvent({ type: 'chat.assistant', payload: { text: finalText } });
    await appendChat('assistant', finalText);
    session.history.push({ role: 'assistant', content: finalText });

    socket.send(
      JSON.stringify({
        type: 'done',
        capsuleHash: capsuleHash.slice(0, 16),
        sources: aborted ? [] : Array.from(citations)
      })
    );
  });
});

server.listen(PORT, async () => {
  await ensureCapsule();
  console.log(`Server listening on http://localhost:${PORT}`);
});
