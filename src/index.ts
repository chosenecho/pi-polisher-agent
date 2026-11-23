import "dotenv/config";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output, stderr } from "node:process";
import { loadGlossaryFile, type GlossaryEntry } from "./glossary.js";
import {
  parseThinkingLevel,
  resolveModelConfig,
  type ResolvedModelConfig,
} from "./models.js";
import { discoverSkills, loadSkills, type PolishSkill } from "./skills.js";
import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_MAX_ATTEMPTS,
  parseChunkSize,
  parseMaxAttempts,
  polishText,
  type ChunkPolishResult,
  type PolishLoopEvent,
} from "./workflow.js";

interface CliArgs {
  text?: string;
  file?: string;
  output?: string;
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
  review: boolean;
  guardrails: boolean;
  maxAttempts: number;
  chunkSize: number;
  glossaryPath?: string;
  reviewProvider?: string;
  reviewModel?: string;
  reviewThinking?: ThinkingLevel;
  skills: string[];
  skillsDir?: string;
  listSkills: boolean;
  help: boolean;
}

const NO_SKILL_ALIASES = new Set(["default", "none", "off", "clear"]);

function parseSkillListArg(raw: string): string[] {
  return raw
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !NO_SKILL_ALIASES.has(item.toLowerCase()));
}

function requireOptionValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`选项 ${flag} 缺少参数值。`);
  }
  return value;
}

function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = {
    review: true,
    guardrails: true,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    chunkSize: DEFAULT_CHUNK_SIZE,
    skills: [],
    listSkills: false,
    help: false,
  };

  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        result.help = true;
        break;
      case "--list-skills":
        result.listSkills = true;
        break;
      case "--no-review":
        result.review = false;
        break;
      case "--no-guardrails":
        result.guardrails = false;
        break;
      case "--max-attempts":
        result.maxAttempts = parseMaxAttempts(requireOptionValue(argv, ++i, arg));
        break;
      case "--chunk-size":
        result.chunkSize = parseChunkSize(requireOptionValue(argv, ++i, arg));
        break;
      case "-g":
      case "--glossary":
        result.glossaryPath = requireOptionValue(argv, ++i, arg);
        break;
      case "--review-provider":
        result.reviewProvider = requireOptionValue(argv, ++i, arg);
        break;
      case "--review-model":
        result.reviewModel = requireOptionValue(argv, ++i, arg);
        break;
      case "--review-thinking":
        result.reviewThinking = parseThinkingLevel(requireOptionValue(argv, ++i, arg));
        break;
      case "-f":
      case "--file":
        result.file = requireOptionValue(argv, ++i, arg);
        break;
      case "-o":
      case "--output":
        result.output = requireOptionValue(argv, ++i, arg);
        break;
      case "-p":
      case "--provider":
        result.provider = requireOptionValue(argv, ++i, arg);
        break;
      case "-m":
      case "--model":
        result.model = requireOptionValue(argv, ++i, arg);
        break;
      case "-t":
      case "--thinking":
        result.thinking = parseThinkingLevel(requireOptionValue(argv, ++i, arg));
        break;
      case "-k":
      case "--skill":
      case "-s":
      case "--style": {
        const rawValue = requireOptionValue(argv, ++i, arg);
        result.skills.push(...parseSkillListArg(rawValue));
        break;
      }
      case "--skills-dir":
        result.skillsDir = requireOptionValue(argv, ++i, arg);
        break;
      default:
        positional.push(arg);
        break;
    }
  }

  if (positional.length > 0) {
    result.text = positional.join(" ");
  }

  return result;
}

