import type { GlossaryEntry } from "./glossary.js";

export type FidelityAlertCode =
  | "compression_too_high"
  | "expansion_too_high"
  | "missing_numbers"
  | "added_numbers"
  | "missing_terms"
  | "context_leak"
  | "chatty_preamble"
  | "unfixed_glossary_alias";

export interface FidelityAlert {
  code: FidelityAlertCode;
  message: string;
}

export interface FidelityCheckReport {
  /** 去除标点与高频口语填充词后的原文有效字符数 */
  originalEffectiveChars: number;
  /** 去除标点与空白后的润色稿有效字符数 */
  draftEffectiveChars: number;
  /** 有效字数比例（draft / original） */
  lengthRatio: number;
  /** 疑似遗漏的数值/百分比/时间/版本锚点 */
  missingNumbers: string[];
  /** 润色稿中新增、原文未出现的数值锚点 */
  addedNumbers: string[];
  /** 疑似遗漏的英文标识符/专名缩写 */
  missingTerms: string[];
  /** 命中的确定性风险告警列表（作为高风险线索提供给评审 Agent 重点核查） */
  alerts: FidelityAlert[];
}

export interface FidelityCheckOptions {
  /** 上一块只读衔接上文（用于检测是否误将上文重复输出到当前块开头） */
  previousContext?: string;
  /** 注入的术语表（用于检测原文出现但润色稿仍未修正的误识词） */
  glossary?: readonly GlossaryEntry[];
  /** 净字数压缩比告警下限（默认 0.55，仅在原文有效字数 >= 40 时启用） */
  minLengthRatio?: number;
  /** 净字数膨胀比告警上限（默认 1.35，仅在原文有效字数 >= 40 时启用） */
  maxLengthRatio?: number;
}

const FILLER_REGEX =
  /(?:怎么说呢|就是说|其实呢|然后呢|那接下来呢|对不对|是不是|你知道吧|大家可以看到|嗯+|呃+|啊+|哦+|嘛|吧|呢|那个)/g;

const CHATTY_PREAMBLE_REGEX =
  /^(?:好的[，,。！!\s]*)?(?:(?:以下|下面)是(?:我为您|为您)?润色后的?|润色后(?:的文本|结果|如下)?[:：]|修改后(?:的文本|结果|如下)?[:：])/;

const IGNORED_LATIN_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "have",
  "will",
  "can",
  "not",
  "but",
  "are",
  "was",
  "were",
  "you",
  "your",
  "our",
  "its",
  "all",
  "one",
  "two",
  "yes",
  "ok",
  "okay",
]);

const DIGIT_TO_ZH: Record<string, string> = {
  "0": "零",
  "1": "一",
  "2": "二",
  "3": "三",
  "4": "四",
  "5": "五",
  "6": "六",
  "7": "七",
  "8": "八",
  "9": "九",
};

/**
 * 零模型成本的确定性保真预检：
 * 在调用评审 Agent 前自动扫描压缩比、数值锚点、英文专名、上文重复泄漏、寒暄前缀与术语纠错，
 * 将风险线索提供给评审 Agent 重点核查，降低“流畅但意思漂移”被放行的概率。
 */
