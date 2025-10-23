export type BraveResult = { title: string; url: string; snippet?: string };

const BASE = 'https://api.search.brave.com/res/v1/web/search';

export async function webSearch(query: string, count = 5): Promise<BraveResult[]> {
  if (!process.env.BRAVE_API_KEY) throw new Error('Missing BRAVE_API_KEY');
  const u = new URL(BASE);
  u.searchParams.set('q', query);
  u.searchParams.set('count', String(count));
  const res = await fetch(u.toString(), {
    headers: { 'Accept': 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY! }
  });
  if (!res.ok) throw new Error(`Brave ${res.status}`);
  const data = (await res.json()) as any;
  const items = (data.web?.results || []) as any[];
  return items.slice(0, count).map((it) => ({
    title: String(it.title || '').trim(),
    url: String(it.url || '').trim(),
    snippet: typeof it.snippet === 'string' ? it.snippet : undefined,
  }));
}
export function formatSources(q: string, results: BraveResult[]): string {
  const head = `Sources for: ${q}\n`;
  if (!results.length) return head + '- (no results)';
  return head + results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join('\n');
}

export async function web_search(args: { query: string; count?: number }) {
  const results = await webSearch(args.query, args.count ?? 5);
  return {
    results: results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet ?? '',
    })),
  };
}
