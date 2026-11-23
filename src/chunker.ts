export const DEFAULT_CHUNK_SIZE = 2000;
export const DEFAULT_CONTEXT_MAX_CHARS = 240;

export interface ChunkOptions {
  /** 单块最大字符数（默认 2000；传 0 表示关闭分块，整篇单块处理） */
  maxChunkChars?: number;
}

export interface TextChunk {
  /** 从 1 开始的分块序号 */
  index: number;
  /** 总分块数 */
  total: number;
  /** 本块原始文本 */
  text: string;
}

/**
 * 校验并解析分块字符数配置（0 表示关闭分块）
 */
export function parseChunkSize(raw: number | string | undefined): number {
  if (raw === undefined || raw === "") {
    return DEFAULT_CHUNK_SIZE;
  }
  const value = typeof raw === "number" ? raw : Number(raw.trim());
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`无效的分块大小 "${raw}"，必须为大于等于 0 的整数（0 表示关闭分块）。`);
  }
  return value;
}

/**
 * 将长篇 ASR 转录稿按自然段与句末标点切分为语义完整的分块，
 * 避免长文单次送入模型导致的隐式摘要、中段遗漏与返工成本放大。
 */
export function splitTranscriptIntoChunks(
  rawText: string,
  options: ChunkOptions = {},
): TextChunk[] {
  const normalized = rawText.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const maxChars = parseChunkSize(options.maxChunkChars);
  if (maxChars === 0 || normalized.length <= maxChars) {
    return [{ index: 1, total: 1, text: normalized }];
  }

  // 优先按空行分段；若无空行则按单换行分段
  const rawParagraphs = /\n\s*\n/.test(normalized)
    ? normalized.split(/\n\s*\n+/)
    : normalized.split(/\n+/);

  const units: string[] = [];
  for (const para of rawParagraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    if (trimmed.length <= maxChars) {
      units.push(trimmed);
    } else {
      units.push(...splitOversizedParagraph(trimmed, maxChars));
    }
  }

  const grouped: string[] = [];
  let current = "";

  for (const unit of units) {
    if (!current) {
      current = unit;
      continue;
    }

    const separator = "\n\n";
    if (current.length + separator.length + unit.length <= maxChars) {
      current = `${current}${separator}${unit}`;
    } else {
      grouped.push(current);
      current = unit;
    }
  }

  if (current) {
    grouped.push(current);
  }

  const total = grouped.length;
  return grouped.map((text, idx) => ({
    index: idx + 1,
    total,
    text,
  }));
}

/**
 * 从上一块润色稿末尾提取 1~2 句作为只读滑动上文，用于承接代词、语气与术语。
 */
export function extractTailContext(
  polishedText: string,
  maxChars: number = DEFAULT_CONTEXT_MAX_CHARS,
): string {
  const normalized = polishedText.replace(/\r\n/g, "\n").trim();
  if (!normalized || maxChars <= 0) {
    return "";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const sentences = splitByDelimiter(normalized, /(?<=[。！？!?；;])\s*|\n+/);
  if (sentences.length <= 1) {
    return normalized.slice(-maxChars).trim();
  }

  const selected: string[] = [];
  let totalLen = 0;

  for (let i = sentences.length - 1; i >= 0; i--) {
    const sentence = sentences[i].trim();
    if (!sentence) continue;

    if (selected.length > 0 && totalLen + sentence.length + 1 > maxChars) {
      break;
    }

    selected.unshift(sentence);
    totalLen += sentence.length + 1;

    if (selected.length >= 2 || totalLen >= maxChars) {
      break;
    }
  }

  const joined = selected.join(" ").trim();
  if (joined.length > maxChars) {
    return joined.slice(-maxChars).trim();
  }
  return joined;
}

function splitOversizedParagraph(paragraph: string, maxChars: number): string[] {
  // 一级切分：强句末标点
  const sentences = splitByDelimiter(paragraph, /(?<=[。！？!?;；])/);
  const chunks = packSegments(sentences, maxChars);

  const result: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxChars) {
      result.push(chunk);
      continue;
    }
    // 二级切分：弱停顿标点或空格（适配无句号的长 ASR 转录流）
    const clauses = splitByDelimiter(chunk, /(?<=[，,、：:])|\s+/);
    const packedClauses = packSegments(clauses, maxChars);
    for (const piece of packedClauses) {
      if (piece.length <= maxChars) {
        result.push(piece);
      } else {
        // 兜底硬切：完全无标点无空格的超长串
        for (let offset = 0; offset < piece.length; offset += maxChars) {
          result.push(piece.slice(offset, offset + maxChars).trim());
        }
      }
    }
  }

  return result.filter((item) => item.length > 0);
}

function splitByDelimiter(text: string, pattern: RegExp): string[] {
  return text
    .split(pattern)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function packSegments(segments: readonly string[], maxChars: number): string[] {
  const packed: string[] = [];
  let current = "";

  for (const seg of segments) {
    if (!current) {
      current = seg;
      continue;
    }
    const needsSpace = /^[A-Za-z0-9]/.test(seg) && /[A-Za-z0-9]$/.test(current);
    const glue = needsSpace ? " " : "";
    if (current.length + glue.length + seg.length <= maxChars) {
      current = `${current}${glue}${seg}`;
    } else {
      packed.push(current);
      current = seg;
    }
  }

  if (current) {
    packed.push(current);
  }
  return packed;
}
