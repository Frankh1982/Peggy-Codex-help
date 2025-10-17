export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

export function mdEscape(text: string): string {
  return text.replace(/[\\`*_{}\[\]()#+\-.!]/g, (ch) => `\\${ch}`);
}

export function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function indent(text: string, spaces = 2): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.length ? pad + line : line))
    .join('\n');
}
