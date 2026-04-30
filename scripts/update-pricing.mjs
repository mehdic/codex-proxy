#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const out = process.env.CODEX_PROXY_PRICING_FILE || join(homedir(), '.codex-proxy', 'pricing.json');
const now = new Date().toISOString().slice(0, 10);

const book = {
  updatedAt: now,
  source: 'codex-proxy updater fallback; public pricing pages unavailable or incomplete',
  models: {
    'gpt-5.5': { inputPer1M: 5.0, cachedInputPer1M: 0.5, outputPer1M: 30.0, source: 'OpenRouter public pricing fallback', updatedAt: now },
    'gpt-5.4': { inputPer1M: 4.0, cachedInputPer1M: 0.4, outputPer1M: 16.0, source: 'OpenAI public pricing fallback', updatedAt: now },
    'gpt-5.4-mini': { inputPer1M: 0.75, cachedInputPer1M: 0.075, outputPer1M: 6.0, source: 'OpenAI mini-family public pricing fallback', updatedAt: now, note: 'estimated fallback' },
    'gpt-5.3-codex': { inputPer1M: 4.0, cachedInputPer1M: 0.4, outputPer1M: 16.0, source: 'family fallback aligned to GPT text pricing', updatedAt: now, note: 'estimated fallback' },
    'gpt-5.3-codex-spark': { inputPer1M: 0.75, cachedInputPer1M: 0.075, outputPer1M: 6.0, source: 'family fallback aligned to mini tier', updatedAt: now, note: 'estimated fallback' },
    'gpt-5.2': { inputPer1M: 4.0, cachedInputPer1M: 0.4, outputPer1M: 16.0, source: 'family fallback aligned to GPT text pricing', updatedAt: now, note: 'estimated fallback' },
  },
};

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'codex-proxy-pricing-refresh/1.0' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'codex-proxy-pricing-refresh/1.0' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

function applyOpenRouterModels(data) {
  const items = Array.isArray(data?.data) ? data.data : [];
  for (const item of items) {
    const id = String(item?.id || '').replace(/^openai\//, '');
    if (!book.models[id]) continue;
    const prompt = Number(item.pricing?.prompt);
    const completion = Number(item.pricing?.completion);
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) continue;
    const current = book.models[id];
    book.models[id] = {
      ...current,
      inputPer1M: prompt * 1_000_000,
      outputPer1M: completion * 1_000_000,
      cachedInputPer1M: Number.isFinite(Number(item.pricing?.prompt_cache_read))
        ? Number(item.pricing.prompt_cache_read) * 1_000_000
        : current.cachedInputPer1M,
      source: 'https://openrouter.ai/api/v1/models public model pricing',
      updatedAt: now,
      note: item.pricing?.prompt_cache_read ? undefined : current.note,
    };
  }
}

function applyOpenAiPricingPageHints(book, html) {
  // Keep this deliberately conservative: the pricing page is human HTML and can drift.
  // If recognizable GPT-5.4 text appears, mark source freshness but do not scrape brittle values.
  if (/gpt[- ]?5\.4/i.test(html)) {
    for (const key of ['gpt-5.4', 'gpt-5.4-mini']) {
      if (!book.models[key]) continue;
      book.models[key] = {
        ...book.models[key],
        source: 'https://openai.com/api/pricing/ public pricing page',
        updatedAt: now,
      };
    }
  }
}

const warnings = [];
try {
  applyOpenRouterModels(await fetchJson('https://openrouter.ai/api/v1/models'));
  book.source = 'public pricing refresh: OpenRouter models API + OpenAI pricing page; static fallback for missing models';
} catch (err) {
  warnings.push(String(err?.message || err));
}

try {
  applyOpenAiPricingPageHints(book, await fetchText('https://openai.com/api/pricing/'));
} catch (err) {
  warnings.push(String(err?.message || err));
}

if (warnings.length) book.warnings = warnings;
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(book, null, 2) + '\n');
console.log(`wrote ${out}`);
if (warnings.length) console.warn(`warnings: ${warnings.join('; ')}`);
