import "dotenv/config";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output, stderr } from "node:process";
import {
  parseThinkingLevel,
  resolveModelConfig,
  type ResolvedModelConfig,
} from "./models.js";
import { discoverSkills, loadSkills, type PolishSkill } from "./skills.js";
import {
  DEFAULT_MAX_ATTEMPTS,
  parseMaxAttempts,
  polishText,
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
  maxAttempts: number;
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
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
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
      case "--max-attempts":
        result.maxAttempts = parseMaxAttempts(requireOptionValue(argv, ++i, arg));
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
  console.log(`用法：
  npm run polish -- "需要润色的文本"
  npm run polish -- --skill formal "明天早上9点开个项目会，别迟到啊。"
  npm run polish -- --skill formal,concise --max-attempts 3 --file input.txt --output polished.txt
  npm run polish -- --no-review --skill concise "需要快速单轮直出的文本"
  npm run polish -- --list-skills
  echo "需要润色的文本" | npm run polish -- --skill concise
  npm run polish                          # 进入交互式模式

选项：
  -k, --skill <names>           注入风格 Skill（支持逗号分隔或重复传入，如 formal,concise）
  -s, --style <names>           --skill 的兼容别名（传 default/none 表示不注入 Skill）
      --skills-dir <dir>        指定自定义 Skill 目录（默认读取项目内 skills/）
      --list-skills             列出当前所有可用的风格 Skill
      --no-review               关闭评审 Agent 闭环，退化为单轮流式直出
      --max-attempts <n>        开启评审时的最大润色轮次（默认 ${DEFAULT_MAX_ATTEMPTS}）
      --review-provider <id>    可选：单独指定评审 Agent 的 Pi Provider
      --review-model <id>       可选：单独指定评审 Agent 的模型 ID
      --review-thinking <lvl>   可选：单独指定评审 Agent 的思考强度
  -f, --file <path>             从文件读取待润色文本
  -o, --output <path>           将润色结果写入指定文件
  -p, --provider <id>           指定 Pi Provider（如 openai、anthropic、google、deepseek）
  -m, --model <id>              指定模型 ID（如 gpt-4o-mini、auto/deepseek-v4.1-flash）
  -t, --thinking <level>        思考强度：off | minimal | low | medium | high | xhigh | max
  -h, --help                    显示帮助信息`);
}

function formatSkillBanner(skills: readonly PolishSkill[]): string {
  if (skills.length === 0) {
    return "无（默认自然润色）";
  }
  return skills.map((skill) => skill.name).join(", ");
}

function formatReviewBanner(
  reviewEnabled: boolean,
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

  return `开启（最多 ${maxAttempts} 轮${modelSuffix}）`;
}

function createLoopLogger(maxAttempts: number): (event: PolishLoopEvent) => void {
  return (event) => {
    switch (event.type) {
      case "polish_start":
        stderr.write(`[第 ${event.attempt}/${event.maxAttempts} 轮] 润色中...\n`);
        break;
      case "review_start":
        stderr.write(`[第 ${event.attempt}/${maxAttempts} 轮] 评审中...\n`);
        break;
      case "review_complete": {
        const verdict = event.review.passed ? "通过" : "不通过";
        stderr.write(
          `[第 ${event.attempt}/${maxAttempts} 轮] 评审结论：${verdict} — ${event.review.summary}\n`,
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
          `[打回重做] 进入第 ${event.nextAttempt}/${event.maxAttempts} 轮修订...\n`,
        );
        break;
      default:
        break;
    }
  };
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

  console.log("可用风格 Skill：");
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
  initialReview: boolean,
  initialMaxAttempts: number,
  skillsDir?: string,
): Promise<void> {
  const rl = createInterface({ input, output });
  let activeSkills = [...initialSkills];
  let reviewEnabled = initialReview;
  let maxAttempts = initialMaxAttempts;

  stderr.write(
    `[Pi 润色员 Agent] 模型：${resolved.model.provider}/${resolved.model.id}，思考强度：${resolved.thinkingLevel}，风格 Skill：${formatSkillBanner(activeSkills)}，评审闭环：${formatReviewBanner(reviewEnabled, maxAttempts, reviewerConfig, resolved)}\n`,
  );
  stderr.write(
    "命令：/skills 查看可用 Skill | /skill <name1,name2|off> 切换风格 | /review on|off 开关评审 | /max-attempts <n> 设轮次 | exit 退出\n\n",
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
          stderr.write(`当前风格 Skill：${formatSkillBanner(activeSkills)}\n\n`);
          continue;
        }
        const names = parseSkillListArg(arg);
        try {
          activeSkills = await loadSkills(names, { skillsDir });
          stderr.write(`已切换风格 Skill：${formatSkillBanner(activeSkills)}\n\n`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          stderr.write(`切换失败：${message}\n\n`);
        }
        continue;
      }

      if (lower === "/review" || lower.startsWith("/review ")) {
        const arg = trimmed.slice("/review".length).trim().toLowerCase();
        if (!arg) {
          stderr.write(
            `当前评审闭环：${formatReviewBanner(reviewEnabled, maxAttempts, reviewerConfig, resolved)}\n\n`,
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
          thinkingLevel: resolved.thinkingLevel,
          review: true,
          maxAttempts,
          reviewModels: reviewerConfig.models,
          reviewModel: reviewerConfig.model,
          reviewThinkingLevel: reviewerConfig.thinkingLevel,
          onLoopEvent: createLoopLogger(maxAttempts),
        });
        if (!result.passed) {
          stderr.write(
            `[提示] 已达最大润色轮次（${maxAttempts} 轮），仍未通过评审，以下输出最后一轮修订稿。\n`,
          );
        }
        output.write(`润色> ${result.polishedText}\n\n`);
      } else {
        output.write("润色> ");
        await polishText(trimmed, {
          models: resolved.models,
          model: resolved.model,
          skills: activeSkills,
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
      args.review,
      args.maxAttempts,
      args.skillsDir,
    );
    return;
  }

  stderr.write(
    `[Pi 润色员 Agent] 模型：${resolved.model.provider}/${resolved.model.id}（思考强度：${resolved.thinkingLevel}，风格 Skill：${formatSkillBanner(activeSkills)}，评审闭环：${formatReviewBanner(args.review, args.maxAttempts, reviewerConfig, resolved)}）...\n`,
  );

  let streamed = false;
  const result = await polishText(rawText, {
    models: resolved.models,
    model: resolved.model,
    skills: activeSkills,
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
    stderr.write(
      `[提示] 已达最大润色轮次（${args.maxAttempts} 轮），仍未通过评审，以下输出最后一轮修订稿。\n`,
    );
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
