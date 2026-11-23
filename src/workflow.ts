import {
  Agent,
  type AgentEvent,
  type AgentLoopTurnUpdate,
  type AgentMessage,
  type FinishTurn,
  type PrepareNextTurnContext,
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
import {
  buildPolishUserPrompt,
  buildRevisionUserPrompt,
  composePolisherSystemPrompt,
  POLISHER_SYSTEM_PROMPT,
} from "./prompts.js";
import { reviewPolishDraft, type ReviewResult } from "./reviewer.js";
import { loadSkills, type PolishSkill } from "./skills.js";

export type { ReviewResult } from "./reviewer.js";

export const DEFAULT_MAX_ATTEMPTS = 3;

export interface PolisherAgentOptions {
  models: Models;
  model: Model<Api>;
  /** 显式注入的风格 Skill 对象列表（控制输出风格） */
  skills?: readonly PolishSkill[];
  /** 自定义基础角色系统提示词（默认使用 POLISHER_SYSTEM_PROMPT） */
  systemPrompt?: string;
  thinkingLevel?: ThinkingLevel;
  finishTurn?: FinishTurn;
  prepareNextTurnWithContext?: (
    context: PrepareNextTurnContext,
    signal?: AbortSignal,
  ) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
  onTextDelta?: (delta: string) => void;
  onEvent?: (event: AgentEvent) => void;
}

export interface PolishRound {
  /** 第几轮润色（从 1 开始） */
  attempt: number;
  /** 本轮润色稿正文 */
  draftText: string;
  /** 本轮润色模型的 Token 用量 */
  usage?: Usage;
  /** 本轮评审结论（开启评审时存在） */
  review?: ReviewResult;
  /** 本轮评审模型的 Token 用量 */
  reviewUsage?: Usage;
}

export type PolishLoopEvent =
  | { type: "polish_start"; attempt: number; maxAttempts: number }
  | { type: "polish_complete"; attempt: number; draftText: string }
  | { type: "review_start"; attempt: number }
  | { type: "review_complete"; attempt: number; review: ReviewResult }
  | { type: "retry_scheduled"; nextAttempt: number; maxAttempts: number; review: ReviewResult };

export interface PolishTextOptions extends Omit<
  PolisherAgentOptions,
  "finishTurn" | "prepareNextTurnWithContext"
> {
  /** 按名称从 Skill 目录加载并注入的风格 Skill（如 ["formal", "concise"]） */
  skillNames?: readonly string[];
  /** 自定义 Skill 根目录（配合 skillNames 使用） */
  skillsDir?: string;
  /** 是否启用评审 Agent 质量把关闭环（默认 true） */
  review?: boolean;
  /** 最大润色轮次（初稿 + 打回返工总上限，默认 3） */
  maxAttempts?: number;
  /** 可选：评审 Agent 使用的 Models 注册表（默认复用润色 Agent） */
  reviewModels?: Models;
  /** 可选：评审 Agent 使用的模型（默认复用润色 Agent） */
  reviewModel?: Model<Api>;
  /** 可选：评审 Agent 思考强度（默认复用润色 Agent） */
  reviewThinkingLevel?: ThinkingLevel;
  /** 可选：自定义评审 Agent 基础系统提示词 */
  reviewSystemPrompt?: string;
  /** 可选：监听评审 Agent 原始 Pi 事件 */
  onReviewEvent?: (event: AgentEvent) => void;
  /** 可选：监听双 AgentLoop 的阶段性事件 */
  onLoopEvent?: (event: PolishLoopEvent) => void;
}

export interface PolishResult {
  originalText: string;
  polishedText: string;
  provider: string;
  modelId: string;
  /** 本次实际注入的风格 Skill 名称列表 */
  appliedSkills: string[];
  /** 实际执行的润色轮次 */
  attempts: number;
  /** 本次运行是否启用了评审 Agent */
  reviewEnabled: boolean;
  /** 是否通过评审（未启用评审时为 true） */
  passed: boolean;
  /** 最后一轮评审结论（启用评审时存在） */
  review?: ReviewResult;
  /** 各轮润色与评审完整记录 */
  rounds: PolishRound[];
  usage?: Usage;
  messages: AgentMessage[];
}

/**
 * 校验并解析最大润色轮次
 */
export function parseMaxAttempts(raw: number | string | undefined): number {
  if (raw === undefined || raw === "") {
    return DEFAULT_MAX_ATTEMPTS;
  }
  const value = typeof raw === "number" ? raw : Number(raw.trim());
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`无效的最大轮次 "${raw}"，必须为大于等于 1 的整数。`);
  }
  return value;
}

/**
 * 创建一个具备“润色员”角色系统提示词，并按需注入风格 Skill 与循环钩子的 Pi Agent 实例
 */
export function createPolisherAgent(options: PolisherAgentOptions): Agent {
  const systemPrompt = composePolisherSystemPrompt(
    options.skills ?? [],
    options.systemPrompt ?? POLISHER_SYSTEM_PROMPT,
  );

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: options.model,
      thinkingLevel: options.thinkingLevel ?? "off",
      tools: [],
    },
    streamFn: options.models.streamSimple.bind(options.models),
    finishTurn: options.finishTurn,
    prepareNextTurnWithContext: options.prepareNextTurnWithContext,
  });

  if (options.onTextDelta || options.onEvent) {
    agent.subscribe((event) => {
      options.onEvent?.(event);
      if (
        options.onTextDelta &&
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        options.onTextDelta(event.assistantMessageEvent.delta);
      }
    });
  }

  return agent;
}

