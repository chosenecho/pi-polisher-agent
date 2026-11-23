# 附加风格 Skill 使用与开发指南

项目默认已经内置 **ASR 转录稿书面化高保真** 角色作为基础底线（不传 `--skill` 即可直接清理口语杂音、修正 ASR 错字并保真书面化）。

在此基础之上，**风格 Skill** 作为可选的「附加文风叠加层」，以独立 `SKILL.md` 文件组织，用于按场景微调成文语气或特定整理规范，无需修改任何代码即可扩展。

---

## 1. 内置风格 Skill 一览

项目默认内置 4 个风格 Skill，位于 `skills/` 目录：

| Skill 名称 | 文件路径 | 核心定位与适用场景 | 叠加说明 |
| :--- | :--- | :--- | :--- |
| `formal` | `skills/formal/SKILL.md` | **正式商务 / 公文风格**：会议纪要、高管发言整理、对外汇报稿 | 在保真基础上进一步强化书面措辞、克制礼貌与严谨句式 |
| `concise` | `skills/concise/SKILL.md` | **精炼干练风格**：去冗余提炼、高效沟通稿 | 在保留关键事实的前提下更紧凑地压实句式（注意：若极度压缩可能触发压缩比预检，评审会结合 Skill 核查是否遗漏实质信息） |
| `transcript` | `skills/transcript/SKILL.md` | **视频/音频转录文稿书面化强化**：提供额外的口语转书面词替换表与长句示例 | 强化视频口播转文章示例，与默认 ASR 基础角色完全兼容 |
| `vivid` | `skills/vivid/SKILL.md` | **生动文采风格**：播客故事、人物访谈、品牌内容整理 | 增强节奏感与画面质感，但仍须严守事实不虚构 |

查看当前可用 Skill 列表：

```bash
npm run polish -- --list-skills
```

---

## 2. 使用方式与组合叠加

### 2.1 单选与多选叠加

通过 `--skill`（或简写 `-k`，以及兼容别名 `--style` / `-s`）叠加一个或多个 Skill：

```bash
# 默认不传 --skill：即执行 ASR 高保真书面化
npm run polish -- --file raw_asr.txt --output polished.txt

# 叠加单个风格（例如将会议录音转录稿整理为正式商务文风）
npm run polish -- --skill formal --file meeting_asr.txt --output minutes.txt

# 逗号分隔叠加多个风格（支持英文逗号 , 与中文逗号 ，）
npm run polish -- --skill formal,concise --file draft.txt

# 重复传入参数叠加
npm run polish -- -k formal -k concise --file draft.txt
```

**叠加行为说明**：
- **保真底线优先**：基础系统提示词明确规定，所有附加风格 Skill 必须在**不违背语义保真、不篡改原意、不编造事实**的前提下执行。
- **顺序保留 + 自动去重**：按传入顺序注入，同名 Skill（大小写不敏感）只保留首次出现。
- **同步注入双 Agent**：所选 Skill 会同时写入润色 Agent 与评审 Agent 的系统提示词，保证审校标准一致。
- **显式清空**：传入 `default`、`none`、`off` 或 `clear`（不区分大小写）表示不叠加额外风格，回到默认 ASR 高保真书面化。

### 2.2 交互式模式动态切换

进入交互式模式（`npm run polish`）后，可以随时热切换风格、术语表与分块配置：

```text
原文> /skills                # 查看全部可用 Skill
原文> /skill formal          # 叠加 formal 风格
原文> /skill off             # 恢复默认 ASR 高保真书面化
原文> /glossary glossary.txt # 加载专有名词与误识纠错表
原文> /chunk-size 1800       # 调整长文分块大小
```

---

## 3. 编写自定义风格 Skill

### 3.1 目录与文件规范

在项目 `skills/` 目录（或任意通过 `--skills-dir` 指定的自定义目录）下创建子目录，并在其中放置 `SKILL.md`：

