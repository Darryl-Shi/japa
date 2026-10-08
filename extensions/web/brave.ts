/** Thrown by an engine whose API key is not in the secrets store. */
export class MissingKey extends Error {}

/** Brave Search, with its API key in the secret `web.brave.apiKey`. */
export const brave = {
  search: async (query: string, count: number, secret: (name: string) => Promise<string | undefined>) => {
    const key = await secret("web.brave.apiKey");
    if (!key) throw new MissingKey();
    const params = new URLSearchParams({ q: query, count: String(count) });
    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: { Accept: "application/json", "X-Subscription-Token": key },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Brave Search replied HTTP ${response.status}`);
    const body = (await response.json()) as { web?: { results: { title: string; url: string; description: string }[] } };
    return (body.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.description }));
  },
};