function printHelp(): void {
  console.log(`Pi ASR 转录稿书面化润色 Agent（语义保真优先 + 双 AgentLoop 质检闭环）

用法：
  npm run polish -- "嗯就是说，一开始我们以为是网络慢，然后查了半天发现其实是接口超时了。"
  npm run polish -- --file raw_asr.txt --output polished.txt
  npm run polish -- --file raw_asr.txt --glossary glossary.txt --chunk-size 2000 --output polished.txt
  npm run polish -- --skill formal --file meeting_asr.txt --output minutes.txt
  npm run polish -- --no-review "需要快速单轮直出的转录文本"
  npm run polish -- --list-skills
  cat raw_asr.txt | npm run polish > polished.txt
  npm run polish                          # 进入交互式模式

选项：
  -f, --file <path>             从文件读取待润色 ASR 转录稿
  -o, --output <path>           将最终润色结果写入指定文件
  -g, --glossary <path>         加载专有名词 / ASR 误识纠错术语表（.txt / .json）
      --chunk-size <chars>      长文语义分块最大字符数（默认 ${DEFAULT_CHUNK_SIZE}，0 表示关闭分块）
  -k, --skill <names>           可选：叠加附加风格 Skill（如 formal,concise，默认即 ASR 高保真书面化）
  -s, --style <names>           --skill 的兼容别名（传 default/none/off 表示不叠加额外风格）
      --skills-dir <dir>        指定自定义 Skill 目录（默认读取项目内 skills/）
      --list-skills             列出当前所有可用的附加风格 Skill
      --no-review               关闭评审 Agent 闭环，退化为单轮流式直出
      --no-guardrails           关闭评审前的确定性保真预检（默认开启）
      --max-attempts <n>        单块最大润色轮次（默认 ${DEFAULT_MAX_ATTEMPTS}）
      --review-provider <id>    可选：单独指定评审 Agent 的 Pi Provider
      --review-model <id>       可选：单独指定评审 Agent 的模型 ID
      --review-thinking <lvl>   可选：单独指定评审 Agent 的思考强度
  -p, --provider <id>           指定 Pi Provider（如 openai、anthropic、google、deepseek）
  -m, --model <id>              指定模型 ID（如 gpt-4o-mini、auto/deepseek-v4.1-flash）
  -t, --thinking <level>        思考强度：off | minimal | low | medium | high | xhigh | max
  -h, --help                    显示帮助信息`);
}

function formatSkillBanner(skills: readonly PolishSkill[]): string {
  if (skills.length === 0) {
    return "默认（ASR 高保真书面化）";
  }
  return `ASR 高保真 + ${skills.map((skill) => skill.name).join(", ")}`;
}

function formatGlossaryBanner(glossary: readonly GlossaryEntry[]): string {
  if (glossary.length === 0) {
    return "无";
  }
  return `${glossary.length} 条`;
}

function formatChunkBanner(chunkSize: number): string {
  return chunkSize === 0 ? "关闭（整篇单块）" : `${chunkSize} 字/块`;
}

function formatReviewBanner(
  reviewEnabled: boolean,
  guardrailsEnabled: boolean,
  maxAttempts: number,
  reviewerConfig: ResolvedModelConfig,
  polisherConfig: ResolvedModelConfig,
): string {
  if (!reviewEnabled) {
    return "关闭（单轮直出）";
  }
  const sameModel =
    reviewerConfig.model.provider === polisherConfig.model.provider &&
    reviewerConfig.model.id === polisherConfig.model.id &&
    reviewerConfig.thinkingLevel === polisherConfig.thinkingLevel;

  const modelSuffix = sameModel
    ? ""
    : `，评审模型：${reviewerConfig.model.provider}/${reviewerConfig.model.id}（思考强度：${reviewerConfig.thinkingLevel}）`;

  const guardSuffix = guardrailsEnabled ? "，确定性预检：开启" : "，确定性预检：关闭";

  return `开启（最多 ${maxAttempts} 轮${guardSuffix}${modelSuffix}）`;
}

function formatChunkPrefix(chunkIndex?: number, chunkCount?: number): string {
  if (chunkCount && chunkCount > 1 && chunkIndex) {
    return `[分块 ${chunkIndex}/${chunkCount}]`;
  }
  return "";
}

