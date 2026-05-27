# OpenRouter Rankings USD Chart

A static chart that mirrors the first `Top Models` chart on
[`openrouter.ai/rankings`](https://openrouter.ai/rankings), but converts weekly
token usage into estimated USD spend.

The chart is generated from OpenRouter's daily rankings dataset and public model
pricing. It is intended for lightweight weekly manual maintenance, not as an
official revenue report.

## Files

- `index.html` - the published chart.
- `maintain.html` - a local audit page for checking the embedded chart data.
- `scripts/refresh.js` - fetches rankings and prices, then rewrites the chart
  payload inside `index.html`.

## View Locally

Open `index.html` in a browser, or serve the directory with any static file
server.

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/index.html`.

## Weekly Update

Run the refresh locally. Keep your OpenRouter API key in your shell environment
only; do not commit it, paste it into GitHub, or store it in the repository.

```bash
export OPENROUTER_API_KEY=<your-openrouter-api-key>
npm run refresh
npm run check
unset OPENROUTER_API_KEY
```

Review the maintenance page after refreshing:

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000/maintain.html` and check:

- latest dataset date
- whether any `:free` model has nonzero cost
- whether an `Others` series was accidentally reintroduced
- non-free models that could not be matched to a public price

If the update looks correct:

```bash
git add index.html README.md
git commit -m "Refresh OpenRouter spend data"
git push
```

## Optional Refresh Arguments

```bash
npm run refresh -- --start-date 2025-01-01 --end-date 2026-05-26
```

If OpenRouter changes the rankings dataset path:

```bash
OPENROUTER_RANKINGS_DAILY_URL="https://openrouter.ai/api/v1/..." \
OPENROUTER_API_KEY=<your-openrouter-api-key> \
npm run refresh
```

## Current Snapshot

- Latest week: `2026-05-25`
- Latest-week estimated spend: about `$12.05M`, using data through `2026-05-26`
- Weekly points: `74`
- Source: OpenRouter Datasets daily rankings API, aggregated into UTC Monday
  weeks

## Methodology

- Rankings source: OpenRouter Datasets daily rankings API, daily top 50 public
  models.
- Price source: `https://openrouter.ai/api/v1/models`.
- Official dataset `other` rows are excluded. No synthetic `Others` series is
  created.
- Every named model returned by daily top-50 rows is shown as its own series.
- Dataset rows currently expose total tokens, not per-model prompt/completion
  splits. When only total tokens are available, the script uses a fallback split
  of `96.2%` prompt and `3.8%` completion.
- If OpenRouter later returns prompt/completion token fields, the script uses
  those fields directly.
- Model slugs ending in `:free` are always priced at `$0` and never fall back to
  paid-model pricing.
- Versioned model slugs fall back to canonical model slugs when possible.
- Non-free models without a matched public price are included at `$0` and
  recorded in `estimation.unpricedModels` inside the chart payload.

## Limitations

- This does not include OpenRouter's official long-tail `other` row, so it is
  not total OpenRouter traffic or revenue.
- Historical weeks use the current public model price table, not verified
  historical weekly prices.
- Cache read/write, reasoning, media/audio, web search, tool calls, discounts,
  credits, and provider-specific routing may not be fully priced.
- Public list prices may differ from OpenRouter's actual revenue.

When republishing the chart or numbers, cite:

```text
Source: OpenRouter (openrouter.ai/rankings), as of {as_of}
```
