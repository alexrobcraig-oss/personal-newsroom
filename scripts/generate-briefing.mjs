/**
 * Craig's Newsroom — Briefing Generator (v2)
 *
 * Architecture:
 *   Stage 0: Duplicate check (aborts before any network call if post exists)
 *   Stage 1: Fetch RSS feeds + scrape Morningstar/Zacks in parallel
 *   Stage 2: Haiku call — extract/clean raw web content into structured summaries
 *   Stage 3: Sonnet call — write the final 800-word editorial briefing
 *   Stage 4: Write markdown file to src/content/blog/
 *
 * Env: ANTHROPIC_API_KEY
 * Run: node scripts/generate-briefing.mjs
 */

import { writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');
const BLOG_DIR  = resolve(ROOT, 'src/content/blog');

// ─── Models ───────────────────────────────────────────────────────────────────
const HAIKU  = 'claude-haiku-4-5-20251001';   // extraction / summarisation
const SONNET = 'claude-sonnet-4-6';            // editorial synthesis

// ─── Date helpers ─────────────────────────────────────────────────────────────
const todaySlug    = () => new Date().toISOString().split('T')[0];
const todayISO     = () => new Date().toISOString();
const formatDate   = () => new Date().toLocaleDateString('en-GB', {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
});

// ─── STAGE 0: Duplicate check (FIRST — before any network I/O) ───────────────
function checkDuplicate() {
  const slug = todaySlug();
  const path = resolve(BLOG_DIR, `${slug}.md`);
  if (existsSync(path)) {
    console.log(`[ABORT] Briefing for ${slug} already exists. Skipping.`);
    process.exit(0);
  }
  return slug;
}

// ─── STAGE 1a: RSS fetch + parse ──────────────────────────────────────────────
const RSS_FEEDS = {
  macro: [
    'https://wolfstreet.com/feed/',
    'https://www.lynalden.com/feed/',
    'https://www.swissinfo.ch/eng/economy/rss',
    'https://www.theguardian.com/uk/business/rss',
  ],
  stocks: [
    'https://crossingwallstreet.com/feed',
  ],
};

async function fetchText(url, timeoutMs = 10_000) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CraigNewsroomBot/2.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    console.warn(`  [WARN] ${url}: ${err.message}`);
    return null;
  }
}

function parseRSS(xml, maxItems = 2) {
  if (!xml) return [];
  const items = [];
  const rx = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = rx.exec(xml)) !== null && items.length < maxItems) {
    const b = m[1];
    const title = (b.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                   b.match(/<title>(.*?)<\/title>/))?.[1]?.trim() ?? '';
    const desc  = (b.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) ||
                   b.match(/<description>([\s\S]*?)<\/description>/))?.[1]
                  ?.replace(/<[^>]+>/g, '')
                  ?.replace(/&[a-z]+;/gi, ' ')
                  ?.replace(/\s+/g, ' ')
                  ?.slice(0, 300)
                  ?.trim() ?? '';
    const pubDate = b.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim() ?? '';
    if (title) items.push({ title, desc, pubDate });
  }
  return items;
}

async function fetchRssFeeds() {
  console.log('[1] Fetching RSS feeds...');
  const results = { macro: [], stocks: [] };
  for (const [category, urls] of Object.entries(RSS_FEEDS)) {
    for (const url of urls) {
      const xml = await fetchText(url);
      const items = parseRSS(xml, 2);
      results[category].push(...items.map(i => ({ ...i, source: new URL(url).hostname })));
      console.log(`    ${new URL(url).hostname}: ${items.length} items`);
    }
  }
  return results;
}

// ─── STAGE 1b: Web scraping for Morningstar + Zacks ──────────────────────────
const WEB_SOURCES = [
  {
    name: 'Morningstar Markets',
    url: 'https://www.morningstar.com/markets',
  },
  {
    name: 'Zacks Stock of the Day',
    url: 'https://www.zacks.com/stock/news/stock-of-the-day',
  },
];

function htmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function first300Words(text) {
  return text.split(/\s+/).slice(0, 300).join(' ');
}

async function scrapeWebSources() {
  console.log('[1b] Scraping Morningstar + Zacks...');
  const scraped = [];
  for (const { name, url } of WEB_SOURCES) {
    const html = await fetchText(url, 12_000);
    const text = first300Words(htmlToText(html));
    console.log(`    ${name}: ${text ? text.split(' ').length + ' words extracted' : 'failed'}`);
    scraped.push({ name, url, text: text || '' });
  }
  return scraped;
}

