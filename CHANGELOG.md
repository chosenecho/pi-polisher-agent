# 变更日志（Changelog）

本项目按时间记录主要架构演进与功能变更。

---

## [Unreleased]

### 新增与完善
- 新增 [AGENTS.md](AGENTS.md)，记录面向 AI Coding Agent 的核心不变量、平台注意项与按需文档索引。
- 新增 [docs/troubleshooting.md](docs/troubleshooting.md)，覆盖分块与保真调优、预检告警解读、Windows 多行输入注意项与端点排障。
- 新增 [CONTRIBUTING.md](CONTRIBUTING.md)、[CHANGELOG.md](CHANGELOG.md) 与 [glossary.example.txt](glossary.example.txt) 术语表示例模板。

---

## [0.2.0] - 2026-11-23 (`0d1b4fe`)

### 架构升级：聚焦 ASR 转录稿书面化高保真润色（防意思漂移）
- **默认角色升级**：将 `POLISHER_SYSTEM_PROMPT` 与 `REVIEWER_SYSTEM_PROMPT` 升级为默认面向 ASR 语音转录稿的高保真书面化与「意思不漂移 = 一票否决」保真评审；现有风格 Skill 转为保真底线之上的可选附加层。
- **语义分块 + 滑动上文（`src/chunker.ts`）**：支持按段落 / 句末标点 / 弱停顿边界三层切分长转录稿，通过 `<previous_context>` 传递只读衔接上文；新增 `--chunk-size` 与交互命令 `/chunk-size`。
- **专有名词术语锚点（`src/glossary.ts`）**：支持文本与 JSON 格式术语表及同音误识映射，同步注入润色与评审双 Agent；新增 `-g / --glossary` 与交互命令 `/glossary`。
- **确定性保真预检（`src/guardrails.ts`）**：零模型成本检测有效字数压缩/膨胀比、数值/时间锚点、英文专名、上文泄漏、寒暄前缀与术语表未修误识，作为 `<automated_checks>` 喂给评审 Agent 重点核实；新增 `--no-guardrails`。
- **回锚原文定点返工与人工复核清单**：打回修订时注入 `<original_text_reference>` 防止多轮二次漂移；长文出现达上限仍未通过的分块时，输出 `result.failedChunks` 并在 CLI `stderr` 打印人工复核定位清单。
- **测试与文档**：离线单元测试扩充至 14 项；新增 `docs/architecture.md`、`docs/skills-guide.md`、`docs/api-and-cli.md` 并全面更新 `README.md`。

---

## [0.1.0] - 2026-11-23 (`e069077`)

### 初始版本
- 基于 `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai` 搭建双 AgentLoop 文本润色闭环（`finishTurn` + `prepareNextTurnWithContext` + `submit_review` 工具与 JSON 兜底）。
- 实现可插拔风格 Skill 体系，内置 `formal`、`concise`、`transcript`、`vivid` 四个 `SKILL.md`。
- 支持 Pi 内置 Provider 自动探测、自定义 OpenAI 兼容端点（支持 `64k`/`1m` Token 简写与思考强度配置）、文件/参数/管道/交互式 CLI 及离线 `fauxProvider` 测试套件。