/**
 * 文本润色 + 评审闭环 AgentLoop 工作流：
 * 1. 校验输入文本与轮次配置
 * 2. 解析并加载所选风格 Skill，同步注入给润色 Agent 与评审 Agent
 * 3. 在 Pi Agent 原生 Loop 中执行润色，每轮通过 finishTurn 交由评审 Agent 判定“通过 / 不通过”
 * 4. 若不通过且未达最大轮次，通过 prepareNextTurnWithContext 注入评审意见打回重做；通过或达上限后输出最终稿
 */
export async function polishText(
  inputText: string,
  options: PolishTextOptions,
): Promise<PolishResult> {
  const trimmed = inputText.trim();
  if (!trimmed) {
    throw new Error("输入文本不能为空。");
  }

  const reviewEnabled = options.review ?? true;
  const maxAttempts = reviewEnabled ? parseMaxAttempts(options.maxAttempts) : 1;
  const resolvedSkills = await resolveInjectedSkills(options);

  const rounds: PolishRound[] = [];
  let currentAttempt = 0;
  let pendingRevision: { review: ReviewResult; attempt: number } | undefined;
  let loopError: Error | undefined;

  const finishTurn: FinishTurn | undefined = reviewEnabled
    ? async (turn, signal) => {
        if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") {
          return;
        }

        const attempt = currentAttempt || rounds.length + 1;
        const draftText = contentText(turn.message.content).trim();
        if (!draftText) {
          loopError = new Error("模型返回内容为空，未生成润色文本。");
          return { action: "end" };
        }

        options.onLoopEvent?.({ type: "polish_complete", attempt, draftText });

        const round: PolishRound = {
          attempt,
          draftText,
          usage: turn.message.usage,
        };
        rounds.push(round);

        options.onLoopEvent?.({ type: "review_start", attempt });

        try {
          const { review, usage: reviewUsage } = await reviewPolishDraft(trimmed, draftText, {
            models: options.reviewModels ?? options.models,
            model: options.reviewModel ?? options.model,
            skills: resolvedSkills,
            systemPrompt: options.reviewSystemPrompt,
            thinkingLevel: options.reviewThinkingLevel ?? options.thinkingLevel,
            attempt,
            signal,
            onEvent: options.onReviewEvent,
          });

          round.review = review;
          round.reviewUsage = reviewUsage;
          options.onLoopEvent?.({ type: "review_complete", attempt, review });

          if (review.passed || attempt >= maxAttempts) {
            return { action: "end" };
          }

          pendingRevision = { review, attempt };
          options.onLoopEvent?.({
            type: "retry_scheduled",
            nextAttempt: attempt + 1,
            maxAttempts,
            review,
          });
          return { action: "continue" };
        } catch (error) {
          loopError = error instanceof Error ? error : new Error(String(error));
          return { action: "end" };
        }
      }
    : undefined;

  const prepareNextTurnWithContext = reviewEnabled
    ? async (): Promise<AgentLoopTurnUpdate | undefined> => {
        if (!pendingRevision) {
          return undefined;
        }
        const { review, attempt } = pendingRevision;
        pendingRevision = undefined;
        return {
          messages: [
            {
              role: "user",
              content: buildRevisionUserPrompt(review, attempt),
              timestamp: Date.now(),
            },
          ],
        };
      }
    : undefined;

  const agent = createPolisherAgent({
    models: options.models,
    model: options.model,
    skills: resolvedSkills,
    systemPrompt: options.systemPrompt,
    thinkingLevel: options.thinkingLevel,
    finishTurn,
    prepareNextTurnWithContext,
    onTextDelta: options.onTextDelta,
    onEvent: (event) => {
      if (event.type === "turn_start") {
        currentAttempt += 1;
        options.onLoopEvent?.({
          type: "polish_start",
          attempt: currentAttempt,
          maxAttempts,
        });
      }
      options.onEvent?.(event);
    },
  });

  await agent.prompt(buildPolishUserPrompt(trimmed));

  if (loopError) {
    throw loopError;
  }

  const assistantMessage = findLastAssistantMessage(agent.state.messages);
  if (!assistantMessage) {
    throw new Error(agent.state.errorMessage ?? "模型未返回任何响应。");
  }

  if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
    throw new Error(
      assistantMessage.errorMessage ??
        agent.state.errorMessage ??
        `润色任务异常终止 (${assistantMessage.stopReason})`,
    );
  }

  const polishedText = contentText(assistantMessage.content).trim();
  if (!polishedText) {
    throw new Error("模型返回内容为空，未生成润色文本。");
  }

  if (!reviewEnabled) {
    options.onLoopEvent?.({ type: "polish_complete", attempt: 1, draftText: polishedText });
    rounds.push({
      attempt: 1,
      draftText: polishedText,
      usage: assistantMessage.usage,
    });
  }

  const lastRound = rounds[rounds.length - 1];
  const finalReview = lastRound?.review;

  return {
    originalText: trimmed,
    polishedText,
    provider: options.model.provider,
    modelId: options.model.id,
    appliedSkills: resolvedSkills.map((skill) => skill.name),
    attempts: rounds.length,
    reviewEnabled,
    passed: reviewEnabled ? Boolean(finalReview?.passed) : true,
    review: finalReview,
    rounds,
    usage: assistantMessage.usage,
    messages: [...agent.state.messages],
  };
}

async function resolveInjectedSkills(options: PolishTextOptions): Promise<PolishSkill[]> {
  const merged: PolishSkill[] = [];
  const seen = new Set<string>();

  const addSkill = (skill: PolishSkill): void => {
    const key = skill.name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(skill);
  };

  for (const skill of options.skills ?? []) {
    addSkill(skill);
  }

  if (options.skillNames && options.skillNames.length > 0) {
    const loaded = await loadSkills(options.skillNames, { skillsDir: options.skillsDir });
    for (const skill of loaded) {
      addSkill(skill);
    }
  }

  return merged;
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
