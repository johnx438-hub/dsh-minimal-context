# dsh-minimal-context

Minimal-agent 上下文漏斗，作为独立的 DeepSeek Harness 插件。

Opt-in `agent/pre-step` 上下文漏斗：**pointerize → prune → compact → summarize**。
- pointerize / prune / compact 会替换先前轮次的 `tool/result` 表面（卡片 / 截断正文）；
- summarize 是纯阈值规则（非 LLM，零成本）；
- `recall_query` 工具读取冷日志原文；`context_focus` 临时提高工具结果的 inline 保留窗口。

默认组合不启用本插件；显式加载即可：

```bash
dsh plugin --profile web add dsh-minimal-context
```

在 agent preset 的 `agent.cordis.yml` 中注册为一行：

```yaml
- id: minimal-context
  name: 'dsh-minimal-context'
  config:
    pointerizeMinChars: 400
    pruneThresholdChars: 8192
    summarizeMinChars: 80000
    surfaceBudgetEnabled: true
```

## 模型工具

| 工具 | 作用 |
|---|---|
| `recall_query` | 取回被指针化的冷日志原文（卡片 → 全文） |
| `context_focus` | 临时提高指定工具结果的 inline 保留窗口（默认 12 turn，可配） |

## 配置（均有默认值）

- `pointerizeMinChars` — 超过该字符数的 tool/result 指针化（默认 400）
- `pointerizeNeverTools` — 永不指针化的工具名（默认 `['recall_query']`）
- `pruneThresholdChars` / `pruneHeadChars` / `pruneTailChars` — 裁剪阈值与头尾保留
- `maxFullCardsPerTurn` / `maxCompactPerStep` — 每轮完整卡片 / 压缩上限
- `summarizeMinChars` / `summarizeMinNodes` — 触发摘要的阈值
- `surfaceBudget*` / `budget*` — 预算驱动的指针化/裁剪参数（`surfaceBudgetEnabled` 默认 true）
- `taskSummaryInterval` — TaskSummary 注入间隔（默认 12，仅真实压缩后注入）

## 行为细节

- 只对先前轮次 surface 做**替换**（卡片/截断体），不追加自定义 `funnel/*` 会话事件；
- TaskSummary 以 `user/message`（`source: {kind:'plugin', form:'notice'}`）注入，最多同时一条可见块（原地替换），且只在真实发生压缩或超预算时注入；
- token 校准器从日志的 `assistant/chunk usage` 事件读取真实 inputTokens，EWMA 更新本地估算；
- 设置 `MINIMAL_FUNNEL_DEBUG=1` 可在 stderr 输出每轮 surface 统计。

## 与 worker 编排插件的关系

本包只含上下文管线 + `recall_query`/`context_focus`。worker 编排
（`session_create` / `persona_list` / `delegate_task` / tool-nudge）在
sibling 包中，两者零交叉依赖，可独立加载。

## 开发

```bash
npm install
npm run build
npm test
```

## License

MIT
