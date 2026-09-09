# 本地自用：`read` / `edit` 的 PTC 结构化调用契约

状态：`target / local-only`

适用分支：`local-use`

基线：`main@9af053515dd9e260fe80f881ad8c44f4c412c594`

## 1. 分支定位

`main` 只作为干净的上游同步主干使用，不在其中直接承载个人功能改动。

`local-use` 是长期本地自用集成分支：实际运行、验证和继续累积个人功能都在该分支进行。它允许相对 `main` 长期存在本地差异，但应尽量保持改动小、边界清晰，便于持续吸收上游。

如果未来准备向上游提交 PR，不直接从该自用分支提 PR。应从当时最新的干净 `main` 新建独立功能分支，再选择性重做或 cherry-pick 适合上游的提交；PR 分支只包含准备贡献的最小改动。

## 2. 本次开发范围

本次只优化 `read` 与 `edit` 的调用和 canonical 返回值，并同步两层模型提示：

1. 工具自身 schema / `description`：告诉调用者新增参数、返回形态和兼容规则。
2. 注入 system prompt 的 `tool:read` / `tool:edit` guidance：告诉模型在原生直接工具调用与 PTC / `run_code` 调用中分别应该选择哪种形态。

本次不修改 DeepSeek Harness / PTC 本体，不修改 HMR、并发、SessionView、SQLite、hash 算法、错误传输协议、trace，也不新增工具。

默认行为必须保持兼容：不显式请求结构化模式时，`read` 与 `edit` 的现有调用和返回不变。

## 3. 为什么需要两层提示同时修改

当前 `src/prompts.ts` 已有两类文本：

- `READ_DESCRIPTION` / `EDIT_DESCRIPTION`：进入工具 catalog / schema 的短说明。
- `READ_GUIDANCE` / `EDIT_GUIDANCE`：经 `src/guidance/resolve.ts` 组成 `tool:read` / `tool:edit` section，进入 system prompt；还支持 per-preset override。

因此 API 增加结构化模式后，不能只修改 schema，也不能只修改 guidance。两处必须描述同一个契约，否则模型可能知道参数却不知道何时使用，或者 system prompt 仍要求解析旧的 `HASH│content` / textual diff。

## 4. `read` 目标契约

### 4.1 输入

在现有参数上仅增加：

```ts
format?: "annotated" | "records"
```

默认值是 `"annotated"`，省略时完全保持当前行为。

不在本次加入 `plain`。PTC 中需要纯文本时可直接从 `records.rows[].content` 组合，避免额外维护一种读取/served 语义。

### 4.2 默认 `annotated` 返回

默认 canonical 返回保持当前契约：

```ts
{
  text: string
  warning?: string
}
```

`text` 继续使用当前 `HASH│content` 文本和当前分页/截断提示格式。现有直接工具调用、现有 prompt、现有消费者不能因为这次改动而被迫迁移。

### 4.3 `records` 返回

显式调用：

```ts
const page = await tools.read({
  path: "src/foo.ts",
  offset: 1,
  limit: 100,
  format: "records",
})
```

目标 canonical 返回：

```ts
{
  format: "records",
  rows: [
    { line: 1, hash: "A3x", content: "const foo = 1;" },
    { line: 2, hash: "B9q", content: "return foo;" },
  ],
  total_lines: 237,
  next_offset: 101,
  warning?: "..."
}
```

`ReadRecord`：

```ts
type ReadRecord = {
  line: number      // 1-based，全文件绝对行号
  hash: string      // bare 3-char anchor，不含 │
  content: string   // 原始行内容，不含 HASH│ 前缀
}
```

要求：

- `rows` 只包含本次页面中真正展示并记录为 served 的完整行；禁止返回整个文件的 hashes / normalized 内容。
- 分页、byte truncation、oversized-line 过滤后的 served 集合必须与 `rows` 使用同一个语义来源，不能先生成 `HASH│content` 再反向 parse。
- `warning` 继续与文件内容分离，不进入 `content`，也不参与 hash。
- `next_offset` 表示继续读取下一页时应使用的 1-based offset；没有下一页时省略。
- `total_lines` 表示完整文件的逻辑总行数。
- offset 超出 EOF 时保持现有“成功但无可读行”的总体行为，不为了 records 模式引入新的错误协议。
- 空文件必须继续提供现有“可用于插入内容的 anchor”能力。records 下的精确表示需要以当前空文件测试为基线锁定；实现时优先保持 anchor 能力，而不是为了表面上的 `rows=[]` 破坏后续 edit。
- 超大单行如果当前逻辑不能安全 serve，则 records 也不能伪造一个可编辑 hash。必要说明留在 metadata / warning，而不是把截断内容伪装成完整 `content`。

### 4.4 实现边界

不要实现成：

