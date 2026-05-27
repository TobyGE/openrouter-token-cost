#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const HTML_PATH = path.join(ROOT, "index.html");
const OUT_DIR = path.join(ROOT, "assets");
const OUT_PATH = path.join(OUT_DIR, "chart-preview.svg");

const WIDTH = 1280;
const HEIGHT = 640;
const MARGIN = { top: 92, right: 38, bottom: 64, left: 86 };
const COLORS = [
  "#22c55e", "#38bdf8", "#f97316", "#a855f7", "#14b8a6", "#f43f5e",
  "#eab308", "#6366f1", "#84cc16", "#06b6d4", "#fb7185", "#8b5cf6",
  "#10b981", "#0ea5e9", "#f59e0b", "#64748b", "#ec4899", "#4ade80"
];

const html = await fs.readFile(HTML_PATH, "utf8");
const payload = extractPayload(html);
const svg = render(payload);

await fs.mkdir(OUT_DIR, { recursive: true });
await fs.writeFile(OUT_PATH, svg);
console.log(`Wrote ${path.relative(ROOT, OUT_PATH)}`);

function extractPayload(html) {
  const match = html.match(/<script id="chart-data" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error("Could not find chart-data script in index.html");
  return JSON.parse(match[1]);
}

function render(payload) {
  const data = payload.data;
  const latestOrder = payload.legend.map((item) => item.name);
  const allKeys = [...new Set(data.flatMap((point) => Object.keys(point.ys)))];
  const series = [
    ...latestOrder,
    ...allKeys.filter((key) => !latestOrder.includes(key)).sort()
  ];
  const color = new Map(series.map((key, index) => [key, COLORS[index % COLORS.length]]));
  const plotW = WIDTH - MARGIN.left - MARGIN.right;
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const totals = data.map((point) => Object.values(point.ys).reduce((sum, value) => sum + value, 0));
  const yMax = niceCeil(Math.max(...totals));
  const barGap = 4;
  const barW = Math.max(3, (plotW - barGap * (data.length - 1)) / data.length);
  const gridValues = [0, yMax * 0.25, yMax * 0.5, yMax * 0.75, yMax];
  const tickIndexes = pickTickIndexes(data.length, 6);

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="OpenRouter weekly model spend stacked bar chart">`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="#fafafa"/>`,
    `<g font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif">`,
    `<g transform="translate(22 26)">`,
    `<path d="M4 19V5M4 19h17M8 16V9M13 16V4M18 16v-6" fill="none" stroke="#374151" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    `<text x="34" y="22" fill="#111827" font-size="28" font-weight="700">Top Models</text>`,
    `<text x="0" y="54" fill="#6b7280" font-size="16">Weekly API spend of models across OpenRouter</text>`,
    `</g>`,
    `<rect x="${WIDTH - 162}" y="22" width="126" height="42" rx="8" fill="#fff" stroke="#d1d5db"/>`,
    `<text x="${WIDTH - 144}" y="49" fill="#374151" font-size="16" font-weight="600">This Week</text>`,
    `<path d="M${WIDTH - 54} 39l5 5 5-5" fill="none" stroke="#374151" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
  ];

  for (const value of gridValues) {
    const y = yFor(value, yMax, plotH) + MARGIN.top;
    parts.push(`<line x1="${MARGIN.left}" y1="${round(y)}" x2="${WIDTH - MARGIN.right}" y2="${round(y)}" stroke="#e5e7eb" stroke-width="1"/>`);
    parts.push(`<text x="22" y="${round(y + 5)}" fill="#9ca3af" font-size="15" font-weight="600">${axisMoney(value)}</text>`);
  }

  data.forEach((point, index) => {
    const x = MARGIN.left + index * (barW + barGap);
    let stacked = 0;
    for (const key of series) {
      const value = point.ys[key] || 0;
      if (!value) continue;
      const h = Math.max(0.75, (value / yMax) * plotH);
      const y = MARGIN.top + plotH - ((stacked + value) / yMax) * plotH;
      parts.push(`<rect x="${round(x)}" y="${round(y)}" width="${round(barW)}" height="${round(h)}" fill="${color.get(key)}"/>`);
      stacked += value;
    }
  });

  for (const index of tickIndexes) {
    const point = data[index];
    const x = MARGIN.left + index * (barW + barGap) + barW / 2;
    parts.push(`<text x="${round(x)}" y="${HEIGHT - 26}" text-anchor="middle" fill="#9ca3af" font-size="15" font-weight="600">${formatDate(point.x)}</text>`);
  }

  parts.push(`</g></svg>`);
  return `${parts.join("\n")}\n`;
}

function yFor(value, yMax, plotH) {
  return plotH - (value / yMax) * plotH;
}

function niceCeil(value) {
  const units = [1_000_000, 2_500_000, 5_000_000, 10_000_000, 12_500_000, 25_000_000, 50_000_000, 100_000_000];
  return units.find((unit) => unit >= value) || Math.ceil(value / 100_000_000) * 100_000_000;
}

function axisMoney(value) {
  if (value === 0) return "$0";
  return `$${Number((value / 1_000_000).toFixed(1)).toString()}M`;
}

function pickTickIndexes(length, count) {
  const indexes = new Set();
  for (let i = 0; i < count; i++) {
    indexes.add(Math.round((i / (count - 1)) * (length - 1)));
  }
  return [...indexes].sort((a, b) => a - b);
}

function formatDate(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  return date.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function round(value) {
  return Number(value.toFixed(2));
}
