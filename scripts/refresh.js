#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const HTML_PATH = path.join(ROOT, "index.html");
const MODELS_URL = "https://openrouter.ai/api/v1/models";
const DATASET_START = "2025-01-01";
const DISPLAY_TOP_N = 20;
const MAX_DATASET_DAYS = 366;
const FALLBACK_PROMPT_RATIO = 0.962;
const FALLBACK_COMPLETION_RATIO = 0.038;

const DEFAULT_DATASET_URLS = [
  "https://openrouter.ai/api/v1/datasets/rankings-daily",
  "https://openrouter.ai/api/v1/datasets/rankings/daily",
  "https://openrouter.ai/api/v1/datasets/rankings_daily",
  "https://openrouter.ai/api/v1/datasets/rankings",
  "https://openrouter.ai/api/v1/datasets/ranking/daily",
  "https://openrouter.ai/api/v1/datasets/model-rankings/daily",
  "https://openrouter.ai/api/v1/datasets/models/rankings/daily",
  "https://openrouter.ai/api/v1/rankings/daily"
];

const args = parseArgs(process.argv.slice(2));

if (args.check) {
  await checkHtml();
} else {
  await refresh();
}

async function refresh() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENROUTER_API_KEY. Run: OPENROUTER_API_KEY=... npm run refresh");
  }

  const endDate = args.endDate || yesterdayUtc();
  const startDate = args.startDate || DATASET_START;

  const [rankings, models] = await Promise.all([
    fetchRankingsDaily({ apiKey, startDate, endDate }),
    fetchJson(MODELS_URL, { apiKey })
  ]);

  const rows = normalizeRows(rankings);
  if (!rows.length) {
    throw new Error("Datasets API returned no ranking rows.");
  }

  const payload = buildPayload(rows, models, {
    asOf: endDate,
    displayTopN: Number(args.top || DISPLAY_TOP_N)
  });

  await replaceChartData(payload);
  console.log(`Updated ${path.relative(ROOT, HTML_PATH)} with ${payload.data.length} weekly points.`);
  console.log(`Latest week ${payload.asOf}: ${formatUsd(payload.totalLatest)} estimated spend.`);
}

async function fetchRankingsDaily({ apiKey, startDate, endDate }) {
  const candidates = args.datasetUrl
    ? [args.datasetUrl]
    : [...DEFAULT_DATASET_URLS];

  const failures = [];
  for (const baseUrl of candidates) {
    try {
      const chunks = dateChunks(startDate, endDate, MAX_DATASET_DAYS);
      const responses = [];
      for (const chunk of chunks) {
        responses.push(await fetchRankingsDailyChunk({ apiKey, baseUrl, ...chunk }));
      }
      return mergeRankingsResponses(responses);
    } catch (error) {
      failures.push(`${baseUrl} -> ${error.message}`);
    }
  }

  throw new Error([
    "Could not reach OpenRouter rankings daily dataset endpoint.",
    "Tried:",
    ...failures.map((failure) => `- ${failure}`),
    "If OpenRouter changes the REST path, pass it explicitly:",
    "OPENROUTER_RANKINGS_DAILY_URL=https://... OPENROUTER_API_KEY=... npm run refresh"
  ].join("\n"));
}

async function fetchRankingsDailyChunk({ apiKey, baseUrl, startDate, endDate }) {
  const url = new URL(baseUrl);
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "User-Agent": "openrouter-token-cost-refresh/1.0"
    }
  });

  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (response.ok && contentType.includes("application/json")) {
    return JSON.parse(text);
  }

  const detail = parseErrorMessage(text);
  throw new Error(`${url.origin}${url.pathname} ${startDate}..${endDate} -> ${response.status} ${contentType || "unknown content-type"}${detail ? ` (${detail})` : ""}`);
}

function mergeRankingsResponses(responses) {
  return {
    data: responses.flatMap((response) => response.data || response.rows || response.items || []),
    meta: {
      ...(responses.at(-1)?.meta || {}),
      start_date: responses[0]?.meta?.start_date,
      end_date: responses.at(-1)?.meta?.end_date
    }
  };
}

async function fetchJson(url, { apiKey } = {}) {
  const response = await fetch(url, {
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      Accept: "application/json",
      "User-Agent": "openrouter-token-cost-refresh/1.0"
    }
  });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.json();
}

function normalizeRows(json) {
  const rows = Array.isArray(json)
    ? json
    : json.data || json.rows || json.items || json.results || [];

  return rows.map((row) => {
    const prompt = numberFrom(row.prompt_tokens, row.total_prompt_tokens, row.input_tokens);
    const completion = numberFrom(row.completion_tokens, row.total_completion_tokens, row.output_tokens);
    const reasoning = numberFrom(row.reasoning_tokens, row.total_reasoning_tokens, row.total_native_tokens_reasoning);
    const total = numberFrom(row.total_tokens, row.tokens, row.total, prompt + completion + reasoning);
    return {
      date: row.date || row.day,
      model: row.model_permaslug || row.model || row.model_id || row.slug,
      prompt,
      completion,
      reasoning,
      total
    };
  }).filter((row) => row.date && row.model && row.total > 0);
}

