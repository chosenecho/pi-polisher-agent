import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Api,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

export const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export interface ModelConfigOptions {
  provider?: string;
  modelId?: string;
  customBaseUrl?: string;
  customApiKey?: string;
  customModelId?: string;
  customContextWindow?: number | string;
  customMaxTokens?: number | string;
  customReasoning?: boolean;
  thinkingLevel?: ThinkingLevel;
}

export interface ResolvedModelConfig {
  models: Models;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
}

interface ProviderPreference {
  providerId: string;
  preferredModels: string[];
}

const DEFAULT_PROVIDER_PREFERENCES: ProviderPreference[] = [
  { providerId: "openai", preferredModels: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-5-mini"] },
  { providerId: "anthropic", preferredModels: ["claude-sonnet-4-6", "claude-sonnet-4-5", "claude-haiku-4-5"] },
  { providerId: "google", preferredModels: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"] },
  { providerId: "deepseek", preferredModels: ["deepseek-chat", "deepseek-reasoner"] },
  { providerId: "openrouter", preferredModels: ["openrouter/auto", "openai/gpt-4o-mini"] },
  { providerId: "moonshot-ai", preferredModels: ["kimi-k2-0905-preview", "moonshot-v1-8k"] },
  { providerId: "minimax", preferredModels: ["MiniMax-M1", "MiniMax-Text-01"] },
];

/**
 * 解析 Token 数量，支持纯数字（如 65536、1048576）或带 k/m 后缀（如 64k、1m）
 */
export function parseTokenCount(
  raw: number | string | undefined,
  fallback: number,
  label: string,
): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }

  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) {
      throw new Error(`无效的 ${label} 值 "${raw}"，必须为正整数。`);
    }
    return Math.floor(raw);
  }

  const trimmed = raw.trim().toLowerCase().replaceAll("_", "").replaceAll(",", "");
  const match = trimmed.match(/^(\d+(?:\.\d+)?)([km])?$/);
  if (!match) {
    throw new Error(`无效的 ${label} 值 "${raw}"，示例：65536、64k、1048576、1m。`);
  }

  const base = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === "m" ? 1024 * 1024 : unit === "k" ? 1024 : 1;
  const result = Math.floor(base * multiplier);

  if (!Number.isFinite(result) || result <= 0) {
    throw new Error(`无效的 ${label} 值 "${raw}"，必须大于 0。`);
  }
  return result;
}

/**
 * 校验并解析思考强度级别
 */
export function parseThinkingLevel(
  raw: string | undefined,
  fallback: ThinkingLevel = "off",
): ThinkingLevel {
  if (!raw || !raw.trim()) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase() as ThinkingLevel;
  if (!VALID_THINKING_LEVELS.includes(normalized)) {
    throw new Error(
      `无效的思考强度 "${raw}"，可选值：${VALID_THINKING_LEVELS.join(", ")}`,
    );
  }
  return normalized;
}

function parseOptionalBoolean(raw: string | undefined): boolean | undefined {
  if (!raw || !raw.trim()) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`无效的布尔值 "${raw}"，请使用 true 或 false。`);
}

/**
 * 创建自定义 OpenAI 兼容 Provider（支持本地路由端点、DashScope、Ollama、vLLM、OneAPI 等）
 */
export function createCustomOpenAIConfig(options: {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  providerId?: string;
  contextWindow?: number | string;
  maxTokens?: number | string;
  reasoning?: boolean;
  thinkingLevel?: ThinkingLevel;
}): ResolvedModelConfig {
  const providerId = options.providerId ?? "custom-openai";
  const thinkingLevel = options.thinkingLevel ?? "off";
  const contextWindow = parseTokenCount(options.contextWindow, 128000, "contextWindow");
  const maxTokens = parseTokenCount(options.maxTokens, 8192, "maxTokens");
  const reasoning = options.reasoning ?? thinkingLevel !== "off";

  const model: Model<"openai-completions"> = {
    id: options.modelId,
    name: `${options.modelId} (Custom OpenAI-Compatible)`,
    api: "openai-completions",
    provider: providerId,
    baseUrl: options.baseUrl,
    reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };

  const provider = createProvider({
    id: providerId,
    name: "Custom OpenAI-Compatible",
    baseUrl: options.baseUrl,
    auth: {
      apiKey: options.apiKey
        ? {
            name: "Custom API Key",
            resolve: async () => ({ auth: { apiKey: options.apiKey } }),
          }
        : envApiKeyAuth("Custom API Key", ["CUSTOM_API_KEY", "OPENAI_API_KEY"]),
    },
    models: [model],
    api: openAICompletionsApi(),
  });

  const models = createModels();
  models.setProvider(provider);

  return { models, model, thinkingLevel };
}