function createLoopLogger(maxAttempts: number): (event: PolishLoopEvent) => void {
  return (event) => {
    const chunkPrefix = formatChunkPrefix(event.chunkIndex, event.chunkCount);
    switch (event.type) {
      case "polish_start":
        stderr.write(`${chunkPrefix}[第 ${event.attempt}/${event.maxAttempts} 轮] 润色中...\n`);
        break;
      case "review_start": {
        const alertCount = event.fidelityChecks?.alerts.length ?? 0;
        const alertNote = alertCount > 0 ? `（预检命中 ${alertCount} 条风险线索，移交评审核实）` : "";
        stderr.write(`${chunkPrefix}[第 ${event.attempt}/${maxAttempts} 轮] 评审中...${alertNote}\n`);
        if (event.fidelityChecks && alertCount > 0) {
          for (const alert of event.fidelityChecks.alerts) {
            stderr.write(`  ! 预检[${alert.code}]：${alert.message}\n`);
          }
        }
        break;
      }
      case "review_complete": {
        const verdict = event.review.passed ? "通过" : "不通过";
        stderr.write(
          `${chunkPrefix}[第 ${event.attempt}/${maxAttempts} 轮] 评审结论：${verdict} — ${event.review.summary}\n`,
        );
        if (!event.review.passed) {
          for (const issue of event.review.issues) {
            stderr.write(`  - 问题：${issue}\n`);
          }
          for (const suggestion of event.review.suggestions) {
            stderr.write(`  - 建议：${suggestion}\n`);
          }
        }
        break;
      }
      case "retry_scheduled":
        stderr.write(
          `${chunkPrefix}[打回重做] 进入第 ${event.nextAttempt}/${event.maxAttempts} 轮定点修订...\n`,
        );
        break;
      default:
        break;
    }
  };
}

function printFailedChunksReport(
  failedChunks: readonly ChunkPolishResult[],
  totalChunks: number,
  maxAttempts: number,
): void {
  if (failedChunks.length === 0) return;

  if (totalChunks === 1) {
    stderr.write(
      `[人工复核提示] 已达最大润色轮次（${maxAttempts} 轮），仍未通过保真评审，以下输出最后一轮修订稿。\n`,
    );
    return;
  }

  stderr.write(
    `\n[人工复核清单] 共 ${totalChunks} 个分块，其中 ${failedChunks.length} 个分块达上限（${maxAttempts} 轮）仍未通过评审，请重点复核：\n`,
  );
  for (const chunk of failedChunks) {
    const snippet = chunk.originalText.replace(/\s+/g, " ").slice(0, 48);
    const summary = chunk.review?.summary ?? "未通过评审";
    stderr.write(`  * 分块 #${chunk.chunkIndex}（原文开头：“${snippet}…”）— ${summary}\n`);
    for (const issue of chunk.review?.issues ?? []) {
      stderr.write(`      - ${issue}\n`);
    }
  }
}

async function resolveReviewerConfig(
  args: CliArgs,
  polisherConfig: ResolvedModelConfig,
): Promise<ResolvedModelConfig> {
  const reviewProvider = args.reviewProvider ?? process.env.REVIEW_PROVIDER;
  const reviewModel = args.reviewModel ?? process.env.REVIEW_MODEL;
  const reviewThinkingRaw = args.reviewThinking ?? process.env.REVIEW_THINKING_LEVEL;
  const reviewThinking = reviewThinkingRaw
    ? parseThinkingLevel(reviewThinkingRaw)
    : polisherConfig.thinkingLevel;

  if (!reviewProvider && !reviewModel) {
    return {
      models: polisherConfig.models,
      model: polisherConfig.model,
      thinkingLevel: reviewThinking,
    };
  }

  return resolveModelConfig({
    provider: reviewProvider,
    modelId: reviewModel,
    thinkingLevel: reviewThinking,
  });
}

async function printAvailableSkills(skillsDir?: string): Promise<void> {
  const skills = await discoverSkills(skillsDir);
  if (skills.length === 0) {
    console.log("未发现可用风格 Skill。");
    return;
  }

  console.log("可用附加风格 Skill（默认不选即执行 ASR 高保真书面化）：");
  for (const skill of skills) {
    const desc = skill.description ? ` - ${skill.description}` : "";
    console.log(`  - ${skill.name}${desc}`);
  }
}

