# CLI、术语表、环境变量与编程 API 参考手册

本文档提供 `pi-polisher-agent` 的完整命令行参数、术语表文件格式、环境变量配置规则、TypeScript 模块 API 及离线测试说明。

---

## 1. CLI 命令行参考

### 1.1 运行方式

```bash
# 开发 / 直接运行（通过 tsx 执行 TypeScript 源码）
npm run polish -- [选项] [待润色文本]

# 或编译后使用 Node 直接运行
npm run build
node dist/index.js [选项] [待润色文本]
```

### 1.2 输入来源优先级

当未传入 `--help` 或 `--list-skills` 时，CLI 按以下优先级决定输入来源：

1. **`--file <path>`**：从指定 UTF-8 文件读取全文。
2. **位置参数（`[待润色文本]`）**：将所有非选项参数以空格拼接作为输入。
3. **管道 `stdin`**：当标准输入非 TTY（如 `cat raw_asr.txt | npm run polish`）时，读取完整标准输入。
4. **交互式 REPL 模式**：以上均未提供且处于终端 TTY 时自动进入交互式会话。

### 1.3 完整选项表

| 选项 | 简写 | 参数 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `--file` | `-f` | `<path>` | 无 | 从文件读取待润色 ASR 转录稿 |
| `--output` | `-o` | `<path>` | 无 | 将最终润色结果写入指定文件（UTF-8） |
| `--glossary` | `-g` | `<path>` | 无 | 加载专有名词 / ASR 误识纠错术语表（支持文本或 `.json`） |
| `--chunk-size` | — | `<chars>` | `2000` | 长文语义分块最大字符数（`0` 表示关闭分块，整篇单块处理） |
| `--skill` | `-k` | `<names>` | 无 | 可选：在 ASR 高保真底线上叠加附加风格 Skill（逗号分隔或重复传入）；传 `default`/`none`/`off`/`clear` 清空 |
| `--style` | `-s` | `<names>` | 无 | `--skill` 的兼容别名 |
| `--skills-dir` | — | `<dir>` | `skills/` | 自定义风格 Skill 根目录 |
| `--list-skills` | — | 无 | `false` | 列出当前目录（或 `--skills-dir`）下全部可用附加风格 Skill 后退出 |
| `--no-review` | — | 无 | 开启评审 | 关闭评审 Agent 闭环，退化为单轮流式直出 |
| `--no-guardrails` | — | 无 | 开启预检 | 关闭评审前的确定性保真预检 |
| `--max-attempts` | — | `<n>` | `3` | 单块最大润色轮次（正整数，含初稿与返工） |
| `--review-provider` | — | `<id>` | 复用润色端 | 单独指定评审 Agent 的 Pi Provider |
| `--review-model` | — | `<id>` | 复用润色端 | 单独指定评审 Agent 的模型 ID |
| `--review-thinking` | — | `<lvl>` | 复用润色端 | 单独指定评审 Agent 的思考强度 |
| `--provider` | `-p` | `<id>` | 自动探测 | 指定润色 Agent 的 Pi Provider（如 `openai`、`anthropic`、`google`、`deepseek`） |
| `--model` | `-m` | `<id>` | 自动选择 | 指定润色 Agent 的模型 ID |
| `--thinking` | `-t` | `<level>` | `off` | 指定润色 Agent 思考强度：`off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` |
| `--help` | `-h` | 无 | `false` | 显示帮助信息并退出 |

### 1.4 交互模式内置命令

在交互模式（`原文> ` 提示符）下支持以下命令：

| 命令 | 说明 |
| :--- | :--- |
| `/skills` | 列出当前可用附加风格 Skill |
| `/skill` | 查看当前风格配置 |
| `/skill <name1,name2>` | 切换附加风格 Skill（支持逗号分隔） |
| `/skill off`（或 `none` / `default` / `clear`） | 清空附加风格，恢复默认 ASR 高保真书面化 |
| `/glossary` | 查看当前已加载术语表条数 |
| `/glossary <path>` | 从文件加载术语表（`.txt` / `.md` / `.json`） |
| `/glossary off`（或 `none` / `clear`） | 清空术语表 |
| `/chunk-size` | 查看当前分块字符上限 |
| `/chunk-size <n>` | 设置分块字符上限（`0` 为关闭分块） |
| `/review` | 查看当前评审闭环与预检状态 |
| `/review on` / `/review off` | 开启或关闭评审闭环（兼容 `true`/`false`/`1`/`0`） |
| `/max-attempts` | 查看当前单块最大润色轮次 |
| `/max-attempts <n>` | 修改单块最大润色轮次（须为 `>= 1` 的整数） |
| `exit` / `quit` | 退出交互模式 |

