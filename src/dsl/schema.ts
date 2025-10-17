import { z } from 'zod';

export type Action =
  | { type: 'GOAL.SET'; goal: string }
  | { type: 'PLAN.ADD'; id: string; text: string }
  | { type: 'PLAN.UPDATE'; id: string; text: string }
  | { type: 'LEDGER.APPEND'; message: string }
  | { type: 'FILE.WRITE'; path: string; mode: 'append' | 'overwrite'; content: string }
  | { type: 'MEM.READ'; path: string }
  | { type: 'WEB.SEARCH'; query: string; count?: number }
  | { type: 'CITE'; urls: string[] }
  | { type: 'CAPSULE.REBUILD' }
  | { type: 'ASSERT'; message: string };

const pathSchema = z
  .string()
  .min(1)
  .regex(/^memory\/(agent|user)\//, 'Path must stay within memory/agent or memory/user');

const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('GOAL.SET'), goal: z.string().min(1) }),
  z.object({ type: z.literal('PLAN.ADD'), id: z.string().min(1), text: z.string() }),
  z.object({ type: z.literal('PLAN.UPDATE'), id: z.string().min(1), text: z.string() }),
  z.object({ type: z.literal('LEDGER.APPEND'), message: z.string() }),
  z.object({
    type: z.literal('FILE.WRITE'),
    path: pathSchema,
    mode: z.union([z.literal('append'), z.literal('overwrite')]),
    content: z.string()
  }),
  z.object({ type: z.literal('MEM.READ'), path: pathSchema }),
  z.object({
    type: z.literal('WEB.SEARCH'),
    query: z.string().min(1),
    count: z.number().int().min(1).max(10).optional()
  }),
  z.object({ type: z.literal('CITE'), urls: z.array(z.string().url()).min(1) }),
  z.object({ type: z.literal('CAPSULE.REBUILD') }),
  z.object({ type: z.literal('ASSERT'), message: z.string().min(1) })
]);

function stripQuotes(token: string): string {
  if (token.startsWith('"') && token.endsWith('"')) {
    return token
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n');
  }
  return token;
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const regex = /"(?:\\.|[^"\\])*"|[()]|:[^\s()]+|[^\s()]+/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    tokens.push(match[0]);
  }
  return tokens;
}

function parseTokens(tokens: string[]): any[] {
  const stack: any[][] = [];
  const root: any[] = [];
  let current: any[] = root;

  for (const token of tokens) {
    if (token === '(') {
      const list: any[] = [];
      current.push(list);
      stack.push(current);
      current = list;
    } else if (token === ')') {
      if (!stack.length) {
        throw new Error('Unbalanced parentheses in C3 block');
      }
      current = stack.pop()!;
    } else {
      current.push(token);
    }
  }

  if (stack.length !== 0) {
    throw new Error('Unbalanced parentheses in C3 block');
  }
  if (!root.length) {
    throw new Error('Empty C3 expression');
  }
  return root;
}

function parseAction(list: any[]): Action {
  const [opToken, ...args] = list;
  if (typeof opToken !== 'string') {
    throw new Error('Invalid operation token');
  }
  switch (opToken) {
    case 'GOAL.SET':
      return { type: 'GOAL.SET', goal: stripQuotes(args[0] || '') };
    case 'PLAN.ADD':
      return {
        type: 'PLAN.ADD',
        id: String(args[0] ?? '').trim(),
        text: stripQuotes(args[1] || '')
      };
    case 'PLAN.UPDATE':
      return {
        type: 'PLAN.UPDATE',
        id: String(args[0] ?? '').trim(),
        text: stripQuotes(args[1] || '')
      };
    case 'LEDGER.APPEND':
      return { type: 'LEDGER.APPEND', message: stripQuotes(args[0] || '') };
    case 'FILE.WRITE': {
      const path = stripQuotes(args[0] || '');
      const mode = String(args[1] || '').toLowerCase();
      const content = stripQuotes(args[2] || '');
      if (mode !== 'append' && mode !== 'overwrite') {
        throw new Error('FILE.WRITE mode must be append or overwrite');
      }
      return { type: 'FILE.WRITE', path, mode: mode as 'append' | 'overwrite', content };
    }
    case 'MEM.READ':
      return { type: 'MEM.READ', path: stripQuotes(args[0] || '') };
    case 'WEB.SEARCH': {
      const query = stripQuotes(args[0] || '');
      let count: number | undefined;
      if (args[1]) {
        if (args[1] !== ':count') {
          throw new Error('WEB.SEARCH expects :count label');
        }
        const parsed = Number(args[2]);
        if (Number.isNaN(parsed)) {
          throw new Error('WEB.SEARCH count must be numeric');
        }
        count = parsed;
      }
      return { type: 'WEB.SEARCH', query, count };
    }
    case 'CITE':
      return {
        type: 'CITE',
        urls: args.map((arg) => stripQuotes(arg))
      };
    case 'CAPSULE.REBUILD':
      return { type: 'CAPSULE.REBUILD' };
    case 'ASSERT':
      return { type: 'ASSERT', message: stripQuotes(args[0] || '') };
    default:
      throw new Error(`Unknown operation: ${opToken}`);
  }
}

export function parseC3(text: string): Action[] {
  const blocks = Array.from(text.matchAll(/```c3\s*([\s\S]*?)```/g));
  if (!blocks.length) return [];

  const actions: Action[] = [];
  for (const [, body] of blocks) {
    const tokens = tokenize(body.trim());
    if (!tokens.length) continue;
    const ast = parseTokens(tokens);
    for (const node of ast) {
      if (!Array.isArray(node)) continue;
      actions.push(parseAction(node));
    }
  }
  return actions;
}

export function validateC3(actions: Action[]): { ok: boolean; errors?: string[] } {
  const errors: string[] = [];
  for (const action of actions) {
    const result = ActionSchema.safeParse(action);
    if (!result.success) {
      errors.push(result.error.issues.map((issue) => issue.message).join('; '));
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}
