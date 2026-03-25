/**
 * Craig's Newsroom — Briefing Generator
 *
 * Fetches the latest entries from RSS feeds, passes headlines + summaries
 * to Claude for editorial synthesis, then writes a dated markdown post
 * into src/content/blog/.
 *
 * Run:  node scripts/generate-briefing.mjs
 *
 * Environment variables expected (set in repo secrets or local .env):
 *   ANTHROPIC_API_KEY  — for Claude API calls
 *   GITHUB_TOKEN       — for committing & pushing (used by CI)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const BLOG_DIR = resolve(ROOT, 'src/content/blog');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todaySlug() {
  return new Date().toISOString().split('T')[0]; // e.g. 2026-03-25
}

function todayISO() {
  return new Date().toISOString();
}

function formatPostDate() {
  return new Date().toLocaleDateString('en-GB', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

// Check for duplicate before doing any work
function checkDuplicate(slug) {
  const path = resolve(BLOG_DIR, `${slug}.md`);
  if (existsSync(path)) {
    console.log(`[ABORT] Briefing for ${slug} already exists. Skipping.`);
    process.exit(0);
  }
}

// ─── RSS Fetching ─────────────────────────────────────────────────────────────

const FEEDS = {
  macro: [
    'https://wolfstreet.com/feed/',
    'https://www.lynalden.com/feed/',
    'https://www.swissinfo.ch/eng/economy/rss',
    'https://www.theguardian.com/uk/business/rss',
  ],
  stocks: [
    'https://crossingwallstreet.com/feed',
    // Morningstar & Zacks don't serve clean RSS — we use web scraping fallback
  ],
};

async function fetchFeed(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'CraigNewsroomBot/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    console.warn(`[WARN] Could not fetch ${url}: ${err.message}`);
    return null;
  }
}

function parseRSSItems(xml, maxItems = 3) {
  if (!xml) return [];
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null && items.length < maxItems) {
    const block = match[1];
    const title = (block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                   block.match(/<title>(.*?)<\/title>/))?.[1]?.trim() ?? '';
    const link  = (block.match(/<link>(.*?)<\/link>/) ||
                   block.match(/<link\s+href="(.*?)"/))?.[1]?.trim() ?? '';
    const desc  = (block.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) ||
                   block.match(/<description>(.*?)<\/description>/))?.[1]
                  ?.replace(/<[^>]+>/g, '')
                  ?.replace(/&amp;/g, '&')
                  ?.replace(/&lt;/g, '<')
                  ?.replace(/&gt;/g, '>')
                  ?.replace(/&quot;/g, '"')
                  ?.replace(/&#39;/g, "'")
                  ?.slice(0, 400)
                  ?.trim() ?? '';
    const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim() ?? '';
    if (title) items.push({ title, link, desc, pubDate });
  }
  return items;
}

async function gatherHeadlines() {
  console.log('[INFO] Fetching RSS feeds...');
  const results = { macro: [], stocks: [] };

  for (const url of FEEDS.macro) {
    const xml = await fetchFeed(url);
    const items = parseRSSItems(xml, 2);
    results.macro.push(...items.map(i => ({ ...i, source: new URL(url).hostname })));
    console.log(`  ✓ ${new URL(url).hostname} — ${items.length} items`);
  }

  for (const url of FEEDS.stocks) {
    const xml = await fetchFeed(url);
    const items = parseRSSItems(xml, 3);
    results.stocks.push(...items.map(i => ({ ...i, source: new URL(url).hostname })));
    console.log(`  ✓ ${new URL(url).hostname} — ${items.length} items`);
  }

  return results;
}

// ─── Claude Editorial Synthesis ───────────────────────────────────────────────

async function synthesiseBriefing(headlines) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[ERROR] ANTHROPIC_API_KEY not set.');
    process.exit(1);
  }

  const macroText = headlines.macro
    .map(h => `[${h.source}] ${h.title}\n  ${h.desc}`)
    .join('\n\n');

  const stockText = headlines.stocks
    .map(h => `[${h.source}] ${h.title}\n  ${h.desc}`)
    .join('\n\n');

  const prompt = `You are the editor of "Craig's Newsroom" — a grounded, twice-weekly briefing for a British expat living in Zurich, Switzerland. Your tone is sceptical but not cynical, clear but not dumbed down. Occasionally add a dry, Christopher Hitchens-style quip to give the writing some flavour. Never use bullish hype.

Today is ${formatPostDate()}.

MACRO HEADLINES:
${macroText || "(no macro data retrieved — note this and write from general knowledge)"}

STOCK HEADLINES:
${stockText || "(no stock data retrieved — note this and select 3 tickers from general market knowledge)"}

Write a single briefing post in Markdown. Exactly this structure, no deviations:

## 1. Macro Summary
Two to three paragraphs. Cover the biggest macro story today. Explain the "why it matters" for a non-expert.

## 2. Stock Watch
List exactly 3–5 stocks. For each, use this sub-format:
**[TICKER] — Company Name**
- **Why:** one sentence on the bull case
- **Bear Case:** one concrete risk that could invalidate the thesis

## 3. The Expat Angle
One paragraph. How does today's macro picture affect GBP/CHF, Swiss inflation, the SNB, or the Zurich rental/cost-of-living situation? Be specific.

## 4. Critical Risks
A short (3–5 bullet) list of the most important tail risks for the week ahead.

---
*Not financial advice. Sources: ${[...new Set([...headlines.macro, ...headlines.stocks].map(h => h.source))].join(', ') || 'general market knowledge'}*

RULES:
- Total length: 700–800 words MAX
- No headers other than the four numbered above
- Write in prose (not bullets) for sections 1 and 3
- Section 2 and 4 may use the structured format above
- Do not add a title — that is provided separately`;

  console.log('[INFO] Calling Claude API...');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[ERROR] Claude API:', err);
    process.exit(1);
  }

  const data = await res.json();
  return data.content[0].text.trim();
}

// ─── Write Post ───────────────────────────────────────────────────────────────

function writePost(slug, body) {
  const date = new Date();
  const monthDay = date.toLocaleDateString('en-GB', { month: 'long', day: 'numeric' });
  const title = `Market Briefing — ${monthDay} ${date.getFullYear()}`;
  const description = `Grounded market overview for ${monthDay}: macro trends, 3–5 stock picks with bear cases, and what it means for GBP/CHF and life in Zurich.`;

  const frontmatter = `---
title: "${title}"
description: "${description}"
pubDate: "${todayISO()}"
tags: ["briefing", "macro", "stocks", "expat", "zurich"]
draft: false
---

`;

  const content = frontmatter + body;
  const filePath = resolve(BLOG_DIR, `${slug}.md`);
  writeFileSync(filePath, content, 'utf8');
  console.log(`[OK] Written: ${filePath}`);
  return filePath;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const slug = todaySlug();
  console.log(`[START] Craig's Newsroom briefing — ${slug}`);

  checkDuplicate(slug);

  const headlines = await gatherHeadlines();
  const body = await synthesiseBriefing(headlines);
  writePost(slug, body);

  console.log('[DONE] Briefing generated successfully.');
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