---

## 2. 术语表（Glossary）文件格式

通过 `-g` / `--glossary <path>` 或 `loadGlossaryFile()` 加载，支持**纯文本**与 **JSON** 两种格式：

### 2.1 文本格式（`.txt` / `.md` / `.glossary`）

```text
# 以 # 或 // 开头的注释行和空行会被忽略

# 1. ASR 误识词映射 -> 规范写法（支持 ->、=>、→，多个误识词用逗号或顿号分隔，尾部可用 | 附说明）
白莲, 白连 -> 百炼 | 阿里云大模型平台
缓存鸡穿 => 缓存击穿

# 2. 规范写法: 语境说明
Pi AgentLoop: 项目使用的核心循环框架

# 3. 纯规范专名（提示模型保持拼写与大小写一致）
DeepSeek
```

### 2.2 JSON 格式（`.json`）

支持完整对象数组或简写键值映射：

```json
[
  { "term": "百炼", "aliases": ["白莲", "白连"], "note": "阿里云大模型平台" },
  { "term": "缓存击穿", "aliases": ["缓存鸡穿"] }
]
```

或简写误识映射（自动按目标 `term` 合并别名）：

```json
{
  "白莲": "百炼",
  "白连": "百炼"
}
```

---

## 3. 环境变量配置参考

CLI 启动时会自动加载项目根目录的 `.env` 文件（通过 `dotenv/config`）。命令行显式传入的参数优先级高于环境变量。

### 3.1 内置 Provider 配置

| 环境变量 | 说明 |
| :--- | :--- |
| `OPENAI_API_KEY` | OpenAI API Key |
| `ANTHROPIC_API_KEY` | Anthropic API Key |
| `GEMINI_API_KEY` | Google Gemini API Key |
| `DEEPSEEK_API_KEY` | DeepSeek API Key |
| `OPENROUTER_API_KEY` | OpenRouter API Key |
| `PI_PROVIDER` | 可选：显式指定内置 Provider ID（如 `openai`、`anthropic`、`google`、`deepseek`、`openrouter`、`moonshot-ai`、`minimax` 等） |
| `PI_MODEL` | 可选：显式指定模型 ID；未指定时按内置偏好列表自动选择 |
| `PI_THINKING_LEVEL` | 可选：思考强度（`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`，默认 `off`） |

> 未显式指定 `PI_PROVIDER` 时，系统按 `openai → anthropic → google → deepseek → openrouter → moonshot-ai → minimax → 其他可用内置 Provider` 顺序自动探测已配置鉴权的 Provider。

### 3.2 自定义 OpenAI 兼容端点配置

适用于本地模型路由、OneAPI、阿里云百炼（DashScope）、Ollama、vLLM 等兼容 `/v1/chat/completions` 协议的服务：

| 环境变量 | 必填 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `CUSTOM_BASE_URL` | 是 | — | 接口 Base URL（例如 `http://127.0.0.1:3425/v1`） |
| `CUSTOM_MODEL` | 是 | — | 模型 ID（也可通过 `PI_MODEL` 或 `--model` 提供） |
| `CUSTOM_API_KEY` | 否 | 回退读取 `OPENAI_API_KEY` | API Key（无鉴权本地端点可填占位字符串如 `sk-placeholder`） |
| `CUSTOM_MAX_TOKENS` | 否 | `8192` | 最大输出 Token 数，支持纯数字或 `k`/`m` 后缀（如 `64k` = `65536`） |
| `CUSTOM_CONTEXT_WINDOW` | 否 | `128000` | 上下文窗口大小，支持纯数字或 `k`/`m` 后缀（如 `1m` = `1048576`） |
| `CUSTOM_REASONING` | 否 | `thinkingLevel !== "off"` | 是否声明模型支持推理模式（`true`/`false`/`1`/`0`/`yes`/`no`/`on`/`off`） |
| `CUSTOM_THINKING_LEVEL` | 否 | `off` | `PI_THINKING_LEVEL` 未设置时的备选思考强度变量 |

> **优先级说明**：只要设置了 `CUSTOM_BASE_URL` 且未显式指定 `PI_PROVIDER` / `--provider`，系统会优先走自定义 OpenAI 兼容端点。

### 3.3 评审 Agent 独立配置（可选）

默认复用润色 Agent 的 Provider、模型与思考强度；也可单独覆盖：

