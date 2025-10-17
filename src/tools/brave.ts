export async function web_search(args: { query: string; count?: number }) {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    throw new Error('BRAVE_API_KEY is not set.');
  }
  const count = args.count ?? 5;
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(args.query)}&count=${count}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey
    }
  });
  if (!res.ok) {
    throw new Error(`Brave API error: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as any;
  const items = Array.isArray(data.web?.results) ? data.web.results : [];
  return {
    results: items.map((item: any) => ({
      title: item.title ?? '',
      url: item.url ?? '',
      snippet: item.snippet ?? ''
    }))
  };
}
