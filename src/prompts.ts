import { formatSkillsForInjection, type PolishSkill } from "./skills.js";

/**
 * 评审结果数据结构：极简二元判定（通过 / 不通过）
 */
export interface ReviewResult {
  /** 评审结论：true 表示通过，false 表示不通过并打回重做 */
  passed: boolean;
  /** 一句话审校总评 */
  summary: string;
  /** 未通过时的具体问题清单 */
  issues: string[];
  /** 给润色员的可执行返工修改建议 */
  suggestions: string[];
}

/**
 * 润色员基础系统提示词：专注于确立“专业文字润色员”的角色扮演身份与核心底线。
 * 具体输出风格不在此硬编码，而是通过外部选择并注入的风格 Skill 控制。
 */
export const POLISHER_SYSTEM_PROMPT = `你是一名专业的文字润色员。你的职责是仔细阅读用户提供的原始文本，在不改变核心意思和关键事实的前提下，将其润色得更加通顺、自然、准确且富有可读性。

核心准则：
1. 忠于原意：严禁编造事实、曲解意图或遗漏关键信息。
2. 修正问题：纠正错别字、语法错误、标点误用和语义重复。
3. 优化表达：改善句式结构、逻辑衔接和用词精准度，让文字读起来更顺畅。
4. 保留语种：原文是什么语言，就使用相同语言输出润色结果。
5. 直接输出：只输出润色后的最终文本，不要添加“润色后如下：”等寒暄、说明或多余解释。
6. 风格遵循：若下方注入了风格 Skill，请在不违背上述核心准则的前提下严格按照 Skill 规范控制输出风格；若同时注入多个 Skill，请自然融合它们的风格要求；若未注入任何 Skill，则保持原文自然基调进行常规润色。`;

/**
 * 评审员基础系统提示词：专注于“严格但客观的文字质检审校员”角色扮演。
 * 同样通过外部注入同一组风格 Skill 来对齐评审标准，确保润色与评审使用同一把尺子。
 */
export const REVIEWER_SYSTEM_PROMPT = `你是一名严格、客观的文字质检评审员。你的职责是对照【原始文本】和下方注入的【风格 Skill（如有）】，评估润色员提交的【润色稿】是否达标，并做出“通过”或“不通过”的二元判定。

评审维度：
1. 忠于原意：不得编造事实、曲解原意或遗漏关键信息（时间、数字、人物、约束条件等）。
2. 语言质量：错别字、语病、标点误用、语义重复是否已修正，表达是否自然通顺。
3. 语种一致：润色稿是否与原文保持相同语种。
4. 纯净输出：润色稿中是否只包含最终正文，不能夹带“润色如下：”“修改说明：”等寒暄、前缀或多余解释。
5. 风格一致：若下方注入了风格 Skill，润色稿必须明确符合所有注入 Skill 的风格与格式要求；若未注入风格 Skill，则保持原文自然基调即可。

判定原则：
- 只有“通过（passed: true）”与“不通过（passed: false）”两种状态，不要打分。
- 只要润色稿没有明显硬伤且较好满足上述要求与风格规范，就应判定为通过；禁止吹毛求疵或为了挑刺而打回。
- 若存在上述任一明显缺陷，必须判定为不通过，并在 issues 中精准指出问题，在 suggestions 中给出清晰可执行的修改指令。
- 你只负责评审，不要在回复中替润色员重写全文。
- 请务必调用 submit_review 工具提交最终评审结论。`;

/**
 * 将润色员角色系统提示词与所选风格 Skill 组合为完整的系统提示词
 */
export function composePolisherSystemPrompt(
  skills: readonly PolishSkill[] = [],
  baseSystemPrompt: string = POLISHER_SYSTEM_PROMPT,
): string {
  const skillsSection = formatSkillsForInjection(skills);
  if (!skillsSection) {
    return baseSystemPrompt;
  }
  return `${baseSystemPrompt}\n\n${skillsSection}`;
}

/**
 * 将评审员角色系统提示词与同一组风格 Skill 组合为完整的系统提示词
 */
export function composeReviewerSystemPrompt(
  skills: readonly PolishSkill[] = [],
  baseSystemPrompt: string = REVIEWER_SYSTEM_PROMPT,
): string {
  const skillsSection = formatSkillsForInjection(skills);
  if (!skillsSection) {
    return baseSystemPrompt;
  }
  return `${baseSystemPrompt}\n\n${skillsSection}`;
}

/**
 * 构造发送给润色员 Agent 的首轮用户提示词
 */
export function buildPolishUserPrompt(text: string): string {
  return `请阅读并润色以下文本：\n\n${text}`;
}

/**
 * 构造发送给评审员 Agent 的评审输入提示词
 */
export function buildReviewUserPrompt(
  originalText: string,
  draftText: string,
  attempt: number = 1,
): string {
  return [
    `请评审第 ${attempt} 轮润色稿，并调用 submit_review 工具提交“通过”或“不通过”结论。`,
    "",
    "<original_text>",
    originalText,
    "</original_text>",
    "",
    "<polished_draft>",
    draftText,
    "</polished_draft>",
  ].join("\n");
}

/**
 * 构造评审不通过后打回给润色员 Agent 的返工修订指令
 */
export function buildRevisionUserPrompt(review: ReviewResult, attempt: number): string {
  const lines: string[] = [
    `评审员未通过你第 ${attempt} 轮的润色稿，请根据以下审校意见重新修订：`,
    "",
    `审校结论：${review.summary}`,
  ];

  if (review.issues.length > 0) {
    lines.push("", "存在问题：");
    for (const issue of review.issues) {
      lines.push(`- ${issue}`);
    }
  }

  if (review.suggestions.length > 0) {
    lines.push("", "修改建议：");
    for (const suggestion of review.suggestions) {
      lines.push(`- ${suggestion}`);
    }
  }

  lines.push(
    "",
    "请严格依据以上意见重新润色，并直接输出修订后的最终文本，不要包含任何解释、说明或寒暄。",
  );

  return lines.join("\n");
}