function buildPayload(rows, modelsJson, { asOf, displayTopN }) {
  const pricing = buildPricing(modelsJson.data || []);
  const byWeek = new Map();
  const unpricedModels = new Map();

  for (const row of rows) {
    const week = mondayUtc(row.date);
    const bucket = ensureWeek(byWeek, week);
    const isOther = row.model === "other" || row.model === "Others";
    const model = isOther ? "Others" : row.model;
    const price = pricingFor(pricing, model);

    if (isOther) {
      continue;
    }

    const cost = price
      ? calculateCost(row, price, bucket.globalRatio)
      : 0;
    if (!price) {
      const unpriced = unpricedModels.get(model) || { tokens: 0, latestSeen: week };
      unpriced.tokens += row.total;
      if (week > unpriced.latestSeen) unpriced.latestSeen = week;
      unpricedModels.set(model, unpriced);
    }

    const item = bucket.models.get(model) || {
      prompt: 0,
      completion: 0,
      reasoning: 0,
      total: 0,
      cost: 0,
      label: labelFor(model, pricing)
    };
    item.prompt += row.prompt;
    item.completion += row.completion;
    item.reasoning += row.reasoning;
    item.total += row.total;
    item.cost += cost;
    bucket.models.set(model, item);

    bucket.prompt += row.prompt;
    bucket.completion += row.completion;
    bucket.reasoning += row.reasoning;
    bucket.total += row.total;
  }

  const weeks = [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (!weeks.at(-1)) throw new Error("No weekly data after aggregation.");

  const data = weeks.map(([week, bucket]) => {
    const ys = {};
    for (const [model, item] of bucket.models) {
      ys[model] = roundMoney(item.cost);
    }

    return {
      x: week,
      ys,
      othersEstimate: {
        source: "Official daily other rows are excluded; all named OpenRouter Datasets API daily top-50 models are listed separately",
        cheapestModel: null,
        blendedRate: 0
      }
    };
  });

  const latest = data.at(-1);
  const totalLatest = roundMoney(Object.values(latest.ys).reduce((sum, value) => sum + value, 0));
  const legend = Object.entries(latest.ys)
    .map(([name, value]) => ({
      name,
      label: name === "Others" ? "Others" : labelFor(name, pricing),
      value: roundMoney(value),
      percentage: totalLatest ? roundOne((value / totalLatest) * 100) : 0
    }))
    .sort((a, b) => b.value - a.value);

  const prompt = rows.reduce((sum, row) => sum + row.prompt, 0);
  const completion = rows.reduce((sum, row) => sum + row.completion, 0);
  const ratioTotal = prompt + completion;
  const unpriced = [...unpricedModels.entries()]
    .map(([model, item]) => ({
      model,
      label: labelFor(model, pricing),
      tokens: Math.round(item.tokens),
      latestSeen: item.latestSeen
    }))
    .sort((a, b) => b.tokens - a.tokens);

  return {
    asOf,
    cachedAt: Date.now(),
    source: "openrouter-datasets-rankings-daily",
    displayTopN,
    totalLatest,
    data,
    legend,
    estimation: {
      promptRatio: ratioTotal ? prompt / ratioTotal : FALLBACK_PROMPT_RATIO,
      completionRatio: ratioTotal ? completion / ratioTotal : FALLBACK_COMPLETION_RATIO,
      source: "OpenRouter Datasets GetRankingsDaily, aggregated from daily rows into UTC Monday weeks. Current documented RankingsDailyItem rows expose total_tokens; prompt/completion pricing uses the fallback split unless the response adds split fields.",
      visibleModels: "All named models returned by OpenRouter Datasets daily top-50 rows are shown as separate series.",
      others: "Datasets official daily 'other' rows are excluded, and no synthetic Others series is created.",
      priceMatching: "Versioned slugs fall back to their canonical model slug when exact pricing is not published. Model slugs ending in ':free' are always priced at $0 and never fall back to paid model pricing.",
      unpricedModels: unpriced.slice(0, 50),
      unpricedTotalTokens: unpriced.reduce((sum, item) => sum + item.tokens, 0)
    }
  };
}

function ensureWeek(map, week) {
  if (!map.has(week)) {
    map.set(week, {
      models: new Map(),
      rawOther: { prompt: 0, completion: 0, reasoning: 0, total: 0 },
      prompt: 0,
      completion: 0,
      reasoning: 0,
      total: 0,
      globalRatio: { prompt: FALLBACK_PROMPT_RATIO, completion: FALLBACK_COMPLETION_RATIO }
    });
  }
  return map.get(week);
}

function calculateCost(row, price, fallbackBucket) {
  const ratio = ratioFor(row, fallbackBucket);
  if (row.prompt || row.completion || row.reasoning) {
    return row.prompt * price.prompt + (row.completion + row.reasoning) * price.completion;
  }
  return row.total * (price.prompt * ratio.prompt + price.completion * ratio.completion);
}

function ratioFor(row, fallbackBucket) {
  const prompt = row.prompt || 0;
  const completion = (row.completion || 0) + (row.reasoning || 0);
  const total = prompt + completion;
  if (total > 0) {
    return { prompt: prompt / total, completion: completion / total };
  }
  const fallbackTotal = (fallbackBucket.prompt || 0) + (fallbackBucket.completion || 0) + (fallbackBucket.reasoning || 0);
  if (fallbackTotal > 0) {
    const fallbackCompletion = (fallbackBucket.completion || 0) + (fallbackBucket.reasoning || 0);
    return {
      prompt: fallbackBucket.prompt / fallbackTotal,
      completion: fallbackCompletion / fallbackTotal
    };
  }
  return { prompt: FALLBACK_PROMPT_RATIO, completion: FALLBACK_COMPLETION_RATIO };
}

function buildPricing(models) {
  const map = new Map();
  for (const model of models) {
    const prompt = Number(model.pricing?.prompt || 0);
    const completion = Number(model.pricing?.completion || 0);
    const price = {
      id: model.id,
      label: model.name || model.id,
      prompt,
      completion
    };
    map.set(model.id, price);
    if (model.canonical_slug) map.set(model.canonical_slug, price);
  }
  return map;
}

function pricingFor(pricing, slug) {
  if (slug.endsWith(":free")) return freePricingFor(pricing, slug);
  if (pricing.has(slug)) return pricing.get(slug);
  const canonical = slug.replace(/-\d{8}$/, "");
  if (pricing.has(canonical)) return pricing.get(canonical);
  const loose = [...pricing.keys()].find((key) => slug.startsWith(`${key}-`) || key.startsWith(`${slug}-`));
  return loose ? pricing.get(loose) : null;
}

function freePricingFor(pricing, slug) {
  const explicit = pricing.get(slug);
  if (explicit) return { ...explicit, prompt: 0, completion: 0 };

  const paidSlug = slug.replace(/:free$/, "");
  const canonical = paidSlug.replace(/-\d{8}$/, "");
  const paid = pricing.get(paidSlug) || pricing.get(canonical);
  const label = paid
    ? /\bfree\b/i.test(paid.label) ? paid.label : `${paid.label} (free)`
    : slug;
  return {
    id: slug,
    label,
    prompt: 0,
    completion: 0
  };
}

function labelFor(slug, pricing) {
  return pricingFor(pricing, slug)?.label || slug;
}

async function replaceChartData(payload) {
  const html = await fs.readFile(HTML_PATH, "utf8");
  const json = JSON.stringify(payload);
  const next = html.replace(
    /<script id="chart-data" type="application\/json">[\s\S]*?<\/script>/,
    `<script id="chart-data" type="application/json">${json}</script>`
  );
  if (next === html) {
    throw new Error("Could not find chart-data script in index.html");
  }
  await fs.writeFile(HTML_PATH, next);
}

async function checkHtml() {
  const html = await fs.readFile(HTML_PATH, "utf8");
  const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  JSON.parse(scripts[0]);
  new Function(scripts.at(-1));
  console.log("ok");
}

function mondayUtc(isoDate) {
  const date = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function yesterdayUtc() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function dateChunks(startDate, endDate, maxDays) {
  const chunks = [];
  let cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cursor <= end) {
    const chunkStart = isoDate(cursor);
    const chunkEndDate = new Date(cursor);
    chunkEndDate.setUTCDate(chunkEndDate.getUTCDate() + maxDays - 1);
    if (chunkEndDate > end) chunkEndDate.setTime(end.getTime());
    chunks.push({ startDate: chunkStart, endDate: isoDate(chunkEndDate) });
    cursor = new Date(chunkEndDate);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return chunks;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function parseErrorMessage(text) {
  try {
    return JSON.parse(text).error?.message || "";
  } catch {
    return text.slice(0, 120).replace(/\s+/g, " ").trim();
  }
}

function numberFrom(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function roundOne(value) {
  return Math.round(value * 10) / 10;
}

function formatUsd(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value);
}

function parseArgs(argv) {
  const parsed = {
    datasetUrl: process.env.OPENROUTER_RANKINGS_DAILY_URL || "",
    startDate: process.env.OPENROUTER_RANKINGS_START_DATE || "",
    endDate: process.env.OPENROUTER_RANKINGS_END_DATE || "",
    top: process.env.OPENROUTER_DISPLAY_TOP_N || ""
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") parsed.check = true;
    else if (arg === "--dataset-url") parsed.datasetUrl = argv[++i];
    else if (arg === "--start-date") parsed.startDate = argv[++i];
    else if (arg === "--end-date") parsed.endDate = argv[++i];
    else if (arg === "--top") parsed.top = argv[++i];
  }
  return parsed;
}
