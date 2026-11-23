import { formatGlossaryForInjection, type GlossaryEntry } from "./glossary.js";
import { formatFidelityChecksForReview, type FidelityCheckReport } from "./guardrails.js";
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

export interface PolishUserPromptOptions {
  /** 上一块润色稿末尾的只读衔接上文 */
  previousContext?: string;
  /** 当前分块序号（从 1 开始） */
  chunkIndex?: number;
  /** 总分块数 */
  chunkCount?: number;
}

export interface ReviewUserPromptOptions {
  /** 上一块润色稿末尾的只读衔接上文 */
  previousContext?: string;
  /** 确定性保真预检报告（高风险线索） */
  fidelityChecks?: FidelityCheckReport;
  /** 当前分块序号（从 1 开始） */
  chunkIndex?: number;
  /** 总分块数 */
  chunkCount?: number;
}

/**
 * 润色员基础系统提示词：专注于“ASR 语音转录稿书面化 + 意思不漂移”高保真润色角色。
 * 额外写作风格通过外部注入的风格 Skill 控制，专名纠错通过术语表控制。
 */
export const POLISHER_SYSTEM_PROMPT = `你是一名专注于 ASR（语音识别）转录稿书面化润色的专业文字编辑。你的核心职责是将口语化、含杂音或断句混乱的语音转录文本，整理为干净、通顺、自然易读的书面文本，同时死守“意思不漂移”的第一底线。

核心准则（按优先级从高到低）：
1. 语义与逻辑保真（最高优先级）：严格保留原文的讲述顺序、推演链条（因果、转折、递进、条件、对比、举例、否定关系）以及语气强弱与限定边界（如“可能”“大约”“部分”“不一定”“目前”）。严禁篡改立场、改强或改弱断言程度、翻转否定逻辑或擅自重排论点顺序。
2. 反摘要、反幻觉：严禁做摘要式删减，必须保留原文中的具体案例、数据、时间、人物、前提条件与有效论据；严禁编造或脑补原文未提及的背景、观点、数据或总结。
3. 清理口语杂音与 ASR 瑕疵：删除无实义填充词、语气词和口头禅（如“嗯”“呃”“那个”“就是说”“对吧”“怎么说呢”）；合并结巴、无意义重复和口误自我纠错（如“上周三，不对，是上周四”直接整理为“上周四”），保留讲述人最终确认的正确表述；结合上下文修正明显的 ASR 同音错别字与错误断词。
4. 口语彻底书面化：将随口俗语与松散的“然后……然后……就是……”流水长句转化为规范、清晰、有条理的书面文本，补全准确标点并按语义合理分段，保留原讲述人的人称视角，避免生硬官腔或华丽辞藻堆砌。
5. 纯净输出与分块边界：与原文保持相同语种；只输出当前待润色片段的最终正文，严禁附带“润色如下：”“修改说明：”等寒暄、前缀或解释。若提供了 <previous_context>，仅供承接语气、代词与术语，严禁重复输出其中的任何内容。
6. 术语与附加风格遵循：若下方注入了术语表，请严格统一专有名词写法；若下方注入了风格 Skill，请在不违背上述语义保真底线的前提下融合执行其风格要求。`;

/**
 * 评审员基础系统提示词：专注于“意思不漂移优先”的 ASR 润色质检审校员。
 * 同样同步注入术语表与风格 Skill，确保润色与审校使用同一把尺子。
 */
export const REVIEWER_SYSTEM_PROMPT = `你是一名严格、客观的 ASR 转录稿书面化质检评审员。你的核心职责是对照【原始转录稿】、【术语表（如有）】和【风格 Skill（如有）】，审核润色员提交的【润色稿】，并做出“通过”或“不通过”的二元判定。

核心原则：**意思不漂移是一票否决项**。宁可文风平实，也绝不允许流畅但偏离原意的改写通过。

评审维度（按优先级）：
1. 语义与逻辑保真（一票否决）：因果、转折、条件、否定关系及程度限定词（“可能/部分/几乎/一定/不一定”等）是否被改强、改弱或翻转？讲述人立场与原始论述顺序是否被打乱？
2. 信息完整与反幻觉（一票否决）：是否发生了摘要式删减（丢失具体例子、数字、时间、前提或限定条件）？是否脑补编造了原文未提及的新事实、新观点或总结？
3. ASR 纠错与术语一致：口误自我纠错是否准确保留最终表述？同音错别字修正是否贴合上下文并遵守下方注入的术语表（如有），没有把原本正确的词改错？
4. 书面化与表达质量：口语杂音、填充词、结巴重复是否已清理干净？流水长句是否理顺、标点准确、表达自然通顺且无明显错别字或语病？
5. 纯净输出、边界与风格一致：语种是否与原文一致？是否只输出当前片段最终正文（未重复输出 <previous_context>，未夹带“润色如下：”等非正文说明）？若注入了风格 Skill，是否在保真前提下符合其规范？

判定原则：
- 只有“通过（passed: true）”与“不通过（passed: false）”两种状态，不要打分。
- 若输入中包含 <automated_checks> 自动预检告警，必须逐项对照原文核实：属合理书面化或口误自我纠错的可放行；确属遗漏、篡改、上文泄漏、术语未修或寒暄前缀的必须判不通过。
- 只要不存在语义漂移、信息丢失/脑补及其他明显硬伤，且书面化流畅自然，就应判定为通过；禁止吹毛求疵或为了挑刺而打回。
- 判定不通过时，必须在 issues 中精准指出偏移/漏改/错改位置，在 suggestions 中给出清晰可执行的定点修改指令；不要在回复中替润色员重写全文。
- 请务必调用 submit_review 工具提交最终评审结论。`;

