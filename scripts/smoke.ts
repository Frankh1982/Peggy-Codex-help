import 'dotenv/config';
import WebSocket from 'ws';
import { readFile } from 'fs/promises';

const PORT = Number(process.env.PORT || 5173);
const url = `ws://localhost:${PORT}/chat`;

async function run() {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url);
    let buffer = '';
    let completed = 0;

    ws.on('open', () => {
      ws.send(JSON.stringify({ text: 'who are you?' }));
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'chunk') {
        buffer += msg.text;
      } else if (msg.type === 'done') {
        if (!buffer.trim()) {
          reject(new Error('Empty response stream'));
          ws.close();
          return;
        }
        buffer = '';
        completed += 1;
        if (completed === 1) {
          ws.send(
            JSON.stringify({ text: 'Add plan step P1: build WebSocket server; then rebuild capsule.' })
          );
        } else {
          ws.close();
          resolve();
        }
      } else if (msg.type === 'error') {
        reject(new Error(msg.message));
        ws.close();
      }
    });

    ws.on('error', (err) => reject(err));
    ws.on('close', () => {
      if (completed < 2) {
        reject(new Error('Socket closed prematurely'));
      }
    });
  });

  await readFile('_system/capsule.md', 'utf8');
  console.log('SMOKE OK');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
