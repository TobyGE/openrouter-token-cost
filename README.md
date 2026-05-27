# OpenRouter Rankings USD Chart

这个静态 HTML 复刻 `https://openrouter.ai/rankings` 页面第一张 `Top Models` 图的结构：按周堆叠柱状图、底部排名图例、hover 后按当周数据重排。区别是原图显示 token usage，这里把 token 用量换算成美元估算值，并且纵轴用 million USD 显示绝对金额。

## 打开

```bash
open /Users/yingqiang/openrouter-token-cost/index.html
```

## 刷新数据

刷新脚本优先接 OpenRouter 文档里的 Datasets daily rankings 数据：`GET https://openrouter.ai/api/v1/datasets/rankings-daily`。然后再拉公开模型价格表，按周聚合成图表数据并写回 `index.html`。

```bash
cd /Users/yingqiang/openrouter-token-cost
export OPENROUTER_API_KEY=<your-openrouter-api-key>
npm run refresh
npm run check
```

不要把 API key 写进 repo、README、GitHub Actions、issue 或 commit message；只在本机 shell 环境变量里临时设置。

可选参数：

```bash
npm run refresh -- --start-date 2025-01-01 --end-date 2026-05-26
```

如果 OpenRouter 调整了 Datasets REST path，可以显式指定：

```bash
OPENROUTER_RANKINGS_DAILY_URL='https://openrouter.ai/api/v1/...' \
OPENROUTER_API_KEY=<your-openrouter-api-key> \
npm run refresh
```

## 当前内置快照

- 最新周：2026-05-25
- 最新周估算总消费：约 `$12.05M`，截至 2026-05-26 的部分周数据。
- 当前内置数据来自 OpenRouter Datasets API，daily top-50 历史聚合口径，共 74 个周点。
- Datasets path 来自 OpenRouter TypeScript SDK 和 Datasets API reference。脚本里仍保留 path override，方便 OpenRouter 后续改路由。

## 维护页面

```bash
open /Users/yingqiang/openrouter-token-cost/maintain.html
```

`maintain.html` 会读取 `index.html` 里的图表 payload，检查最新周、free 模型是否被误计价、是否还存在 `Others`、以及找不到公开价格的模型列表。每周刷新后先看维护页，再决定是否提交更新。

## 换算口径

- Preferred source：OpenRouter Datasets daily rankings API，daily top 50 public models；官方 `other` row 会被读取但不纳入金额计算。
- Citation：`Source: OpenRouter (openrouter.ai/rankings), as of {as_of}`。
- 模型价格：`https://openrouter.ai/api/v1/models`
- 官方 `RankingsDailyItem` schema 当前只有 `date`、`model_permaslug`、`total_tokens`，没有每个模型的 prompt/completion 拆分。
- 如果 dataset row 后续包含 prompt/completion token 拆分，就按自己的输入/输出 token 和公开价格计算。
- 如果 dataset row 只有 total token，就用 `96.2%` prompt / `3.8%` completion 的全局观测比例兜底。
- 模型 slug 以 `:free` 结尾时一律按 `$0` 计算，不会回退到同名付费模型价格。
- 找不到公开价格的非 free 模型会按 `$0` 进入图表，但会记录在 payload 的 `estimation.unpricedModels` 里，避免静默低估。
- 图上列出所有 named top-50 模型，不再折叠 `Others`。
- Datasets 的官方 `other` row 不再估算，因为它没有模型明细；图里也不再创建合成 `Others`。

## 主要假设和遗漏

- 图表不包含官方 long-tail `other` row，因此不是 OpenRouter 总流量或总收入。
- cache read/write、reasoning、media/audio、web search、tool calls 可能有单独计价，当前图没有完整展开。
- 公开标价不一定等于 OpenRouter 实际收入，可能受 provider routing、折扣、免费额度和临时价格影响。
- rankings 数据和模型价格可能有缓存时间差。
