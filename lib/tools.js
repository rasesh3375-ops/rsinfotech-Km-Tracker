/**
 * Tools the research agents can call.
 *
 * Every source here is free and keyless. No search API subscription, no
 * scraping service. That constrains what's reachable — there is no general web
 * index — but Hacker News and Reddit between them cover the technical space
 * these agents actually research, and both return clean JSON.
 */

const UA = 'agent-org/1.0 (+https://github.com)';
const TIMEOUT = 12000;

async function getJSON(url, signal) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  signal?.addEventListener('abort', () => ctl.abort(), { once: true });
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export const hnSearch = {
  schema: {
    type: 'function',
    function: {
      name: 'hn_search',
      description:
        'Search Hacker News for stories and discussion. Best source for framework ' +
        'releases, technical writeups, and postmortems. Free, no key.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search terms, e.g. "AI agents" or "LangGraph"' },
          days: { type: 'number', description: 'Only results from the last N days. Default 7.' }
        },
        required: ['query']
      }
    }
  },
  async run({ query, days = 7 }, { signal } = {}) {
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}` +
                `&tags=story&numericFilters=created_at_i>${cutoff}&hitsPerPage=20`;
    const data = await getJSON(url, signal);
    const hits = (data.hits || [])
      .filter(h => h.title)
      .map(h => ({
        title: h.title,
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        points: h.points,
        comments: h.num_comments,
        date: h.created_at?.slice(0, 10),
        discussion: `https://news.ycombinator.com/item?id=${h.objectID}`
      }))
      .sort((a, b) => (b.points || 0) - (a.points || 0));
    return hits.length ? hits : `No Hacker News results for "${query}" in the last ${days} days.`;
  }
};

export const redditSearch = {
  schema: {
    type: 'function',
    function: {
      name: 'reddit_search',
      description:
        'Search Reddit. Good for practitioner reports and complaints about tools ' +
        'that do not work as advertised. Free, no key.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search terms' },
          window: {
            type: 'string',
            enum: ['day', 'week', 'month'],
            description: 'Time window. Default week.'
          }
        },
        required: ['query']
      }
    }
  },
  async run({ query, window = 'week' }, { signal } = {}) {
    const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}` +
                `&sort=top&t=${window}&limit=20`;
    const data = await getJSON(url, signal);
    const posts = (data?.data?.children || []).map(c => ({
      title: c.data.title,
      subreddit: c.data.subreddit_name_prefixed,
      score: c.data.score,
      comments: c.data.num_comments,
      url: c.data.url_overridden_by_dest || `https://reddit.com${c.data.permalink}`,
      discussion: `https://reddit.com${c.data.permalink}`
    }));
    return posts.length ? posts : `No Reddit results for "${query}" in the last ${window}.`;
  }
};

export const fetchPage = {
  schema: {
    type: 'function',
    function: {
      name: 'fetch_page',
      description:
        'Fetch a web page and return its readable text. Use this to read the ' +
        'primary source after a search turns up a promising link, rather than ' +
        'trusting the search snippet.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Full URL including https://' } },
        required: ['url']
      }
    }
  },
  async run({ url }, { signal } = {}) {
    if (!/^https?:\/\//i.test(url)) return 'Refused: url must start with http:// or https://';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT);
    signal?.addEventListener('abort', () => ctl.abort(), { once: true });
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal });
      if (!res.ok) return `HTTP ${res.status} fetching ${url}`;
      const html = await res.text();
      // Crude but dependency-free. Good enough to judge whether a page says what
      // its title claims, which is all the scout needs it for.
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
      return text.slice(0, 8000) || '(page had no extractable text)';
    } catch (err) {
      return `Could not fetch ${url}: ${err.message}`;
    } finally {
      clearTimeout(timer);
    }
  }
};

export const researchTools = [hnSearch, redditSearch, fetchPage];
