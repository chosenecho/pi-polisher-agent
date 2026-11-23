# Pi 文本润色员 Agent 工作流

基于 Pi 官方核心包（`@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai`）搭建的**双 Agent 闭环文本润色工作流**：

- **系统提示词（Role-Play 层）**：专注于确立“专业文字润色员”与“严格文字质检评审员”的角色身份与核心底线。
- **风格 Skill（可插拔层）**：具体输出风格以独立 `SKILL.md` 文件组织，显式选择后同步注入润色 Agent 与评审 Agent，确保润色与审校使用同一把尺子。
- **AgentLoop 质量把关闭环**：基于 Pi 原生 `finishTurn` + `prepareNextTurnWithContext` 钩子驱动。每轮润色完成后由独立评审 Agent 调用 `submit_review` 工具给出**通过 / 不通过**二元结论；不通过则自动附带问题清单与修改建议打回重做，直至通过或达到 `maxAttempts` 上限。

> 注：旧包名 `@mariozechner/pi-agent-core` / `@mariozechner/pi-ai` 已官方弃用并迁移至 `@earendil-works/pi-agent-core` / `@earendil-works/pi-ai`。

## 项目结构

```text
├── skills/
│   ├── formal/SKILL.md      # 正式商务 / 公文风格 Skill
│   ├── concise/SKILL.md     # 精炼干练风格 Skill
│   ├── transcript/SKILL.md  # 视频/音频转录文稿书面化风格 Skill（保留原始逻辑）
│   └── vivid/SKILL.md       # 生动文采风格 Skill
├── src/
│   ├── prompts.ts        # 润色员 / 评审员角色系统提示词、Skill 拼装与返工指令构造
│   ├── reviewer.ts       # 评审 Agent 与 submit_review 工具（二元“通过 / 不通过”判定 + JSON 兜底）
│   ├── skills.ts         # 风格 Skill 扫描、Frontmatter 解析、加载与注入格式化
│   ├── models.ts         # Pi Models / Provider 配置（内置 + 自定义 OpenAI 兼容端点）
│   ├── workflow.ts       # 双 AgentLoop 闭环编排（createPolisherAgent / polishText）
│   ├── index.ts          # CLI 入口（支持 --skill、--max-attempts、--no-review、文件、管道、交互模式）
│   └── workflow.test.ts  # 基于 Pi fauxProvider 的自动化测试
├── .env.example          # 环境变量配置示例
├── package.json
└── tsconfig.json
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置模型 API Key

复制 `.env.example` 为 `.env` 并填写任意一个可用模型的 Key：

```bash
cp .env.example .env
```

支持两种配置方式：
- **Pi 内置 Provider**：配置 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GEMINI_API_KEY`、`DEEPSEEK_API_KEY`、`OPENROUTER_API_KEY` 等，可选指定 `PI_PROVIDER`、`PI_MODEL` 与 `PI_THINKING_LEVEL`。
- **自定义 OpenAI 兼容接口**（如本地路由、阿里云百炼 DashScope、OneAPI、Ollama、vLLM）：配置 `CUSTOM_BASE_URL`、`CUSTOM_API_KEY`、`CUSTOM_MODEL`（以及可选的 `CUSTOM_MAX_TOKENS`、`CUSTOM_CONTEXT_WINDOW`、`CUSTOM_REASONING`）。
- **评审 Agent 模型**（可选）：默认复用润色 Agent 配置；也可通过 `REVIEW_PROVIDER`、`REVIEW_MODEL`、`REVIEW_THINKING_LEVEL` 或对应 CLI 参数单独指定。

### 3. 运行工作流

```bash
# 查看所有可用的风格 Skill
npm run polish -- --list-skills

# 默认运行（开启评审 Agent 闭环，最多 3 轮）
npm run polish -- "今天我去公园玩了，天气特别特别好，然后我看到了很多花都很漂亮。"

# 注入单个风格 Skill（内置：formal | concise | transcript | vivid）
npm run polish -- --skill formal "明天早上9点开个项目会，别迟到啊。"

# 视频/音频转录文稿书面化（去除口语杂音，最大限度保留原讲述逻辑）
npm run polish -- --skill transcript "嗯就是说，一开始我们以为是网络慢，然后查了半天发现其实是接口超时了，所以就先把超时时间调大了一点。"

# 同时叠加多个风格 Skill，并自定义最大轮次
npm run polish -- --skill formal,concise --max-attempts 4 --file input.txt --output polished.txt

# 关闭评审闭环，退化为单轮流式直出
npm run polish -- --no-review --skill concise "这个方案我觉得还行，就是有点太长了，需要改改。"

# 通过管道输入（stderr 打印评审进度，stdout 仅输出最终定稿）
echo "这个方案我觉得还行，就是有点太长了，需要改改。" | npm run polish -- --skill concise

# 进入交互式模式（支持 /skills、/skill formal,concise、/review on|off、/max-attempts <n>）
npm run polish
```

## 扩展自定义风格 Skill

在 `skills/`（或 `--skills-dir` 指定的目录）下新建 `<skill-name>/SKILL.md` 即可自动发现并生效，无需修改代码：

```markdown
---
name: xiaohongshu
description: 轻快有网感的小红书分享风格
---

# 小红书风格

## 改写细则
1. 开头用简短有吸引力的钩子句。
2. 分点呈现信息，句式短小轻快。
...
```

## 作为模块调用

```typescript
import { resolveModelConfig } from "./src/models.js";
import { polishText } from "./src/workflow.js";

const { models, model, thinkingLevel } = await resolveModelConfig();

const result = await polishText("明天早上9点开个项目会，别迟到啊。", {
  models,
  model,
  thinkingLevel,
  skillNames: ["formal", "concise"],
  review: true,
  maxAttempts: 3,
  onLoopEvent: (event) => {
    if (event.type === "review_complete") {
      console.error(
        `[第 ${event.attempt} 轮] ${event.review.passed ? "通过" : "不通过"}：${event.review.summary}`,
      );
    }
  },
});

console.log("通过评审：", result.passed, "实际轮次：", result.attempts);
console.log("润色完成：", result.polishedText);
```

## 测试与构建

```bash
npm run typecheck
npm test
npm run build
```
