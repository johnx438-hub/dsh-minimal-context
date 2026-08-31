# 提案补充:Recallable Compaction 三刀实战补丁

> 目标文档:`deepseek-harness/.agents/notes/proposed/feature/2026-07-06-recallable-compaction.md`
> 来源:minimal-agent-ts super-heavy 实战(dogfood 已验证,`src/context/super-heavy*.ts`)
> 提交人:DSH (AgentMin) + minimal (txyy) 三方协作
> 日期:2026-08-31

## 摘要

官方 recallable-compaction 提案设计成熟,但三处实战缺口未覆盖。minimal-agent-ts 的
super-heavy 压缩(顺序链重写 + rollback 快照)已跑通并验证可复原(2162→734→2164),
以下三刀是**已验证的实战补丁**,建议并入官方 note 的 design / follow-ups:

1. **手动触发 + 投影快照回退**(官方只有自动压力阀 + 失败降级,无"手动 + 可一键还原"档位)
2. **纯代码顺序 stub**(官方代码 stub 只在失败时出现;minimal 证明纯代码 stub 可作为**主路径**,不依赖摘要 LLM;理论根基 = "过程可重放、事实不可重放",见刀 2)
3. **folded=0 空操作可观测性**(官方 inflation guard 失败时只"commits nothing",不告诉模型为什么)

## 背景:统一哲学 —— "只动投影,冷存储神圣不可侵犯"

minimal 侧的上下文管理是**一个统一体系、两个尺度**,不是两个独立插件:

- **funnel(日常尺度)**:上下文永远只放**投影**(指针卡片 + TaskSummary + 渐进遗忘后的引用),全量原文永远完整躺在硬盘冷存储(ActionStore / vault),`recall_query` 随时捞回 —— 无损换介质,不是有损压缩
- **super-heavy(重压尺度)**:深度折叠时**也只动 current_messages 投影**,原文冷存储从不 touch,快照可一键回退 —— 2162→734→2164 实测可复原

两者共享同一条铁律:**压的永远是投影,原文永远完整**。这解释了为什么 super-heavy 能无损可复原 —— 不是"压缩后恢复质量高",而是**根本没碰原文,只是投影换了种更省的表示**。建议官方 recallable-compaction 采用同一立场:压缩的边界 = 投影,event log / ActionStore 永远只增不改,召回 = 读回原文而非重建。

### 子原则三则(压缩主题的通用规律)

1. **剪枝可复原**:压缩是降级引用,不是灭记忆 —— 冷存储保原始,折叠只换表示(super-heavy 2162→734→2164 实测)
2. **事实保原文 / 过程保摘要**(replay vs recall):工具结果 = 外部事实(不可重放,必须原文);对话推理 = 内部过程(可重放/可摘要)。压缩的正确姿势 = 事实保原文(recall 捞回),过程保顺序(顺序链重放)
3. **压缩改变形状**:任何"看 body 内容做判断"的逻辑(幂等/去重/审计),都要**感知压缩后的形状**,不能只认原始形状 —— 否则压缩把 body 从"完整标记"变成"compacted 标记"后,幂等判断误判"没处理过",重复注入(实测:funnel L2 压缩后 injectAuditBlocks 重新灌回完整 diff,幂等检查必须覆盖 hasAuditDisplay / compacted / summary-only 三种形状)

---

## 刀 1:手动触发 + 投影快照回退

### 官方缺口
recallable-compaction 是自动压力阀驱动,失败时 commit nothing 但不提供:
- **显式手动触发**(用户/模型主动发起一次重压缩)
- **快照回退**(压缩后不满意可一键还原到压缩前)

官方 note 只在 Alternatives 提到 "Doing nothing (resume/fork as recovery) — rejected",
没有"压缩本身可回退"的设计。

### minimal 实战(H1 + H5,已验证)
`src/context/super-heavy-rollback.ts`:

```ts
export interface SuperHeavyRollbackBlob {
  /** 由 SUPER_HEAVY_ROLLBACK_VERSION 常量定义（当前 = 1 as const），勿写死字面量 */
  version: typeof SUPER_HEAVY_ROLLBACK_VERSION;
  session_id: string;
  created_at: string;
  reason?: string;
  /** True while a super-heavy rewrite is active and restore is available. */
  pending: boolean;
  messages: ChatMessage[];
}
```

- **H1 rollback = restore current_messages from snapshot** —— 压缩前深拷贝当前投影,
  `/super-heavy restore` 一键还原
- **H5 pending 快照阻塞再次压缩**(除非 force)—— 防止快照被后续压缩覆盖
- **关键纪律:冷存储(ActionStore / transcript)从不被 touch** —— 快照只作用于
  current_messages 投影,还原不丢任何已持久化数据
- 投影快照存盘(`sessionsDir()/super-heavy-rollback-*.json`),跨重启可用

### 建议并入官方
- 在 Pass execution 增加 `manualPass`(显式触发,复用同一 chunk/stub/state 管线)
- 每次 pass 前写投影快照(仅 current_messages,不碰 event log),pass 后 `history_read` 之外
  提供 `compact_restore`(恢复投影 + 回滚 state checkpoint 到快照时刻)
- pending 语义:快照存在期间自动 pass 被阻塞或必须 force —— 防止用户手动实验期间被自动压缩覆盖

---

## 刀 2:纯代码顺序 stub(主路径,不依赖摘要 LLM)

### 理论根基:过程可重放,事实不可重放(replay vs recall)

