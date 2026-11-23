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
  DEFAULT_CHUNK_SIZE,
  extractTailContext,
  parseChunkSize,
  splitTranscriptIntoChunks,
  type TextChunk,
} from "./chunker.js";
import type { GlossaryEntry } from "./glossary.js";
import { runFidelityChecks, type FidelityCheckReport } from "./guardrails.js";
import {
  buildPolishUserPrompt,
  buildRevisionUserPrompt,
  composePolisherSystemPrompt,
  POLISHER_SYSTEM_PROMPT,
} from "./prompts.js";
import { reviewPolishDraft, type ReviewResult } from "./reviewer.js";
import { loadSkills, type PolishSkill } from "./skills.js";

export type { FidelityCheckReport } from "./guardrails.js";
export type { GlossaryEntry } from "./glossary.js";
export type { ReviewResult } from "./prompts.js";
export { DEFAULT_CHUNK_SIZE, parseChunkSize } from "./chunker.js";

export const DEFAULT_MAX_ATTEMPTS = 3;

export interface PolisherAgentOptions {
  models: Models;
  model: Model<Api>;
  /** 显式注入的附加风格 Skill 对象列表 */
  skills?: readonly PolishSkill[];
  /** 专有名词与 ASR 误识纠错术语表 */
  glossary?: readonly GlossaryEntry[];
  /** 自定义基础角色系统提示词（默认使用 ASR 高保真 POLISHER_SYSTEM_PROMPT） */
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
  /** 本轮确定性保真预检报告（开启评审且启用预检时存在） */
  fidelityChecks?: FidelityCheckReport;
  /** 本轮评审结论（开启评审时存在） */
  review?: ReviewResult;
  /** 本轮评审模型的 Token 用量 */
  reviewUsage?: Usage;
}

export interface ChunkPolishResult {
  /** 分块序号（从 1 开始） */
  chunkIndex: number;
  /** 该块原始 ASR 转录文本 */
  originalText: string;
  /** 该块最终润色文本 */
  polishedText: string;
  /** 该块实际执行的润色轮次 */
  attempts: number;
  /** 该块是否通过评审（关闭评审时为 true） */
  passed: boolean;
  /** 该块最后一轮评审结论 */
  review?: ReviewResult;
  /** 该块各轮润色与评审记录 */
  rounds: PolishRound[];
  /** 该块最后一轮润色模型用量 */
  usage?: Usage;
  /** 该块完整对话消息记录 */
  messages: AgentMessage[];
}

export type PolishLoopEvent =
  | {
      type: "polish_start";
      attempt: number;
      maxAttempts: number;
      chunkIndex?: number;
      chunkCount?: number;
    }
  | {
      type: "polish_complete";
      attempt: number;
      draftText: string;
      chunkIndex?: number;
      chunkCount?: number;
    }
  | {
      type: "review_start";
      attempt: number;
      fidelityChecks?: FidelityCheckReport;
      chunkIndex?: number;
      chunkCount?: number;
    }
  | {
      type: "review_complete";
      attempt: number;
      review: ReviewResult;
      chunkIndex?: number;
      chunkCount?: number;
    }
  | {
      type: "retry_scheduled";
      nextAttempt: number;
      maxAttempts: number;
      review: ReviewResult;
      chunkIndex?: number;
      chunkCount?: number;
    };

export interface PolishTextOptions extends Omit<
  PolisherAgentOptions,
  "finishTurn" | "prepareNextTurnWithContext"
