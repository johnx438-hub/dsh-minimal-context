# Funnel 元层审计块 — Spec

> 目标:把 DSH edit/write 已计算但隐藏的 diff 渲染成模型可见的审计块,
> 并接入 funnel 指针化协同 —— "降低审计成本,锚定事实"的第一层落地。
> 状态:草案(待 grok 碰撞 + 作者 review)
> 日期:2026-08-31

## 背景与动机

### 发现:DSH 的 diff 是"算好藏起来"的

排查 `deepseek-harness/packages/fs/tool-fs/src/`:

```
edit/write 执行
  → computeHunkDiffs() 计算完整 diff(3 行上下文 hunks)
  → 存进 tool/result 的 meta.diffs(opaque 附加,持久化到 session log)
  → render() 模型侧只输出: "Updated file" / "Edited ..."  ← 一句话
  → presentResult UI 侧:diff 卡(模型看不到,UI 看得到)
```

**结论**:diff 算好了、持久化了,但模型侧 render 只给一句话。DSH 不是没有审计能力,
是"diff 藏在 meta + UI 层,模型不可见"。这与 minimal 的 `[edit_display]`(内嵌模型文本)相反。

### 为什么值得做(审计成本 + 事实锚定)

- **审计成本**:模型每次改文件,只看到 "Updated file",无法确认"到底改对了没"——
  要审计得自己再 read 一遍(成本高、易漏)
- **事实锚定**:`file_hash` 是"改后版本"的锚点,可检测并发改文件(改错版本立刻发现)
- **与投影哲学同构**:summary(事实)→ 保留;display(过程)→ 可指针化压缩

### 定位:funnel 元 cordis 的第一层

funnel 已 hook tool/result 处理链(pointerize/pre prune),审计块挂在同一注入点,
**DSH 本体零改动** —— 这就是"元层"特性叠加的正确姿势。

## 改动范围

### 核心改动(funnel 侧,DSH 零改动)

**1. 新增 `src/audit.ts`** — 把 meta.diffs 渲染成模型可见审计块

```ts
export function renderDiffAudit(event: SessionEvent): string | null
  // 输入:tool/result 事件(edit_file / write_file 的)
  // 从 event.data.meta?.diffs 取 hunks(复用 DSH 的 isFileDiff 防御性校验)
  // 生成:
  //   ok: edited /abs/path (N bytes) file_hash=<sha256>   ← summary(事实)
  //   [edit_display]                                        ← display(过程)
  //   --- a/... (edit)
  //   +++ b/... (edit)
  //   @@ -10,3 +10,4 @@
  //    ...
  //   [/edit_display]
  // 无 diff(纯新建/无变更)→ null(不硬造)
  // 从 event.data.message.meta 读(不是自己算!)
```

**2. pipeline 注入点(pointerize 前)** — `src/pipeline.ts`

```ts
// 在 pointerize 处理 tool/result 前:
const audit = renderDiffAudit(event)
if (audit) {
  // summary 部分 → 普通文本,永不指针化(事实层)
  // display 部分 → 标记为可指针化(过程层)
}
```

### 分层(L3/L4 为储备,本次不做)

| 层 | 内容 | 状态 |
|---|---|---|
| L1 审计块 | 上述 audit.ts + pipeline hook | **本次** |
| L2 指针化协同 | eligibility 识别 `[edit_display]` 块 → display 可压 | **本次(同 PR)** |
| L3 门禁 | funnel 配置显式声明(工具名单/禁隐式继承) | 储备(借鉴 ee17758) |
| L4 探测 | 冷存储/recall 可用性探测 + 修复配方 | 储备(借鉴 14a8f76) |

## 潜在坑(排查已确认)

1. **meta.diffs 别信裸数据** — opaque 附加,必须复用 DSH 的 `isFileDiff` narrowing 再渲染
2. **别双份计算 diff** — 只渲染 DSH 已算好的,不自算(性能 + 一致性)
3. **recall 路径不动** — 审计块是额外渲染,冷存储/捞回逻辑零改动
4. **指针化不误伤** — 只压 display,summary 永不指针化(事实层)
5. **funnel 是链接包** — 改完 rebuild + 重启 DSH 才生效
6. **file_hash 语义** — 是"改后版本"的 hash,不是差异的;用于并发检测

## 落地步骤

```
Step 1: src/audit.ts —— renderDiffAudit(渲染 meta.diffs → 审计块)
Step 2: src/pipeline.ts —— pointerize 前合并,display 标记可压
Step 3: tests —— 正常 edit / 无 diff 新建 / 大文件 diff 指针化 / recall 捞回
Step 4: spec 存档 + 提交推送(公开 repo)
```

## 验收标准

- [ ] edit 后模型侧文本 = "ok: edited X (N bytes) file_hash=H" + [edit_display] diff
- [ ] 指针化后上下文里 display 变指针卡,summary 仍在
- [ ] recall_query(审计块 action_id)能捞回完整 diff
- [ ] 无 diff 的操作(新建文件)不硬造审计块
- [ ] DSH 本体(tool-fs)零改动,现有测试不回归

## 待碰撞(grok)

1. meta.diffs 的读取路径:event.data.message.meta 还是 event.meta?需对源码确认
2. display 标记怎么让 pointerize 识别:约定 `[edit_display]` 标记 vs 显式 eligibility 名单
3. summary 永不指针化:放 pointerizeNeverTools 还是按块标记?

## Grok 碰撞结论(2026-08-31,已吸收)

### ① meta.diffs 读取路径(有坑,已确认)
- 读 **ToolResult.meta = presentationMeta**(展示层),不是 persisted meta
- 用 DSH 自己的 `diffsFromMeta` 收窄(isFileDiff narrowing),别裸读 opaque
- **加单测钉住真实字段路径**:先读一条真实 edit 事件,把字段名写进测试,防 DSH 改版漂移

### ② display 指针化标记方式
- **`[edit_display]` 块约定 + pointerize 按块压**;eligibility 名单只做辅助
- 只有按块边界压,才是"真协同"(只压 display,summary 保留),不是整条 tool/result 变卡
- 名单不单独扛"summary/display 分裂"

### ③ 平面归属(不搅,已界定)
- 审计块 = **Agent-plane(funnel)**:会话表面投影增强(让模型看见已有 opaque meta)
- 与 IM/MCP host 正交:"IM 比 MCP 更值得切平面"是跨 bot/runtime 共享 store 的撞车面,
  审计是单会话表面,平面不同,不冲突

### 三条别踩的边界
1. 别让 funnel 去改 IM 内部/schedule
2. 别为了审计去改 dsh-tool-fs(DSH 本体零改动声明,对)
3. **"双份给人看"可接受**:GUI 已用 presentResult 画 diff 卡,模型侧再出 [edit_display]
   是模型需要审计 + UI 继续用 meta,不冲突(UX 不是 hub 搅和)

### spec 修正清单(grok 增量)
- [x] audit.ts 读 presentationMeta,用 diffsFromMeta 收窄
- [x] 加"真实 edit 事件字段路径"单测(钉死路径防漂移)
- [x] display 按 `[edit_display]` 块边界压,eligibility 名单只辅助
- [x] 平面注释:审计 = Agent-plane(funnel),与 IM/MCP host 正交
- [x] "双份给人看"可接受:模型需要审计,UI 继续用 meta
