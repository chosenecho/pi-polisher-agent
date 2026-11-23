# 实践调优与常见问题排查

本文档汇总使用 `pi-polisher-agent` 处理真实长篇 ASR 转录稿时的参数调优建议与常见报错排查方法。

---

## 1. 参数调优建议

### 1.1 `--chunk-size` 如何设置

| 场景 | 推荐设置 | 原因 |
| :--- | :--- | :--- |
| 常规视频 / 播客 / 课程长逐字稿（3,000～30,000 字） | `1500`～`2500`（默认 `2000`） | 既能保留完整论述语境，又能避免单次生成过长引发的隐式摘要，且单块打回返工成本低 |
| 高密度技术/金融访谈（含大量数字、专名、因果推导） | `1200`～`1500` | 缩小单块范围可显著提升确定性预检与评审 Agent 发现细微逻辑偏移的精度 |
| 短文本（< 1,500 字）或需要整篇一次性统一结构 | `0`（关闭分块） | 整篇作为单块处理，避免多余的切块边界 |

### 1.2 如何进一步降低“意思漂移”概率

当处理重要长稿仍偶发细节偏移时，建议按以下顺序加强把关：

1. **先补术语表（`-g glossary.txt`）**：把视频/会议里反复出现的专有名词、产品名、人名及常见 ASR 误识写入术语表，收益最高。
2. **提高评审模型规格或思考强度**：润色可用速度更快的模型，评审单独配更强模型或更高思考强度（例如 `--review-thinking high` 或 `--review-provider` / `--review-model`）。
3. **调小 `--chunk-size`**：例如从 `2000` 降到 `1200`，让每块聚焦 2～3 个自然段落。
4. **关注 `stderr` 中的 `[人工复核清单]`**：若某块达到 `--max-attempts` 仍未通过，优先人工核对清单中指出的分块编号，无需通读全文。

---

## 2. 确定性保真预检（Guardrails）解读

确定性预检（`src/guardrails.ts`）的定位是**把高风险信号喂给评审 Agent 核实**，而非机械一刀切拦截：

| 告警码 | 含义 | 常见正常放行情景 | 常见应打回情景 |
| :--- | :--- | :--- | :--- |
| `compression_too_high` | 净字数低于原文 `55%` | 原文含极大量结巴、整段重复口误，或叠加了 `--skill concise` | 润色员擅自把详细案例总结成了一句话 |
| `expansion_too_high` | 净字数高于原文 `135%` | 极少见，通常仅出现在补全大量省略主语时 | 润色员脑补背景解释或重复输出了上文 |
| `missing_numbers` / `added_numbers` | 数值/时间锚点增减 | 口误自我纠错（如“30% 不对 50%”删掉了 `30%`） | 漏掉关键数据、改错比例或年份 |
| `missing_terms` | 原文英文专名/缩写消失 | 被准确意译为约定中文名 | 漏掉关键技术名（如 `Redis`、`QPS`） |
| `context_leak` | 润色稿开头疑似复写 `<previous_context>` | 极少误报 | 润色员把上一块衔接句又抄了一遍 |
| `chatty_preamble` | 开头含“润色后如下：/好的，以下是…” | 基本无误报 | 润色员带上了多余寒暄前缀 |
| `unfixed_glossary_alias` | 原文出现的术语表误识词仍残留在润色稿中 | 基本无误报 | 漏改了术语表明确指定的 ASR 错词 |

> 如果你在某些特殊场景（如强制配合 `--skill concise` 做大幅压缩）下不需要预检告警提示，可通过 `--no-guardrails` 关闭。

---

## 3. 常见问题排查

### Q1：Windows 下命令行传多行文本时，只处理了第一段？
- **原因**：在 Windows 下运行 `npm run polish -- "第一段\n\n第二段"` 时，`npm.cmd` 会经由 `cmd.exe` 转发参数，`cmd.exe` 遇到字面换行符会直接截断后续文本。
- **解决**：处理多段文本时始终使用 `--file` 读取文件，或通过管道传给编译产物：
  ```powershell
  # 推荐方式 1：从文件读取
  npm run polish -- --file raw_asr.txt --output polished.txt

  # 推荐方式 2：PowerShell 管道传给 node dist/index.js
  npm run build
  Get-Content -Raw -Encoding UTF8 raw_asr.txt | node dist/index.js --glossary glossary.txt > polished.txt
  ```

### Q2：报错 `未检测到可用的模型鉴权配置`
- 确认项目根目录下已从 `.env.example` 复制并创建 `.env` 文件（`.env` 不会被提交到 Git）。
- 若使用内置 Provider，至少填写一个对应的 `*_API_KEY`。
- 若使用自定义 OpenAI 兼容端点，必须同时配置 `CUSTOM_BASE_URL` 与 `CUSTOM_MODEL`（无鉴权本地端点可将 `CUSTOM_API_KEY` 设为占位值如 `sk-placeholder`）。

### Q3：自定义 OpenAI 兼容端点调用失败（404 / 连接拒绝 / 不支持工具调用）
- **404 Not Found**：检查 `CUSTOM_BASE_URL` 是否包含 `/v1` 路径前缀（例如 `http://127.0.0.1:3425/v1`）。
- **连接拒绝（ECONNREFUSED）**：确认本地代理/路由/Ollama/vLLM 服务已启动且端口一致。
- **评审报错 `评审 Agent 未调用 submit_review 工具，且输出无法解析为 JSON`**：
  - 优先排查所选模型是否支持 Function Calling；
  - 若模型不支持工具调用但能输出纯 JSON，系统会自动走 `parseReviewFromText` 兜底；若模型连 JSON 也输出不稳定，建议通过 `--review-provider` / `--review-model` 为评审 Agent 单独指定一个工具调用能力稳定的模型，或临时加 `--no-review` 单轮直出。

### Q4：报错 `未找到风格 Skill "xxx"`
- 运行 `npm run polish -- --list-skills` 检查已发现的 Skill 名称（若使用外部目录，需同时传 `--skills-dir <dir>`）。
- 确认目录结构严格为 `<skillsDir>/<name>/SKILL.md`（区分文件名 `SKILL.md`），且去除 Frontmatter 后正文非空。

### Q5：如何确认某个分块为什么反复被打回？
- 观察 `stderr` 实时输出的每一轮日志：
  - `! 预检[...]` 行显示确定性守卫命中的具体风险；
  - `- 问题：` / `- 建议：` 行显示评审 Agent 给出的具体打回原因与定点修改建议。
- 如果反复打回是因为评审过于严苛或风格 Skill 与保真底线冲突（例如自定义 Skill 要求输出非正文格式），请检查对应 `SKILL.md` 或调低 `--max-attempts` / 调整评审模型。