export function runFidelityChecks(
  originalText: string,
  draftText: string,
  options: FidelityCheckOptions = {},
): FidelityCheckReport {
  const minLengthRatio = options.minLengthRatio ?? 0.55;
  const maxLengthRatio = options.maxLengthRatio ?? 1.35;

  const originalEffectiveChars = countEffectiveChars(originalText, true);
  const draftEffectiveChars = countEffectiveChars(draftText, false);
  const lengthRatio =
    originalEffectiveChars > 0
      ? Number((draftEffectiveChars / originalEffectiveChars).toFixed(2))
      : 1;

  const alerts: FidelityAlert[] = [];

  // 1. 压缩 / 膨胀比检查（短句基数太小易波动，>= 40 有效字时启用）
  if (originalEffectiveChars >= 40) {
    if (lengthRatio < minLengthRatio) {
      alerts.push({
        code: "compression_too_high",
        message: `有效字数比例偏低（${Math.round(lengthRatio * 100)}%，原文约 ${originalEffectiveChars} 字 → 润色稿约 ${draftEffectiveChars} 字），请重点核查是否进行了摘要式删减或遗漏细节。`,
      });
    } else if (lengthRatio > maxLengthRatio) {
      alerts.push({
        code: "expansion_too_high",
        message: `有效字数比例偏高（${Math.round(lengthRatio * 100)}%，原文约 ${originalEffectiveChars} 字 → 润色稿约 ${draftEffectiveChars} 字），请重点核查是否脑补了原文未提及的内容或重复输出了上文。`,
      });
    }
  }

  // 2. 数值锚点核对（数字、小数、百分比、时间、带 k/m 单位数值）
  const originalNumbers = extractNumericTokens(originalText);
  const draftNumbers = extractNumericTokens(draftText);

  const missingNumbers = originalNumbers.filter(
    (token) => !hasNumericEquivalent(token, draftText, draftNumbers),
  );
  const addedNumbers = draftNumbers.filter(
    (token) => !hasNumericEquivalent(token, originalText, originalNumbers),
  );

  if (missingNumbers.length > 0) {
    alerts.push({
      code: "missing_numbers",
      message: `原文中的数值/时间锚点在润色稿中未见对应：${missingNumbers.join("、")}（若属口误自我纠错被正常修正可放行，否则请打回补回）。`,
    });
  }
  if (addedNumbers.length > 0) {
    alerts.push({
      code: "added_numbers",
      message: `润色稿中出现了原文未见的数值/时间锚点：${addedNumbers.join("、")}（请核查是否为阿拉伯数字格式转换，或属于擅自编造数据）。`,
    });
  }

  // 3. 英文专名 / 缩写核对
  const originalTerms = extractLatinTerms(originalText);
  const draftLower = draftText.toLowerCase();
  const missingTerms = originalTerms.filter((term) => !draftLower.includes(term.toLowerCase()));
  if (missingTerms.length > 0) {
    alerts.push({
      code: "missing_terms",
      message: `原文中的英文术语/缩写未在润色稿中保留：${missingTerms.join("、")}（请核查是被准确意译还是被遗漏/改坏）。`,
    });
  }

  // 4. 上文只读衔接泄漏检测
  if (options.previousContext && hasContextLeak(options.previousContext, draftText)) {
    alerts.push({
      code: "context_leak",
      message: "润色稿开头疑似重复输出了 <previous_context>（上一块衔接上文）的内容，请检查并要求仅输出当前块正文。",
    });
  }

  // 5. 寒暄前缀检测
  if (CHATTY_PREAMBLE_REGEX.test(draftText.trim())) {
    alerts.push({
      code: "chatty_preamble",
      message: "润色稿开头疑似包含“润色后如下：/好的，以下是…”等非正文寒暄说明，违反纯净输出准则。",
    });
  }

  // 6. 术语表未修正误识词检测
  if (options.glossary && options.glossary.length > 0) {
    const unfixed: string[] = [];
    for (const entry of options.glossary) {
      for (const alias of entry.aliases) {
        if (
          alias.length > 0 &&
          originalText.toLowerCase().includes(alias.toLowerCase()) &&
          draftText.toLowerCase().includes(alias.toLowerCase())
        ) {
          unfixed.push(`"${alias}" → 应为 "${entry.term}"`);
        }
      }
    }
    if (unfixed.length > 0) {
      alerts.push({
        code: "unfixed_glossary_alias",
        message: `术语表指定的 ASR 误识词在润色稿中仍未修正：${unfixed.join("；")}。`,
      });
    }
  }

  return {
    originalEffectiveChars,
    draftEffectiveChars,
    lengthRatio,
    missingNumbers,
    addedNumbers,
    missingTerms,
    alerts,
  };
}

/**
 * 将确定性预检结果格式化为提供给评审 Agent 的风险提示块
 */