```ts
const text = renderHashLines(...)
const rows = parseHashLines(text)
```

应从 `FileView` / read pipeline 已经拥有的语义数据产生一个可复用页面结果，再分别投影：

```text
semantic read page
  ├─ annotated -> 当前 HASH│content 文本
  └─ records   -> typed rows + pagination metadata
```

本次只做支撑这两个投影所需的最小调整，不顺带重构 hash、session 或 storage 层。

## 5. `edit` 目标契约

### 5.1 输入

在现有参数上仅增加：

```ts
result_format?: "text" | "structured"
```

默认值是 `"text"`，省略时完全保持当前 textual diff 返回。

### 5.2 默认 `text` 返回

保持当前 canonical 返回：

```ts
string
```

当前成功摘要、diff、fresh anchors、warning 等文本行为继续保留，直接工具调用无需迁移。

### 5.3 `structured` 返回

显式调用：

```ts
const result = await tools.edit({
  path: "src/foo.ts",
  edits: [["A3x", "B9q", "const foo = 2;\nreturn foo;"]],
  result_format: "structured",
})
```

目标返回应保持紧凑：

```ts
{
  format: "structured",
  classification: "applied" | "noop",
  metrics: {
    edits_attempted: number,
    edits_noop: number,
    warnings: number,
    classification: "applied" | "noop",
    changed_lines?: { first: number, last: number },
    added_lines?: number,
    removed_lines?: number,
  },
  fresh_rows: [
    { line: 17, hash: "R4a", content: "..." },
    { line: 18, hash: "m72", content: "..." },
  ],
  warnings?: string[],
  drift_notice?: string,
}
```

优先复用现有 `RMetrics` 字段和语义，不为了结构化模式再发明一套重复统计口径。

### 5.4 `fresh_rows` 的关键约束

`fresh_rows` 是给后续 chained edit 使用的最小 post-edit anchor 窗口，不等于当前内部 `EditDetails.servedRows`。

当前成功路径会构造 dense `servedRows`，可能覆盖结果文件的每一行。禁止直接把它公开为 `fresh_rows`，否则修改大文件一行也会返回整个文件的 hashes，抵消结构化模式的价值。

`fresh_rows` 应只覆盖：

```text
少量前置上下文
+ 实际修改后的变化区域
+ 少量后置上下文
```

默认以变化范围前后各 1 行作为目标，具体边界以现有 diff anchor 语义和测试为准。

删除场景也必须返回删除后仍存在的边界行，使下一次 edit 能直接继续。例如删除原第 18-19 行后，应至少能看到原第 17 行与随后顶上来的新第 18 行的 fresh anchors。

noop 返回允许 `fresh_rows: []`；不要为了填充字段重新读取整个文件。

### 5.5 structured 模式的输出成本

structured 模式的目标之一是避免 PTC 再解析 textual diff。因此实现时优先让 structured 路径直接从已有 mutation / result state 构造返回值；如果能在不扩大本次改动面的前提下避免构造完整 diff 字符串，应避免构造。

但默认 `text` 模式继续走现有 diff 行为。本次不要求为了消除 diff 而重写整个 `Mutation` / `edit-response` 架构。

### 5.6 错误保持原样

本次不把失败包装成 `{ ok:false, ... }` 的成功返回，也不为 PTC 新建 typed error 协议。

现有 throw / `[MODEL] [E_*]` / `[USER]` 错误和提示语义保持不变。结构化成功返回只解决“成功后机器还需要解析字符串”的问题。

## 6. PTC / `run_code` 提示策略

新增 API 后，system guidance 必须明确区分两种消费方式。

### 6.1 原生直接工具调用

模型直接调用 `read` / `edit` 时，继续推荐默认模式：

- `read` 默认 `annotated`，模型直接看到 `HASH│content`。
- `edit` 默认 `text`，模型直接看到带 fresh anchors 的 diff。

这是当前插件针对模型直接消费优化过的体验，不应被 PTC 优化破坏。

### 6.2 PTC / `run_code`

当模型是在 `run_code` 中通过 `tools.read(...)` / `tools.edit(...)` 调用插件时，guidance 应明确推荐：

```ts
await tools.read({ ..., format: "records" })
await tools.edit({ ..., result_format: "structured" })
```

并明确说明：

- 在 `run_code` 中消费 canonical typed value，不要为了取 hash / content 再 parse `HASH│content` 文本。
- `read(..., format:"records")` 直接从 `rows` 取得 `line` / `hash` / `content`。
- `edit(..., result_format:"structured")` 直接从 `fresh_rows` 取得下一次 edit 所需的新 anchors。
- 只有在确实需要面向模型的人类可读 diff 时才请求默认 `text` 返回。
- 不要在结构化结果之外再调用一次 read，仅仅为了重新取得刚刚返回在 `fresh_rows` 中的 anchors。