async function readStdinAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function runInteractive(
  resolved: ResolvedModelConfig,
  reviewerConfig: ResolvedModelConfig,
  initialSkills: PolishSkill[],
  initialGlossary: GlossaryEntry[],
  initialReview: boolean,
  initialGuardrails: boolean,
  initialMaxAttempts: number,
  initialChunkSize: number,
  skillsDir?: string,
): Promise<void> {
  const rl = createInterface({ input, output });
  let activeSkills = [...initialSkills];
  let activeGlossary = [...initialGlossary];
  let reviewEnabled = initialReview;
  let guardrailsEnabled = initialGuardrails;
  let maxAttempts = initialMaxAttempts;
  let chunkSize = initialChunkSize;

  stderr.write(
    `[Pi ASR 润色 Agent] 模型：${resolved.model.provider}/${resolved.model.id}，思考强度：${resolved.thinkingLevel}，风格：${formatSkillBanner(activeSkills)}，术语表：${formatGlossaryBanner(activeGlossary)}，分块：${formatChunkBanner(chunkSize)}，评审闭环：${formatReviewBanner(reviewEnabled, guardrailsEnabled, maxAttempts, reviewerConfig, resolved)}\n`,
  );
  stderr.write(
    "命令：/skills | /skill <names|off> | /glossary <path|off> | /chunk-size <n> | /review on|off | /max-attempts <n> | exit\n\n",
  );

  try {
    while (true) {
      const line = await rl.question("原文> ");
      const trimmed = line.trim();
      if (!trimmed) continue;

      const lower = trimmed.toLowerCase();
      if (lower === "exit" || lower === "quit") {
        break;
      }

      if (lower === "/skills") {
        await printAvailableSkills(skillsDir);
        output.write("\n");
        continue;
      }

      if (lower === "/skill" || lower.startsWith("/skill ")) {
        const arg = trimmed.slice("/skill".length).trim();
        if (!arg) {
          stderr.write(`当前风格：${formatSkillBanner(activeSkills)}\n\n`);
          continue;
        }
        const names = parseSkillListArg(arg);
        try {
          activeSkills = await loadSkills(names, { skillsDir });
          stderr.write(`已切换风格：${formatSkillBanner(activeSkills)}\n\n`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          stderr.write(`切换失败：${message}\n\n`);
        }
        continue;
      }

      if (lower === "/glossary" || lower.startsWith("/glossary ")) {
        const arg = trimmed.slice("/glossary".length).trim();
        if (!arg) {
          stderr.write(`当前术语表：${formatGlossaryBanner(activeGlossary)}\n\n`);
          continue;
        }
        if (NO_SKILL_ALIASES.has(arg.toLowerCase())) {
          activeGlossary = [];
          stderr.write("已清空术语表。\n\n");
          continue;
        }
        try {
          activeGlossary = await loadGlossaryFile(arg);
          stderr.write(`已加载术语表（${activeGlossary.length} 条）：${arg}\n\n`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          stderr.write(`加载术语表失败：${message}\n\n`);
        }
        continue;
      }

      if (lower === "/chunk-size" || lower.startsWith("/chunk-size ")) {
        const arg = trimmed.slice("/chunk-size".length).trim();
        if (!arg) {
          stderr.write(`当前分块大小：${formatChunkBanner(chunkSize)}\n\n`);
          continue;
        }
        try {
          chunkSize = parseChunkSize(arg);
          stderr.write(`已设置分块大小：${formatChunkBanner(chunkSize)}\n\n`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          stderr.write(`设置失败：${message}\n\n`);
        }
        continue;
      }

      if (lower === "/review" || lower.startsWith("/review ")) {
        const arg = trimmed.slice("/review".length).trim().toLowerCase();
        if (!arg) {
          stderr.write(
            `当前评审闭环：${formatReviewBanner(reviewEnabled, guardrailsEnabled, maxAttempts, reviewerConfig, resolved)}\n\n`,
          );
          continue;
        }
        if (arg === "on" || arg === "true" || arg === "1") {
          reviewEnabled = true;
          stderr.write(`已开启评审闭环（最多 ${maxAttempts} 轮）。\n\n`);
        } else if (arg === "off" || arg === "false" || arg === "0") {
          reviewEnabled = false;
          stderr.write("已关闭评审闭环（单轮直出）。\n\n");
        } else {
          stderr.write("用法：/review on 或 /review off\n\n");
        }
        continue;
      }

      if (lower === "/max-attempts" || lower.startsWith("/max-attempts ")) {
        const arg = trimmed.slice("/max-attempts".length).trim();
        if (!arg) {
          stderr.write(`当前最大润色轮次：${maxAttempts}\n\n`);
          continue;
        }
        try {
          maxAttempts = parseMaxAttempts(arg);
          stderr.write(`已设置最大润色轮次：${maxAttempts}\n\n`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          stderr.write(`设置失败：${message}\n\n`);
        }
        continue;
      }

      if (reviewEnabled) {
        const result = await polishText(trimmed, {
          models: resolved.models,
          model: resolved.model,
          skills: activeSkills,
          glossary: activeGlossary,
          chunkSize,
          enableGuardrails: guardrailsEnabled,
          thinkingLevel: resolved.thinkingLevel,
          review: true,
          maxAttempts,
          reviewModels: reviewerConfig.models,
          reviewModel: reviewerConfig.model,
          reviewThinkingLevel: reviewerConfig.thinkingLevel,
          onLoopEvent: createLoopLogger(maxAttempts),
        });
        if (!result.passed) {
          printFailedChunksReport(result.failedChunks, result.chunks.length, maxAttempts);
        }
        output.write(`润色> ${result.polishedText}\n\n`);
      } else {
        output.write("润色> ");
        await polishText(trimmed, {
          models: resolved.models,
          model: resolved.model,
          skills: activeSkills,
          glossary: activeGlossary,
          chunkSize,
          thinkingLevel: resolved.thinkingLevel,
          review: false,
          onTextDelta: (delta) => output.write(delta),
        });
        output.write("\n\n");
      }
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (args.listSkills) {
    await printAvailableSkills(args.skillsDir);
    return;
  }

  const activeSkills = await loadSkills(args.skills, { skillsDir: args.skillsDir });
  const activeGlossary = args.glossaryPath ? await loadGlossaryFile(args.glossaryPath) : [];

  const resolved = await resolveModelConfig({
    provider: args.provider,
    modelId: args.model,
    thinkingLevel: args.thinking,
  });

  const reviewerConfig = await resolveReviewerConfig(args, resolved);

  // 判断输入来源：文件 > 命令行参数 > 管道 stdin > 交互模式
  let rawText: string | undefined;
  if (args.file) {
    rawText = await readFile(args.file, "utf-8");
  } else if (args.text) {
    rawText = args.text;
  } else if (!input.isTTY) {
    rawText = await readStdinAll();
  } else {
    await runInteractive(
      resolved,
      reviewerConfig,
      activeSkills,
      activeGlossary,
      args.review,
      args.guardrails,
      args.maxAttempts,
      args.chunkSize,
      args.skillsDir,
    );
    return;
  }

  stderr.write(
    `[Pi ASR 润色 Agent] 模型：${resolved.model.provider}/${resolved.model.id}（思考强度：${resolved.thinkingLevel}，风格：${formatSkillBanner(activeSkills)}，术语表：${formatGlossaryBanner(activeGlossary)}，分块：${formatChunkBanner(args.chunkSize)}，评审闭环：${formatReviewBanner(args.review, args.guardrails, args.maxAttempts, reviewerConfig, resolved)}）...\n`,
  );

  let streamed = false;
  const result = await polishText(rawText, {
    models: resolved.models,
    model: resolved.model,
    skills: activeSkills,
    glossary: activeGlossary,
    chunkSize: args.chunkSize,
    enableGuardrails: args.guardrails,
    thinkingLevel: resolved.thinkingLevel,
    review: args.review,
    maxAttempts: args.maxAttempts,
    reviewModels: reviewerConfig.models,
    reviewModel: reviewerConfig.model,
    reviewThinkingLevel: reviewerConfig.thinkingLevel,
    onLoopEvent: args.review ? createLoopLogger(args.maxAttempts) : undefined,
    onTextDelta: args.review
      ? undefined
      : (delta) => {
          streamed = true;
          output.write(delta);
        },
  });

  if (args.review && !result.passed) {
    printFailedChunksReport(result.failedChunks, result.chunks.length, args.maxAttempts);
  }

  if (streamed) {
    output.write("\n");
  } else {
    output.write(`${result.polishedText}\n`);
  }

  if (args.output) {
    await writeFile(args.output, `${result.polishedText}\n`, "utf-8");
    stderr.write(`[完成] 润色结果已保存至 ${args.output}\n`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`错误：${message}\n`);
  process.exitCode = 1;
});