export function formatFidelityChecksForReview(report: FidelityCheckReport | undefined): string {
  if (!report || report.alerts.length === 0) {
    return "";
  }

  const lines = [
    "<automated_checks>",
    "以下是程序自动预检发现的潜在漂移风险线索，请对照原文与润色稿逐项核实（属合理书面化或口误纠错可放行，确属遗漏/篡改/泄漏必须判不通过）：",
    ...report.alerts.map((alert, idx) => `${idx + 1}. [${alert.code}] ${alert.message}`),
    "</automated_checks>",
  ];
  return lines.join("\n");
}

function countEffectiveChars(text: string, stripFillers: boolean): number {
  let working = text;
  if (stripFillers) {
    working = working.replace(FILLER_REGEX, "");
  }
  const stripped = working.replace(/[\s\p{P}\p{S}]+/gu, "");
  return stripped.length;
}

function extractNumericTokens(text: string): string[] {
  const matches = text.match(/\d+(?:[.:]\d+)?%?(?:[kKmMwW万亿])?/g) ?? [];
  return [...new Set(matches)];
}

function hasNumericEquivalent(
  token: string,
  targetText: string,
  targetTokens: readonly string[],
): boolean {
  const lowerToken = token.toLowerCase();
  if (targetTokens.some((t) => t.toLowerCase() === lowerToken)) {
    return true;
  }

  // 时间格式兼容：例如 "9" 与 "9:00" / "09:00"
  const pureDigits = token.replace(/^0+(?=\d)/, "");
  if (/^\d+$/.test(pureDigits)) {
    if (
      targetTokens.some((t) => {
        const normalized = t.replace(/^0+(?=\d)/, "");
        return normalized === pureDigits || normalized === `${pureDigits}:00`;
      })
    ) {
      return true;
    }

    // 简单中文数字等价兼容（0~99，避免把“3个”→“三个”误报为丢数字）
    const zhForms = numberToChineseVariants(Number(pureDigits));
    if (zhForms.some((zh) => targetText.includes(zh))) {
      return true;
    }
  }

  // 反向时间格式兼容："9:00" ↔ "9点" / "九点"
  const timeMatch = token.match(/^0?(\d{1,2}):00$/);
  if (timeMatch) {
    const hour = timeMatch[1];
    if (targetTokens.includes(hour)) {
      return true;
    }
    const zhHours = numberToChineseVariants(Number(hour));
    if (zhHours.some((zh) => targetText.includes(zh))) {
      return true;
    }
  }

  return false;
}

function numberToChineseVariants(num: number): string[] {
  if (!Number.isInteger(num) || num < 0 || num > 99) {
    return [];
  }
  if (num < 10) {
    const base = DIGIT_TO_ZH[String(num)];
    return num === 2 ? [base, "两"] : [base];
  }
  const tens = Math.floor(num / 10);
  const ones = num % 10;
  const onesStr = ones === 0 ? "" : DIGIT_TO_ZH[String(ones)];
  if (tens === 1) {
    return [`十${onesStr}`, `一十${onesStr}`];
  }
  const tensStr = DIGIT_TO_ZH[String(tens)];
  return [`${tensStr}十${onesStr}`];
}

function extractLatinTerms(text: string): string[] {
  const matches = text.match(/\b[A-Za-z][A-Za-z0-9_-]{1,}\b/g) ?? [];
  const unique: string[] = [];
  const seen = new Set<string>();

  for (const term of matches) {
    const key = term.toLowerCase();
    if (IGNORED_LATIN_WORDS.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(term);
  }
  return unique;
}

function hasContextLeak(previousContext: string, draftText: string): boolean {
  const cleanContext = previousContext.replace(/[\s\p{P}]+/gu, "");
  const cleanDraft = draftText.replace(/[\s\p{P}]+/gu, "");
  if (cleanContext.length < 14 || cleanDraft.length < 14) {
    return false;
  }

  // 检查上一块末尾窗口是否被直接复写到当前润色稿的开头区域
  const probeLength = Math.min(20, cleanContext.length);
  const tailProbe = cleanContext.slice(-probeLength);
  const headWindow = cleanDraft.slice(0, Math.min(cleanDraft.length, cleanContext.length + 30));
  return headWindow.includes(tailProbe);
}
