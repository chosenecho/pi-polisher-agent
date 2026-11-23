# 贡献指南（Contributing）

欢迎提交 Issue、补充内置风格 Skill、改进确定性保真预检规则或优化双 AgentLoop 编排。

---

## 1. 开发环境准备

- **Node.js**：建议使用 Node.js 20 及以上版本（项目使用原生 `node:test` 与 ESM 模块）。
- **安装依赖**：

```bash
npm install
```

- **可选环境变量**：如需本地联调真实模型，复制 `.env.example` 为 `.env` 并填写模型配置；仅运行自动化测试无需任何真实 API Key。

---

## 2. 常用开发命令

```bash
# TypeScript 严格类型检查
npm run typecheck

# 运行全量离线自动化测试（基于 Pi fauxProvider）
npm test

# 编译至 dist/
npm run build

# 查看 CLI 帮助与可用 Skill
npm run polish -- --help
npm run polish -- --list-skills
```

---

## 3. 代码与架构约定

1. **保持核心定位**：默认工作流以 **ASR 转录稿书面化高保真（意思不漂移）** 为第一底线，评审维持极简二元（`passed: true | false`）结论。
2. **ESM 相对导入带 `.js` 后缀**：`tsconfig.json` 配置了 `moduleResolution: "NodeNext"`，源码中相对路径导入必须显式写 `.js`（例如 `import { polishText } from "./workflow.js";`）。
3. **标准流职责分离**：CLI 所有日志、进度与提示写 `stderr`，`stdout` 仅输出最终润色正文。
4. **双 Agent 标准同步**：凡影响改写规范的上下文（如术语表、风格 Skill）须同时注入润色 Agent 与评审 Agent。

---

## 4. 贡献新的风格 Skill

1. 在 `skills/<skill-name>/SKILL.md` 新增文件，包含规范 YAML Frontmatter（`name`、`description`）、风格目标、可核验的改写细则及 2～3 组 `原文 → 润色` 示例。
2. 确保 Skill 规则不与「忠于原意、保持语种、纯净输出」基础底线冲突。
3. 更新 `src/workflow.test.ts` 中的内置 Skill 发现断言，并在 `README.md` / `docs/skills-guide.md` 同步登记。

---

## 5. 编写离线单元测试

所有新增能力或 Bug 修复均应在 `src/workflow.test.ts` 中补充基于 `@earendil-works/pi-ai` `fauxProvider` 的离线测试，不发起真实网络请求：

```typescript
const polisherFaux = fauxProvider({ provider: "faux-polisher-case" });
const reviewerFaux = fauxProvider({ provider: "faux-reviewer-case" });
const models = createModels();
models.setProvider(polisherFaux.provider);
models.setProvider(reviewerFaux.provider);
```

---

## 6. 提交规范

提交前请确保以下三项全部通过且同步更新相关文档：

```bash
npm run typecheck && npm test && npm run build
```

Commit Message 建议遵循 Conventional Commits 风格，例如：
- `feat: 新增 SRT 字幕时间戳解析预处理`
- `fix: 修复无标点长段切块时的边界空白处理`
- `docs: 补充术语表 JSON 格式说明`
- `test: 增加上文重复泄漏预检边界用例`