// ─── STAGE 2: Haiku — extract stock insights from raw web text ───────────────
async function extractWithHaiku(apiKey, scrapedSources) {
  const hasContent = scrapedSources.some(s => s.text.length > 50);
  if (!hasContent) {
    console.log('[2] No web content to extract — skipping Haiku stage.');
    return '(No Morningstar/Zacks content retrieved — use general market knowledge for stock picks)';
  }

  console.log('[2] Haiku extraction pass...');

  const sourceBlocks = scrapedSources.map(s =>
    `--- ${s.name} (${s.url}) ---\n${s.text || '(empty)'}`
  ).join('\n\n');

  const res = await callClaude(apiKey, HAIKU, 400, `You are a financial data extractor.

From the raw web page text below, extract ONLY:
1. Any specific stock tickers or company names mentioned
2. Any specific price targets, analyst ratings, or recommendations
3. The key market insight or story in 1-2 sentences

Be brief and factual. If a source yielded no useful financial data, say "(no useful data)".

${sourceBlocks}`);

  return res;
}

// ─── Shared Claude API caller ─────────────────────────────────────────────────
async function callClaude(apiKey, model, maxTokens, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`[ERROR] Claude API (${model}): ${err}`);
    process.exit(1);
  }

  const data = await res.json();
  return data.content[0].text.trim();
}

// ─── STAGE 3: Sonnet — editorial synthesis ───────────────────────────────────
async function synthesiseWithSonnet(apiKey, rssHeadlines, extractedWebInsights) {
  console.log('[3] Sonnet synthesis pass...');

  const macroText = rssHeadlines.macro
    .map(h => `[${h.source}] ${h.title} — ${h.desc}`)
    .join('\n');
  const stockText = rssHeadlines.stocks
    .map(h => `[${h.source}] ${h.title} — ${h.desc}`)
    .join('\n');

  const prompt = `You are the editor of "Craig's Newsroom" — a grounded, twice-weekly briefing for a British expat living in Zurich, Switzerland. Sceptical but not cynical. Clear but never dumbed down. Occasionally add a dry, Christopher Hitchens-style quip. Never hype.

Today is ${formatDate()}.

MACRO HEADLINES (from RSS):
${macroText || '(none retrieved)'}

STOCK HEADLINES (from RSS):
${stockText || '(none retrieved)'}

STOCK INSIGHTS (from Morningstar / Zacks web scrape):
${extractedWebInsights}

Write a single briefing post in Markdown. Exactly this structure:

## 1. Macro Summary
Two to three paragraphs. Cover the most important macro story. Explain "why it matters" for someone with an Arts degree, not an MBA.

## 2. Stock Watch
List exactly 3–5 stocks. For each:
**[TICKER] — Company Name**
- **Why:** one-sentence bull case
- **Bear Case:** one concrete risk that invalidates the thesis

Prefer tickers surfaced by the Morningstar/Zacks sources. Fall back to general market knowledge if needed.

## 3. Critical Risks
3–5 bullet points: tail risks for the week ahead.

---
*Not financial advice. Sources: ${[...new Set([...rssHeadlines.macro, ...rssHeadlines.stocks].map(h => h.source)), 'morningstar.com', 'zacks.com'].join(', ')}*

RULES:
- Total body: 700–800 words MAX
- Every bull thesis must have a Bear Case (non-negotiable)
- No headers other than the three numbered above
- Section 1 in prose; sections 2 and 3 in the structured format above
- Do not include a post title (that is added separately)`;

  return callClaude(apiKey, SONNET, 800, prompt);
}

// ─── STAGE 4: Write markdown file ────────────────────────────────────────────
function writePost(slug, body) {
  const date = new Date();
  const monthDay = date.toLocaleDateString('en-GB', { month: 'long', day: 'numeric' });
  const title = `Market Briefing — ${monthDay} ${date.getFullYear()}`;
  const description = `Grounded market overview for ${monthDay}: macro trends, stock picks with bear cases, and the critical risks for the week ahead.`;

  const content = `---
title: "${title}"
description: "${description}"
pubDate: "${todayISO()}"
tags: ["briefing", "macro", "stocks", "expat", "zurich"]
draft: false
---

${body}`;

  const filePath = resolve(BLOG_DIR, `${slug}.md`);
  writeFileSync(filePath, content, 'utf8');
  console.log(`[4] Written: src/content/blog/${slug}.md`);
  return filePath;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // Stage 0: duplicate check — abort immediately if post exists
  const slug = checkDuplicate();
  console.log(`[START] Craig's Newsroom briefing — ${slug}`);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('[ERROR] ANTHROPIC_API_KEY not set.'); process.exit(1); }

  // Stage 1: fetch all sources in parallel
  const [rssHeadlines, scrapedSources] = await Promise.all([
    fetchRssFeeds(),
    scrapeWebSources(),
  ]);

  // Stage 2: Haiku extracts stock insights from raw web text (cheap)
  const extractedInsights = await extractWithHaiku(apiKey, scrapedSources);

  // Stage 3: Sonnet writes the final briefing (max 800 tokens)
  const body = await synthesiseWithSonnet(apiKey, rssHeadlines, extractedInsights);

  // Stage 4: write file
  writePost(slug, body);

  console.log('[DONE] Briefing generated successfully.');
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