> {
  /** 按名称从 Skill 目录加载并注入的附加风格 Skill（如 ["formal", "concise"]） */
  skillNames?: readonly string[];
  /** 自定义 Skill 根目录（配合 skillNames 使用） */
  skillsDir?: string;
  /** 单块最大字符数（默认 2000；传 0 表示关闭分块，整篇单块处理） */
  chunkSize?: number;
  /** 是否在评审前执行确定性保真预检并喂给评审 Agent（默认 true） */
  enableGuardrails?: boolean;
  /** 是否启用评审 Agent 质量把关闭环（默认 true） */
  review?: boolean;
  /** 单块最大润色轮次（初稿 + 打回返工总上限，默认 3） */
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
  /** 本次注入的术语表条数 */
  glossaryCount: number;
  /** 所有分块累计执行的润色总轮次（单块时即该块轮次） */
  attempts: number;
  /** 本次运行是否启用了评审 Agent */
  reviewEnabled: boolean;
  /** 是否全部分块均通过评审（未启用评审时为 true） */
  passed: boolean;
  /** 最后一个分块的最终评审结论（单块时即最终评审结论） */
  review?: ReviewResult;
  /** 各分块完整润色与评审记录 */
  chunks: ChunkPolishResult[];
  /** 未通过评审的分块清单（方便长文人工定点复核） */
  failedChunks: ChunkPolishResult[];
  /** 扁平化的各轮润色与评审记录（单块时等价于 chunks[0].rounds） */
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
 * 创建一个具备“ASR 高保真润色员”角色系统提示词，并按需注入术语表、风格 Skill 与循环钩子的 Pi Agent 实例
 */
export function createPolisherAgent(options: PolisherAgentOptions): Agent {
  const systemPrompt = composePolisherSystemPrompt(
    options.skills ?? [],
    options.systemPrompt ?? POLISHER_SYSTEM_PROMPT,
    options.glossary ?? [],
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
 * ASR 转录稿高保真润色 + 确定性守卫 + 评审闭环 AgentLoop 工作流：
 * 1. 校验输入文本、分块大小与轮次配置，按语义边界将长转录稿切分为独立分块
 * 2. 解析并加载术语表与附加风格 Skill，同步注入给润色 Agent 与评审 Agent
 * 3. 逐块执行 Pi Agent 原生 Loop，传入上一块末尾作为只读滑动衔接上文
 * 4. 每轮润色完成后通过 finishTurn 先执行零成本确定性保真预检，再交由评审 Agent 判定“通过 / 不通过”
 * 5. 不通过且未达轮次上限时，通过 prepareNextTurnWithContext 回锚原文并注入定点修订指令打回重做
 * 6. 汇总拼接全部块并输出未通过分块清单，便于长稿人工定点复核
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
  const enableGuardrails = options.enableGuardrails ?? true;
  const maxAttempts = reviewEnabled ? parseMaxAttempts(options.maxAttempts) : 1;
  const chunkSize = parseChunkSize(options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const resolvedSkills = await resolveInjectedSkills(options);
  const glossary = options.glossary ?? [];

  const textChunks = splitTranscriptIntoChunks(trimmed, { maxChunkChars: chunkSize });
  const chunkResults: ChunkPolishResult[] = [];
  let previousContext = "";

  for (let i = 0; i < textChunks.length; i++) {
    const chunk = textChunks[i];

    // 关闭评审时的多块流式输出，在块之间补发段落分隔符
    if (!reviewEnabled && i > 0 && options.onTextDelta) {
      options.onTextDelta("\n\n");
    }

    const chunkResult = await polishSingleChunk(chunk, {
      options,
      resolvedSkills,
      glossary,
      previousContext: i > 0 ? previousContext : undefined,
      reviewEnabled,
      enableGuardrails,
      maxAttempts,
    });

    chunkResults.push(chunkResult);
    previousContext = extractTailContext(chunkResult.polishedText);
  }

  const polishedText = chunkResults.map((chunk) => chunk.polishedText).join("\n\n");
  const allRounds = chunkResults.flatMap((chunk) => chunk.rounds);
  const failedChunks = chunkResults.filter((chunk) => !chunk.passed);
  const lastChunk = chunkResults[chunkResults.length - 1];

  return {
    originalText: trimmed,
    polishedText,
    provider: options.model.provider,
    modelId: options.model.id,
    appliedSkills: resolvedSkills.map((skill) => skill.name),
    glossaryCount: glossary.length,
    attempts: allRounds.length,
    reviewEnabled,
    passed: reviewEnabled ? failedChunks.length === 0 : true,
    review: lastChunk?.review,
    chunks: chunkResults,
    failedChunks,
    rounds: allRounds,
    usage: lastChunk?.usage,
    messages: chunkResults.flatMap((chunk) => chunk.messages),
  };
}

interface SingleChunkExecutionParams {
  options: PolishTextOptions;
  resolvedSkills: readonly PolishSkill[];
  glossary: readonly GlossaryEntry[];
  previousContext?: string;
  reviewEnabled: boolean;
  enableGuardrails: boolean;
  maxAttempts: number;
}

async function polishSingleChunk(
  chunk: TextChunk,
  params: SingleChunkExecutionParams,
): Promise<ChunkPolishResult> {
  const {
    options,
    resolvedSkills,
    glossary,
    previousContext,
    reviewEnabled,
    enableGuardrails,
    maxAttempts,
  } = params;

  const chunkMeta = { chunkIndex: chunk.index, chunkCount: chunk.total };
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

        options.onLoopEvent?.({
          type: "polish_complete",
          attempt,
          draftText,
          ...chunkMeta,
        });

        const fidelityChecks = enableGuardrails
          ? runFidelityChecks(chunk.text, draftText, { previousContext, glossary })
          : undefined;

        const round: PolishRound = {
          attempt,
          draftText,
          usage: turn.message.usage,
          fidelityChecks,
        };
        rounds.push(round);

        options.onLoopEvent?.({
          type: "review_start",
          attempt,
          fidelityChecks,
          ...chunkMeta,
        });

        try {
          const { review, usage: reviewUsage } = await reviewPolishDraft(chunk.text, draftText, {
            models: options.reviewModels ?? options.models,
            model: options.reviewModel ?? options.model,
            skills: resolvedSkills,
            glossary,
            previousContext,
            fidelityChecks,
            chunkIndex: chunk.index,
            chunkCount: chunk.total,
            systemPrompt: options.reviewSystemPrompt,
            thinkingLevel: options.reviewThinkingLevel ?? options.thinkingLevel,
            attempt,
            signal,
            onEvent: options.onReviewEvent,
          });

          round.review = review;
          round.reviewUsage = reviewUsage;
          options.onLoopEvent?.({
            type: "review_complete",
            attempt,
            review,
            ...chunkMeta,
          });

          if (review.passed || attempt >= maxAttempts) {
            return { action: "end" };
          }

          pendingRevision = { review, attempt };
          options.onLoopEvent?.({
            type: "retry_scheduled",
            nextAttempt: attempt + 1,
            maxAttempts,
            review,
            ...chunkMeta,
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
              content: buildRevisionUserPrompt(review, attempt, chunk.text),
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
    glossary,
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
          ...chunkMeta,
        });
      }
      options.onEvent?.(event);
    },
  });

  await agent.prompt(
    buildPolishUserPrompt(chunk.text, {
      previousContext,
      chunkIndex: chunk.index,
      chunkCount: chunk.total,
    }),
  );

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
    options.onLoopEvent?.({
      type: "polish_complete",
      attempt: 1,
      draftText: polishedText,
      ...chunkMeta,
    });
    rounds.push({
      attempt: 1,
      draftText: polishedText,
      usage: assistantMessage.usage,
    });
  }

  const lastRound = rounds[rounds.length - 1];
  const finalReview = lastRound?.review;

  return {
    chunkIndex: chunk.index,
    originalText: chunk.text,
    polishedText,
    attempts: rounds.length,
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