| 环境变量 | 对应 CLI 参数 | 说明 |
| :--- | :--- | :--- |
| `REVIEW_PROVIDER` | `--review-provider` | 评审 Agent 使用的 Provider |
| `REVIEW_MODEL` | `--review-model` | 评审 Agent 使用的模型 ID |
| `REVIEW_THINKING_LEVEL` | `--review-thinking` | 评审 Agent 使用的思考强度 |

---

## 4. TypeScript 编程 API 参考

项目使用 ESM（`"type": "module"` + `NodeNext` 模块解析），各核心模块均可直接导入复用到自己的 Node.js / TypeScript 应用中。

### 4.1 `src/workflow.ts` — 分块调度与双 AgentLoop 编排

#### `polishText(inputText, options): Promise<PolishResult>`

执行完整的 ASR 高保真润色工作流（默认开启语义分块、确定性预检与评审闭环）。

**`PolishTextOptions` 主要字段**：

| 字段 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `models` | `Models` | 必填 | 润色 Agent 使用的 Pi `Models` 注册表 |
| `model` | `Model<Api>` | 必填 | 润色 Agent 目标模型 |
| `glossary` | `readonly GlossaryEntry[]` | `[]` | 专有名词与 ASR 误识纠错术语表 |
| `chunkSize` | `number` | `2000` | 单块最大字符数（`0` 表示关闭分块） |
| `enableGuardrails` | `boolean` | `true` | 是否在评审前执行确定性保真预检并喂给评审 Agent |
| `skills` | `readonly PolishSkill[]` | `[]` | 直接注入的内存附加风格 Skill 列表 |
| `skillNames` | `readonly string[]` | `[]` | 按名称从目录加载并注入的附加风格 Skill 列表 |
| `skillsDir` | `string` | `skills/` | 配合 `skillNames` 使用的自定义 Skill 根目录 |
| `systemPrompt` | `string` | `POLISHER_SYSTEM_PROMPT` | 自定义润色员基础角色系统提示词 |
| `thinkingLevel` | `ThinkingLevel` | `"off"` | 润色 Agent 思考强度 |
| `review` | `boolean` | `true` | 是否开启评审 Agent 闭环 |
| `maxAttempts` | `number` | `3` | 单块最大润色轮次（须为 `>= 1` 的整数） |
| `reviewModels` | `Models` | 同 `models` | 评审 Agent 使用的 `Models` 注册表 |
| `reviewModel` | `Model<Api>` | 同 `model` | 评审 Agent 目标模型 |
| `reviewThinkingLevel` | `ThinkingLevel` | 同 `thinkingLevel` | 评审 Agent 思考强度 |
| `reviewSystemPrompt` | `string` | `REVIEWER_SYSTEM_PROMPT` | 自定义评审员基础角色系统提示词 |
| `onTextDelta` | `(delta: string) => void` | — | 润色文本增量回调（单轮直出模式下适用） |
| `onLoopEvent` | `(event: PolishLoopEvent) => void` | — | 监听分块、预检与评审闭环阶段事件 |
| `onEvent` | `(event: AgentEvent) => void` | — | 监听润色 Agent 原始 Pi 事件 |
| `onReviewEvent` | `(event: AgentEvent) => void` | — | 监听评审 Agent 原始 Pi 事件 |

**`PolishLoopEvent` 事件联合类型**：

```typescript
type PolishLoopEvent =
  | { type: "polish_start"; attempt: number; maxAttempts: number; chunkIndex?: number; chunkCount?: number }
  | { type: "polish_complete"; attempt: number; draftText: string; chunkIndex?: number; chunkCount?: number }
  | { type: "review_start"; attempt: number; fidelityChecks?: FidelityCheckReport; chunkIndex?: number; chunkCount?: number }
  | { type: "review_complete"; attempt: number; review: ReviewResult; chunkIndex?: number; chunkCount?: number }
  | { type: "retry_scheduled"; nextAttempt: number; maxAttempts: number; review: ReviewResult; chunkIndex?: number; chunkCount?: number };
```

**`PolishResult` 返回值**：

```typescript
interface PolishResult {
  originalText: string;            // 去除首尾空白后的原始输入
  polishedText: string;            // 全部分块合并后的最终定稿
  provider: string;                // 润色模型 Provider ID
  modelId: string;                 // 润色模型 ID
  appliedSkills: string[];         // 本次实际注入的附加风格 Skill 名称列表
  glossaryCount: number;           // 本次注入的术语表条数
  attempts: number;                // 全部块累计执行的润色总轮次
  reviewEnabled: boolean;          // 是否开启了评审闭环
  passed: boolean;                 // 是否全部分块均通过评审（关闭评审时恒为 true）
  review?: ReviewResult;           // 最后一个分块的最终评审结论
  chunks: ChunkPolishResult[];     // 每个分块的原文、定稿、轮次与评审明细
  failedChunks: ChunkPolishResult[]; // 未通过评审的分块清单（便于人工定点复核）
  rounds: PolishRound[];           // 扁平化的各轮记录（含每轮 fidelityChecks 与 review）
  usage?: Usage;                   // 最后一个分块最后一轮的润色 Token 用量
  messages: AgentMessage[];        // 合并后的润色对话消息记录
}
```