```text
skills/
└── <skill-name>/
    └── SKILL.md
```

> 扫描器（`discoverSkills()`）仅识别 `<skillsDir>/<子目录>/SKILL.md` 这一层级；不含 `SKILL.md` 的子目录或散落文件会被自动忽略。

### 3.2 Frontmatter 与正文格式

```markdown
---
name: podcast-article
description: 播客对谈转公众号深度长文风格，保留对话节奏与思考转折
---

# 播客转深度长文风格（Podcast Article）

## 风格目标
将双人或单人播客录音转录稿整理为适合深度阅读的书面长文，保留讲述者的个人思辨温度与真实案例细节。

## 改写细则
1. **温和保留口语温度**：去除“嗯、呃、对吧”等杂音，但保留讲述者恰当的设问与过渡句，不过度公文化。
2. **明确观点推进层次**：按语义自然分段，使每一段承载一个相对完整的论述单元，严禁重排原本的论述顺序。
3. **忠实保留案例与数据**：讲述者举出的具体经历、数据、类比必须完整保留，不得概括成空泛结论。

## 参考示例
- 原文：嗯其实我当时也纠结过，就是到底要不要自己从零写一个调度器，对吧？后来试了两周发现维护成本太高了，干脆直接基于现成的内核做扩展。
- 润色：当时我也曾纠结是否要从零编写一个调度器。但尝试两周后发现维护成本过高，于是决定直接基于现有内核进行扩展。
```

### 3.3 解析规则细节（来自 `src/skills.ts`）

- **YAML Frontmatter**：支持单行 `key: value`（如 `name`、`description`），值外侧成对的单/双引号会被自动剥离；以 `#` 开头的注释行会被忽略。
- **名称兜底**：若 Frontmatter 中未写 `name`，默认使用所在子目录名作为 Skill 名称。
- **非空校验**：去除 Frontmatter 后的正文内容不能为空，否则加载时会抛出错误。
- **编码与换行**：自动处理 UTF-8 BOM 与 Windows CRLF（`\r\n`）换行符。

---

## 4. 使用自定义 Skill 目录或内存 Skill

### 4.1 通过 CLI 指定外部目录

```bash
# 列出外部目录中的 Skill
npm run polish -- --skills-dir ./my-skills --list-skills

# 使用外部目录中的 Skill
npm run polish -- --skills-dir ./my-skills --skill podcast-article --file episode1.txt
```

### 4.2 通过代码注入内存 Skill

```typescript
import { polishText } from "./src/workflow.js";
import type { PolishSkill } from "./src/skills.js";

const courseSkill: PolishSkill = {
  name: "course-notes",
  description: "技术课程录音整理为清晰讲义文本",
  content: "保持讲师原讲解顺序与技术严谨性，将口播演示过渡自然转为书面衔接，保留全部参数、报错现象与推导步骤。",
};

const result = await polishText(rawTranscript, {
  models,
  model,
  skills: [courseSkill],
  glossary,
});
```

---

## 5. 编写高质量 Skill 的建议

1. **与 ASR 保真底线对齐**：所有自定义 Skill 都运行在「意思不漂移」硬约束之上；避免在 Skill 中要求“自由发挥续写”“大幅压缩成要点清单”或“输出 JSON/额外说明”，否则会与评审 Agent 的保真与纯净输出准则冲突（如确有特殊输出格式需求，请同时自定义 `systemPrompt` 与 `reviewSystemPrompt`）。
2. **写清可核验边界**：把风格要求写成具体动作（例如“保留原人称”“禁用感叹号堆砌”），并附 2～3 组 `原文 → 润色` 示例，便于评审 Agent 做出一致的二元判定。
3. **专名纠错交给 Glossary，文风交给 Skill**：行业名词、产品名和同音错字映射建议放在 `--glossary` 术语表中管理，而非硬编码进 `SKILL.md`，方便不同视频/播客按期切换词表。