/**
 * 将润色员角色系统提示词、术语表与所选风格 Skill 组合为完整的系统提示词
 */
export function composePolisherSystemPrompt(
  skills: readonly PolishSkill[] = [],
  baseSystemPrompt: string = POLISHER_SYSTEM_PROMPT,
  glossary: readonly GlossaryEntry[] = [],
): string {
  const sections: string[] = [baseSystemPrompt];
  const glossarySection = formatGlossaryForInjection(glossary);
  if (glossarySection) {
    sections.push(glossarySection);
  }
  const skillsSection = formatSkillsForInjection(skills);
  if (skillsSection) {
    sections.push(skillsSection);
  }
  return sections.join("\n\n");
}

/**
 * 将评审员角色系统提示词、术语表与同一组风格 Skill 组合为完整的系统提示词
 */
export function composeReviewerSystemPrompt(
  skills: readonly PolishSkill[] = [],
  baseSystemPrompt: string = REVIEWER_SYSTEM_PROMPT,
  glossary: readonly GlossaryEntry[] = [],
): string {
  const sections: string[] = [baseSystemPrompt];
  const glossarySection = formatGlossaryForInjection(glossary);
  if (glossarySection) {
    sections.push(glossarySection);
  }
  const skillsSection = formatSkillsForInjection(skills);
  if (skillsSection) {
    sections.push(skillsSection);
  }
  return sections.join("\n\n");
}

/**
 * 构造发送给润色员 Agent 的首轮用户提示词（支持分块进度与只读滑动上文）
 */
export function buildPolishUserPrompt(
  text: string,
  options: PolishUserPromptOptions = {},
): string {
  const { previousContext, chunkIndex, chunkCount } = options;
  const hasMultipleChunks = chunkCount !== undefined && chunkCount > 1 && chunkIndex !== undefined;

  if (!previousContext && !hasMultipleChunks) {
    return `请将以下 ASR 转录文本润色为自然通顺、意思不漂移的书面文本：\n\n${text}`;
  }

  const lines: string[] = [];
  if (hasMultipleChunks) {
    lines.push(
      `请处理完整文稿的第 ${chunkIndex}/${chunkCount} 段 ASR 转录文本，将其润色为自然通顺、意思不漂移的书面文本。`,
    );
  } else {
    lines.push("请将以下 ASR 转录文本润色为自然通顺、意思不漂移的书面文本。");
  }

  if (previousContext) {
    lines.push(
      "",
      "<previous_context>",
      previousContext,
      "</previous_context>",
      "注意：上方 <previous_context> 仅为上一段润色稿末尾，仅供承接代词、语气与术语使用，严禁重复输出其中任何内容。",
    );
  }

  lines.push(
    "",
    "<current_transcript>",
    text,
    "</current_transcript>",
    "",
    "请仅输出 <current_transcript> 润色后的最终正文，不要附带任何标签、说明或寒暄。",
  );

  return lines.join("\n");
}

/**
 * 构造发送给评审员 Agent 的评审输入提示词（含可选上文边界与确定性预检线索）
 */
export function buildReviewUserPrompt(
  originalText: string,
  draftText: string,
  attempt: number = 1,
  options: ReviewUserPromptOptions = {},
): string {
  const chunkTag =
    options.chunkCount && options.chunkCount > 1 && options.chunkIndex
      ? `（第 ${options.chunkIndex}/${options.chunkCount} 块）`
      : "";

  const lines: string[] = [
    `请评审${chunkTag}第 ${attempt} 轮润色稿，重点把关语义是否漂移、信息是否完整、书面化是否自然，并调用 submit_review 工具提交“通过”或“不通过”结论。`,
  ];

  if (options.previousContext) {
    lines.push(
      "",
      "<previous_context>",
      options.previousContext,
      "</previous_context>",
    );
  }

  lines.push(
    "",
    "<original_text>",
    originalText,
    "</original_text>",
    "",
    "<polished_draft>",
    draftText,
    "</polished_draft>",
  );

  const checksBlock = formatFidelityChecksForReview(options.fidelityChecks);
  if (checksBlock) {
    lines.push("", checksBlock);
  }

  return lines.join("\n");
}

/**
 * 构造评审不通过后打回给润色员 Agent 的返工修订指令（强制回锚原始转录稿，防多轮二次漂移）
 */
export function buildRevisionUserPrompt(
  review: ReviewResult,
  attempt: number,
  originalText?: string,
): string {
  const lines: string[] = [
    `评审员未通过你第 ${attempt} 轮的润色稿，请对照原始 ASR 转录文本进行定点修订：`,
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

  if (originalText) {
    lines.push("", "<original_text_reference>", originalText, "</original_text_reference>");
  }

  lines.push(
    "",
    "返工要求：",
    "1. 必须以原始转录文本为准进行定点修正，保留上一轮已准确、通顺的部分，切勿在旧草稿上过度二次改写导致新的语义漂移。",
    "2. 直接输出修订后的完整当前段正文，不要包含任何解释、说明、标签或寒暄。",
  );

  return lines.join("\n");
}