其他导出：
- `createPolisherAgent(options: PolisherAgentOptions): Agent`
- `parseMaxAttempts(raw?: number | string): number` / `DEFAULT_MAX_ATTEMPTS = 3`
- `parseChunkSize(raw?: number | string): number` / `DEFAULT_CHUNK_SIZE = 2000`

---

### 4.2 `src/chunker.ts` — 语义分块与滑动上文

- `splitTranscriptIntoChunks(rawText, options?): TextChunk[]` — 按段落、句末标点与弱停顿边界切分长文。
- `extractTailContext(polishedText, maxChars?): string` — 提取上一块润色稿末尾 1～2 句作为只读衔接上文（默认上限 `240` 字）。
- `parseChunkSize(raw): number` / `DEFAULT_CHUNK_SIZE` / `DEFAULT_CONTEXT_MAX_CHARS`。

---

### 4.3 `src/glossary.ts` — 术语表解析与注入

- `parseGlossaryText(raw, isJsonHint?): GlossaryEntry[]` — 解析文本或 JSON 格式术语表并按规范词去重合并。
- `loadGlossaryFile(filePath): Promise<GlossaryEntry[]>` — 读取并解析磁盘术语表文件。
- `formatGlossaryForInjection(entries): string` — 序列化为 `<glossary>` 注入块。

---

### 4.4 `src/guardrails.ts` — 确定性保真预检

- `runFidelityChecks(originalText, draftText, options?): FidelityCheckReport` — 执行压缩/膨胀比、数值/时间锚点、英文专名、上文泄漏、寒暄前缀与术语未修正 6 项确定性检查。
- `formatFidelityChecksForReview(report): string` — 将命中的告警序列化为 `<automated_checks>` 提示块供评审 Agent 逐条核实。

---

### 4.5 `src/models.ts` / `src/skills.ts` / `src/reviewer.ts` / `src/prompts.ts`

- **`src/models.ts`**：`resolveModelConfig`、`createCustomOpenAIConfig`、`parseTokenCount`、`parseThinkingLevel`、`VALID_THINKING_LEVELS`。
- **`src/skills.ts`**：`discoverSkills`、`loadSkills`、`parseSkillMarkdown`、`formatSkillsForInjection`、`DEFAULT_SKILLS_DIR`。
- **`src/reviewer.ts`**：`reviewPolishDraft`、`createSubmitReviewTool`、`normalizeReviewResult`、`parseReviewFromText`、`SUBMIT_REVIEW_TOOL_NAME`。
- **`src/prompts.ts`**：`POLISHER_SYSTEM_PROMPT`、`REVIEWER_SYSTEM_PROMPT`、`composePolisherSystemPrompt`、`composeReviewerSystemPrompt`、`buildPolishUserPrompt`、`buildReviewUserPrompt`、`buildRevisionUserPrompt`。

---

## 5. 开发、测试与构建

```bash
# 类型检查（不产出构建文件）
npm run typecheck

# 运行离线自动化测试（基于 Pi fauxProvider，无需真实 API Key）
npm test

# 编译 TypeScript 至 dist/
npm run build
```

自动化测试（`src/workflow.test.ts`，共 14 项）使用 `@earendil-works/pi-ai` 的 `fauxProvider` 覆盖：
- 基础角色系统提示词与单轮流式直出
- 单个/多个附加风格 Skill 注入、去重与自定义目录加载
- 双 AgentLoop 闭环：首轮通过、打回后第二轮修订通过、达 `maxAttempts` 停止
- 评审 Agent 未调工具时的 JSON 兜底解析与异常处理
- 自定义 OpenAI 兼容端点注册、`k`/`m` Token 与思考强度解析
- `chunker` 语义分块、关闭分块、无标点兜底切分与滑动上文提取
- `glossary` 文本/JSON 解析、去重合并与 XML 注入格式化
- `guardrails` 6 类保真风险检出与中文数字/时间格式容错
- 多块长转录稿全链路：滑动上文传递 + 术语表同注双 Agent + 预检告警喂给评审 + 回锚原文返工 + `failedChunks` 定位