为什么 stub 该是纯代码、而 tool/result 必须原文?这不是"零 LLM 依赖"的工程偏好,
而是第一性原理:

- **工具结果 = 世界的事实**(外部):读过的文件、API 返回、命令输出 —— 记录的是
  "世界当时实际是什么样"。**不可重放**:外部世界已经变了,重放拿不回当时的字节。
  恢复 = 只能按 callId 从 append-only 日志**捞回原始字节**(recall),不能重建。
- **对话/推理 = 我的过程**(内部):内部思考的先后。**可重放 / 可摘要**:重放整个 log
  或压成顺序链,都能重建过程的骨架。

压缩的正确姿势由此推出:**事实保原文(recall 捞回),过程保顺序(顺序链重放)**。
官方 `history_read` / `history_search` 定位是"把 shadowed span 渲染回 transcript"——
本质仍是**重放路线**(渲染 = 重建);本提案建议补一个**事实层恢复通道**:tool/result
直接给原文(recall 路线),不是渲染后的表面。两者互补:重放重建过程,recall 捞回事实。

### 官方缺口
官方 note 中代码 stub 只在**失败降级**路径出现:
> "A failed stub call degrades the same way: its slice gets a code-only pointer stub"

主路径仍依赖 summarize LLM 调用。这带来:
- 摘要 LLM 不可用/超时 → 整个 pass 依赖唯一的硬依赖
- stub 内容质量 = LLM 质量,不稳定

### minimal 实战(H3 keep-set + H4 L1 stubs,已验证)
`src/context/super-heavy-chain.ts`:

```ts
export const SUPER_HEAVY_CHAIN_PREFIX = '[super-heavy-chain]';
export const DEFAULT_CHAIN_MAX_ENTRIES = 80;
export const DEFAULT_CHAIN_MAX_CHARS = 6_000;
```

- **keep-set 计算纯代码**:system + TaskSummary + protect 窗(近 user turns / 最近 tokens / 当前 turn)保留,其余 fold
- **顺序链 stub 纯代码生成**:每消息压成一行 `[turn N] <短摘要>`,按顺序拼接,上限
  maxEntries=80 / maxChars=6000,超限截断
- **零 LLM 依赖**:stub 是确定性字符串变换,replay 字节一致
- 与官方 stub 的关系:**L1 stub(代码链)保留"发生了什么",L2 摘要(LLM)保留"为什么"** —— 两级并存,不是替代
- **L1 确定性是主路径的关键**:代码 stub 是确定性字符串变换,字节级 replay 一致(LLM stub 每次生成都有随机性);因此代码 stub 是可复现基线,LLM stub 是增强——这与官方"state checkpoint 是唯一硬依赖"咬合:代码 stub 主路径下,pass 的硬 LLM 依赖仅剩 state checkpoint 一处

### 建议并入官方
- Frozen index checkpoint 增加 `stubKind: 'code' | 'llm'` —— 代码 stub 作为 chunk 的
  **默认主路径**(确定性、零依赖),LLM 摘要作为升级选项
- 官方 "failed stub call → code-only pointer stub" 的降级链变为:代码 stub 不是降级,
  是**基线**;LLM stub 是增强
- 好处:pass 的硬 LLM 依赖从"每个 chunk 一次"降到"仅 state checkpoint 一次"
  (官方 note 已承认 state 是唯一硬依赖,代码 stub 主路径让这句话真正成立)

---

## 刀 3:folded=0 空操作可观测性

### 官方缺口
官方 inflation guard:
> "if the post-compaction size is not strictly below the pre-compaction size, nothing commits
> and the turn proceeds"

但模型/user 只看到"没压缩",**不知道是"内容全被 protect 盖住"还是"guard 拦截"**。
短会话/保护窗大的会话会反复触发空操作,模型无法判断是否该调参。

### minimal 实战(commit 571e93d,已验证)
`src/runner.ts` super-heavy 报告:

```
noop: 无可折叠消息（folded=0）— 近窗/protect 已盖住全部 284 条，投影未压缩。
      可用 /super-heavy restore 丢掉这次空快照；若要更狠需另收紧保留窗。
```

- **folded=0 显式区分**:明确说"protect 盖住全部",而不是误导性的 "ok: 284→284"
- **给出下一步动作**:restore 丢空快照 / 收紧保留窗 —— 模型可据此调参
- **可观测性即训练数据**:空操作原因进入 log,训练时模型学会"什么时候该调 protect"

### 建议并入官方
- Guard 失败时输出**结构化原因码**:`GUARD_INFLATION`(尺寸没降)/ `NO_FOLDABLE`(无可折叠内容,
  全被 protect/stub 边界盖住)/ `PENDING_SNAPSHOT`(快照阻塞)
- 原因码进 `compaction/summary` 事件的 payload,模型可见,bench 可统计
- 空操作不静默:即使 commit nothing,也发一个 log-only 事件说明原因

---

## 分工与状态

- **C 继续 minimal 狗粮(主)**:super-heavy 体感验证进行中(顺序/因果/细节是否无损失),
  跑几天积累真实案例 —— minimal 侧,txyy
- **A 喂提案(并行)**:本文档,DSH 侧已完成
- **B 旁路实验(缓)**:不实现官方同名后端,等狗粮跑稳 + 提案被吸收后再定

## 关联文件

- minimal 实现:`src/context/super-heavy.ts` / `super-heavy-chain.ts` / `super-heavy-rollback.ts`
- 实战验证:2162→734→2164 可复原(txyy 实测,2026-08-30)
- 空操作修复:commit `571e93d`(folded=0 可观测性)
