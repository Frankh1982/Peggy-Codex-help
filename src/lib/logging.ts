import { promises as fs } from 'fs';
import path from 'path';
import { mkdirp, rollByDate } from './fsutil.js';

type LogEvent = {
  type: string;
  payload?: Record<string, unknown> | unknown;
};

export async function logEvent(event: LogEvent): Promise<void> {
  const dir = 'logs';
  await mkdirp(dir);
  const filePath = path.join(dir, rollByDate('run', 'ndjson'));
  const line = JSON.stringify({ t: new Date().toISOString(), ...event }) + '\n';
  await fs.appendFile(filePath, line, 'utf8');
}