### 6.3 `READ_DESCRIPTION` / `EDIT_DESCRIPTION` 要表达的内容

`READ_DESCRIPTION` 保持短小，但应补充：

- 默认返回 `HASH│content` annotated view。
- `format:"records"` 供 programmatic / `run_code` 使用，返回 typed rows 与分页 metadata。

`EDIT_DESCRIPTION` 保持短小，但应补充：

- 默认返回 textual diff。
- `result_format:"structured"` 供 programmatic / `run_code` 使用，返回 metrics + minimal fresh rows。

工具 description 只说明能力与参数，不复制整段 PTC 使用教程。

### 6.4 `READ_GUIDANCE` / `EDIT_GUIDANCE` 要调整的内容

当前 guidance 中“read 每行都是 `HASH│content`”和“edit 成功后从 returned diff 拿 fresh anchors”都只能作为默认/direct 模式描述，不能再写成无条件事实。

建议 guidance 收敛为类似规则：

```text
`read`: direct tool use defaults to HASH│content; inside run_code/PTC prefer format:"records" and consume rows directly instead of parsing rendered text.
```

```text
`edit`: direct tool use defaults to a diff with fresh anchors; inside run_code/PTC prefer result_format:"structured" and continue from fresh_rows instead of parsing the diff.
```

其他 anchor 安全规则继续保留：edit 输入仍使用 bare 3-char HASH，replacement_text 仍是纯文件内容，不能包含 `HASH│` 前缀。

### 6.5 per-preset guidance

`src/prompts.ts` 的 compiled defaults 改动后，必须注意 `$DSH_HOME/plugins/dsh-better-edit/<preset>/{read,edit}.md` 是可编辑 override，而且已有非空文件不会被自动覆盖。

因此验证时至少覆盖：

1. 没有 override 时，新 compiled guidance 正确进入 system prompt。
2. 新安装/新 home 的 seeded guidance 含新的 PTC 规则。
3. 已存在用户自定义 guidance 时不擅自覆盖；如果本地实际运行需要立刻采用新规则，应手工同步自己的 preset override。

这不是要求本次重写 guidance materializer，只是避免代码改了而实际运行仍读旧 override。

## 7. 最小测试要求

### `read`

- 省略 `format` 时，参数、canonical 返回和 render 与当前行为兼容。
- `format:"annotated"` 与省略 `format` 等价。
- `format:"records"` 返回 typed rows，不需要字符串解析。
- line 为 1-based absolute line；hash 为 bare 3-char；content 不含 hash 前缀。
- 分页的 `total_lines` / `next_offset` 正确。
- records 中只有真正 served 的完整行。
- warning 不混入 rows/content。
- 空文件保持可插入 anchor 能力。
- oversized line / truncation 不制造无效可编辑 anchor。

### `edit`

- 省略 `result_format` 与 `result_format:"text"` 保持当前 string diff 行为。
- `structured` applied/noop 均有稳定 typed shape。
- metrics 与当前 `RMetrics` 语义一致。
- `fresh_rows` 是最小窗口，不是 dense whole-file served rows。
- 替换、插入、删除都返回足够的 post-edit anchors 供 chained edit。
- warnings / drift notice 保持独立字段。
- 失败仍走当前 error 路径，不被包装成成功对象。

### prompt

- tool descriptions 暴露新增参数与返回模式。
- compiled `tool:read` / `tool:edit` guidance 明确区分 direct 与 PTC / `run_code`。
- PTC 示例不再要求 parse `HASH│content` 或 textual diff。
- 现有 bare-hash / replacement_text 安全规则不丢失。

完整验证仍按仓库要求执行：

```bash
pnpm run typecheck
pnpm test
pnpm run build
```

## 8. 明确不做

本轮不做：

- `read format:"plain"`
- structured typed errors
- PTC trace
- 修改 Harness / `run_code`
- read concurrency / `isConcurrencySafe`
- keyed lock
- SessionView / SQLite query 合并
- HashAssign / canon 优化
- undo API 结构化
- 大范围架构重构

如果上述方向以后确实需要，单独立需求，不借这次 `read` / `edit` API 优化顺手带入。

## 9. 完成标准

实现完成时应满足：

1. 原生直接工具调用体验与现有版本等价。
2. PTC / `run_code` 可以完全通过 typed results 完成 read → edit → chained edit，不需要解析 `HASH│content` 或 textual diff。
3. 新增结构化返回不会因为全文件 hashes、重复文本或冗余 diff 造成响应膨胀。
4. tool descriptions 与 system guidance 对新契约描述一致。
5. 改动集中在 `read` / `edit` API 及其提示词所需最小范围，便于长期维护 fork 和持续同步上游。
