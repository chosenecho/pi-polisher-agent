# AGENTS.md

本项目是 **ASR 语音转录稿书面化高保真润色双 AgentLoop 工作流**（基于 `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai`）。

## 核心不变量（改动时必须守住）

- **语义保真优先**：润色默认即「ASR 书面化 + 意思不漂移」；附加风格 Skill 只能在保真前提下生效。
- **评审极简二元制**：评审只输出 `passed: true | false`（不引入打分制），主路径通过 `submit_review` 工具（`terminate: true`）单步结束，保留 `parseReviewFromText` JSON 兜底。
- **双 Agent 同标**：`glossary` 与 `skills` 必须同步注入润色 Agent 与评审 Agent，确保润色与审校使用同一把尺子。
- **基础提示词标签洁净**：`POLISHER_SYSTEM_PROMPT` 与 `REVIEWER_SYSTEM_PROMPT` 正文中只用自然语言指代“术语表”“风格 Skill”，避免直接写出字面 `<style_skills>` / `<glossary>` 标签（这些标签仅在真实注入时由格式化函数拼接，且单元测试以此断言未注入状态）。
- **流隔离**：`src/index.ts` 中所有进度日志、预检告警、评审结论与人工复核清单写 `stderr`，`stdout` 只输出最终润色正文。
- **ESM 导入约定**：`tsconfig.json` 使用 `NodeNext`，所有相对模块导入统一带 `.js` 后缀（例如 `./workflow.js`）。
- **离线可测**：所有逻辑变更都通过 `@earendil-works/pi-ai` 的 `fauxProvider` 在 `src/workflow.test.ts` 补齐离线测试，不依赖真实 API Key。

## 平台注意项

- Windows 下通过 `npm run polish -- "..."` 传递包含换行符的文本参数时，`cmd.exe` 会截断换行后的内容；实测多段长文本时改用 `--file <path>` 或通过管道传给 `node dist/index.js`。

## 校验流程

提交任何代码修改前运行：

```bash
npm run typecheck && npm test && npm run build
```

## 按需查阅的参考文档

- 修改分块、滑动上文、确定性预检或双 AgentLoop 钩子（`finishTurn` / `prepareNextTurnWithContext`）时，阅读 [docs/architecture.md](docs/architecture.md)。
- 新增、调整风格 Skill 或排查 `SKILL.md` 解析与注入规则时，阅读 [docs/skills-guide.md](docs/skills-guide.md)。
- 调整 CLI 参数、环境变量、术语表格式或导出 TypeScript API 时，阅读 [docs/api-and-cli.md](docs/api-and-cli.md)。
- 排查运行期模型端点、分块参数、预检误报或 Windows 编码/管道问题时，阅读 [docs/troubleshooting.md](docs/troubleshooting.md)。