/**
 * 根据显式参数或环境变量自动解析 Pi Models、目标模型与思考强度
 */
export async function resolveModelConfig(
  options: ModelConfigOptions = {},
): Promise<ResolvedModelConfig> {
  const thinkingLevel = parseThinkingLevel(
    options.thinkingLevel ?? process.env.PI_THINKING_LEVEL ?? process.env.CUSTOM_THINKING_LEVEL,
    "off",
  );

  const customBaseUrl = options.customBaseUrl ?? process.env.CUSTOM_BASE_URL;
  const customApiKey = options.customApiKey ?? process.env.CUSTOM_API_KEY;
  const customModelId =
    options.customModelId ?? options.modelId ?? process.env.CUSTOM_MODEL ?? process.env.PI_MODEL;

  // 若配置了自定义 OpenAI 兼容端点且未显式指定其他内置 Provider，优先使用自定义端点
  if (customBaseUrl && !options.provider && !process.env.PI_PROVIDER) {
    if (!customModelId) {
      throw new Error(
        "已设置 CUSTOM_BASE_URL，但缺少模型名称。请设置 CUSTOM_MODEL（或通过 --model 指定）。",
      );
    }
    return createCustomOpenAIConfig({
      baseUrl: customBaseUrl,
      modelId: customModelId,
      apiKey: customApiKey,
      contextWindow: options.customContextWindow ?? process.env.CUSTOM_CONTEXT_WINDOW,
      maxTokens: options.customMaxTokens ?? process.env.CUSTOM_MAX_TOKENS,
      reasoning: options.customReasoning ?? parseOptionalBoolean(process.env.CUSTOM_REASONING),
      thinkingLevel,
    });
  }

  const models = builtinModels();
  const requestedProvider = options.provider ?? process.env.PI_PROVIDER;
  const requestedModelId = options.modelId ?? process.env.PI_MODEL;

  if (requestedProvider) {
    const providerModels = models.getModels(requestedProvider);
    if (providerModels.length === 0) {
      throw new Error(
        `未找到 Provider "${requestedProvider}" 或该 Provider 下无可用聊天模型。`,
      );
    }

    const model = requestedModelId
      ? models.getModel(requestedProvider, requestedModelId)
      : pickPreferredModel(models, requestedProvider);

    if (!model) {
      const sampleIds = providerModels
        .slice(0, 8)
        .map((m) => m.id)
        .join(", ");
      throw new Error(
        `在 Provider "${requestedProvider}" 下未找到模型 "${requestedModelId}"。可用示例：${sampleIds}`,
      );
    }

    return { models, model, thinkingLevel };
  }

  // 自动检测环境变量中已配置鉴权的内置 Provider
  for (const pref of DEFAULT_PROVIDER_PREFERENCES) {
    const check = await models.checkAuth(pref.providerId);
    if (!check) continue;

    const model = requestedModelId
      ? models.getModel(pref.providerId, requestedModelId)
      : pickPreferredModel(models, pref.providerId, pref.preferredModels);

    if (model) {
      return { models, model, thinkingLevel };
    }
  }

  // 兜底：检查其他所有已配置的内置 Provider
  const available = await models.getAvailable();
  if (available.length > 0) {
    const model = requestedModelId
      ? available.find((m) => m.id === requestedModelId)
      : available[0];
    if (model) {
      return { models, model, thinkingLevel };
    }
  }

  throw new Error(
    [
      "未检测到可用的模型鉴权配置。",
      "请复制 .env.example 为 .env，并配置以下任意一种方式：",
      "  1. 内置 Provider：OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY / DEEPSEEK_API_KEY / OPENROUTER_API_KEY",
      "  2. 自定义 OpenAI 兼容接口：CUSTOM_BASE_URL + CUSTOM_API_KEY + CUSTOM_MODEL",
    ].join("\n"),
  );
}

function pickPreferredModel(
  models: Models,
  providerId: string,
  preferredIds?: string[],
): Model<Api> | undefined {
  const candidates =
    preferredIds ??
    DEFAULT_PROVIDER_PREFERENCES.find((p) => p.providerId === providerId)?.preferredModels ??
    [];

  for (const id of candidates) {
    const found = models.getModel(providerId, id);
    if (found) return found;
  }

  return models.getModels(providerId)[0];
}
