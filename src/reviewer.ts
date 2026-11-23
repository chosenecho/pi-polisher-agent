import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
  contentText,
  type Api,
  type AssistantMessage,
  type Model,
  type Models,
  type Usage,
} from "@earendil-works/pi-ai";
import type { GlossaryEntry } from "./glossary.js";
import type { FidelityCheckReport } from "./guardrails.js";
import {
  buildReviewUserPrompt,
  composeReviewerSystemPrompt,
  REVIEWER_SYSTEM_PROMPT,
  type ReviewResult,
} from "./prompts.js";
import type { PolishSkill } from "./skills.js";

export type { ReviewResult } from "./prompts.js";

export const SUBMIT_REVIEW_TOOL_NAME = "submit_review";

export interface ReviewPolishOptions {
  models: Models;
  model: Model<Api>;
  /** 与润色 Agent 保持一致的风格 Skill 列表 */
  skills?: readonly PolishSkill[];
  /** 与润色 Agent 保持一致的专有名词术语表 */
  glossary?: readonly GlossaryEntry[];
  /** 上一块只读衔接上文（供评审检测是否重复泄漏上文） */
  previousContext?: string;
  /** 程序自动预检生成的风险线索报告 */
  fidelityChecks?: FidelityCheckReport;
  /** 当前分块序号（从 1 开始） */
  chunkIndex?: number;
  /** 总分块数 */
  chunkCount?: number;
  /** 自定义评审员角色基础系统提示词 */
  systemPrompt?: string;
  thinkingLevel?: ThinkingLevel;
  /** 当前是第几轮润色稿（从 1 开始） */
  attempt?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export interface ReviewPolishOutput {
  review: ReviewResult;
  usage?: Usage;
  messages: AgentMessage[];
}

interface RawReviewPayload {
  passed?: unknown;
  summary?: unknown;
  issues?: unknown;
  suggestions?: unknown;
}

const SUBMIT_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    passed: {
      type: "boolean",
      description: "评审是否通过：true 表示通过，false 表示不通过并打回重做",
    },
    summary: {
      type: "string",
      description: "一句话审校结论",
    },
    issues: {
      type: "array",
      items: { type: "string" },
      description: "未通过时的具体问题清单；通过时可传空数组",
    },
    suggestions: {
      type: "array",
      items: { type: "string" },
      description: "给润色员的可执行定点修改建议；通过时可传空数组",
    },
  },
  required: ["passed", "summary"],
  additionalProperties: false,
} as const;

function sanitizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * 将工具参数或 JSON 兜底解析结果规范化为 ReviewResult
 */
export function normalizeReviewResult(raw: RawReviewPayload): ReviewResult {
  if (typeof raw.passed !== "boolean") {
    throw new Error("评审结果缺少有效的布尔字段 passed。");
  }

  const passed = raw.passed;
  const rawSummary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  const summary = rawSummary || (passed ? "润色质量达标，评审通过。" : "润色质量未达标，需打回修订。");

  const issues = passed ? [] : sanitizeStringList(raw.issues);
  const suggestions = passed ? [] : sanitizeStringList(raw.suggestions);

  if (!passed && issues.length === 0 && suggestions.length === 0) {
    issues.push(summary);
  }

  return {
    passed,
    summary,
    issues,
    suggestions,
  };
}

/**
 * 兜底解析：当模型未调用 submit_review 工具而直接返回 JSON 文本时提取评审结论
 */
export function parseReviewFromText(rawText: string): ReviewResult {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error("评审 Agent 未调用 submit_review 工具，且返回内容为空。");
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : extractFirstJsonObject(trimmed);

  if (!candidate) {
    throw new Error(`评审 Agent 未调用 submit_review 工具，且输出无法解析为 JSON：${trimmed.slice(0, 160)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`评审 Agent 返回的 JSON 无法解析：${reason}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("评审 Agent 返回的 JSON 必须是对象结构。");
  }

  return normalizeReviewResult(parsed as RawReviewPayload);
}

function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }
  return text.slice(start, end + 1);
}

/**
 * 构造 submit_review Pi AgentTool；调用完成后通过 terminate: true 立即结束评审 Loop，
 * 避免模型再发起多余的文字回复轮次。
 */
export function createSubmitReviewTool(
  onSubmit: (review: ReviewResult) => void,
): AgentTool<typeof SUBMIT_REVIEW_SCHEMA, ReviewResult> {
  return {
    name: SUBMIT_REVIEW_TOOL_NAME,
    label: "提交评审结论",
    description: "提交对当前润色稿的二元评审结论（通过或不通过）及定点返工意见。",
    parameters: SUBMIT_REVIEW_SCHEMA,
    async execute(_toolCallId, params) {
      const normalized = normalizeReviewResult(params as RawReviewPayload);
      onSubmit(normalized);
      return {
        content: [
          {
            type: "text",
            text: normalized.passed
              ? `评审已提交：通过（${normalized.summary}）`
              : `评审已提交：不通过（${normalized.summary}）`,
          },
        ],
        details: normalized,
        terminate: true,
      };
    },
  };
}

/**
 * 调用独立的评审 Agent，对照原文、润色稿、确定性预检线索、术语表与风格 Skill 做出“通过 / 不通过”判定
 */
export async function reviewPolishDraft(
  originalText: string,
  draftText: string,
  options: ReviewPolishOptions,
): Promise<ReviewPolishOutput> {
  let submittedReview: ReviewResult | undefined;

  const submitReviewTool = createSubmitReviewTool((review) => {
    submittedReview = review;
  });

  const systemPrompt = composeReviewerSystemPrompt(
    options.skills ?? [],
    options.systemPrompt ?? REVIEWER_SYSTEM_PROMPT,
    options.glossary ?? [],
  );

  const reviewerAgent = new Agent({
    initialState: {
      systemPrompt,
      model: options.model,
      thinkingLevel: options.thinkingLevel ?? "off",
      tools: [submitReviewTool],
    },
    streamFn: options.models.streamSimple.bind(options.models),
  });

  if (options.onEvent) {
    reviewerAgent.subscribe((event) => {
      options.onEvent?.(event);
    });
  }

  const onAbort = () => reviewerAgent.abort();
  if (options.signal) {
    if (options.signal.aborted) {
      throw new Error("评审任务已取消。");
    }
    options.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    await reviewerAgent.prompt(
      buildReviewUserPrompt(originalText, draftText, options.attempt ?? 1, {
        previousContext: options.previousContext,
        fidelityChecks: options.fidelityChecks,
        chunkIndex: options.chunkIndex,
        chunkCount: options.chunkCount,
      }),
    );
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }

  const lastAssistant = findLastAssistantMessage(reviewerAgent.state.messages);
  if (!lastAssistant) {
    throw new Error(reviewerAgent.state.errorMessage ?? "评审 Agent 未返回任何响应。");
  }

  if (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted") {
    throw new Error(
      lastAssistant.errorMessage ??
        reviewerAgent.state.errorMessage ??
        `评审任务异常终止 (${lastAssistant.stopReason})`,
    );
  }

  const review = submittedReview ?? parseReviewFromText(contentText(lastAssistant.content));

  return {
    review,
    usage: lastAssistant.usage,
    messages: [...reviewerAgent.state.messages],
  };
}

function findLastAssistantMessage(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      return msg;
    }
  }
  return undefined;
}
