import { readFile } from "node:fs/promises";
import { extname } from "node:path";

export interface GlossaryEntry {
  /** 规范术语 / 目标正确写法 */
  term: string;
  /** 常见 ASR 同音误识别或别名列表 */
  aliases: string[];
  /** 可选语境说明 */
  note?: string;
}

/**
 * 解析术语表文本（支持逐行文本格式或 JSON 格式）：
 *
 * 文本格式示例：
 *   # 注释行会被忽略
 *   白莲, 白连 -> 百炼 | 阿里云大模型平台
 *   缓存鸡穿 => 缓存击穿
 *   Pi AgentLoop: 项目使用的核心循环框架
 *   DeepSeek
 *
 * JSON 格式示例：
 *   [{ "term": "百炼", "aliases": ["白莲", "白连"], "note": "阿里云大模型平台" }]
 *   或 { "白莲": "百炼" }
 */
export function parseGlossaryText(raw: string, isJsonHint: boolean = false): GlossaryEntry[] {
  const cleaned = raw.replace(/^\uFEFF/, "").trim();
  if (!cleaned) {
    return [];
  }

  if (isJsonHint || cleaned.startsWith("[") || cleaned.startsWith("{")) {
    return parseGlossaryJson(cleaned);
  }

  const entries: GlossaryEntry[] = [];
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) {
      continue;
    }

    const parsed = parseGlossaryLine(line);
    if (parsed) {
      entries.push(parsed);
    }
  }

  return deduplicateGlossary(entries);
}

/**
 * 从磁盘文件读取并解析术语表（支持 .txt / .md / .glossary / .json）
 */
export async function loadGlossaryFile(filePath: string): Promise<GlossaryEntry[]> {
  const raw = await readFile(filePath, "utf-8");
  const isJson = extname(filePath).toLowerCase() === ".json";
  return parseGlossaryText(raw, isJson);
}

/**
 * 将术语表格式化为结构化 XML 块，同步注入润色 Agent 与评审 Agent
 */
export function formatGlossaryForInjection(entries: readonly GlossaryEntry[]): string {
  if (entries.length === 0) {
    return "";
  }

  const lines = entries.map((entry) => {
    const parts: string[] = [`- 规范写法：${entry.term}`];
    if (entry.aliases.length > 0) {
      parts.push(`常见 ASR 误识：${entry.aliases.join("、")}`);
    }
    if (entry.note) {
      parts.push(`说明：${entry.note}`);
    }
    return parts.join(" | ");
  });

  return [
    "<glossary>",
    "以下为本次 ASR 转录稿的专有名词与同音纠错锚点。遇到对应误识或专名时，请统一采用规范写法，切勿自行臆测或前后不一致：",
    ...lines,
    "</glossary>",
  ].join("\n");
}

function parseGlossaryLine(line: string): GlossaryEntry | undefined {
  // 提取可选尾部说明（使用 " | " 或 "｜" 分隔）
  let body = line;
  let note: string | undefined;
  const pipeIdx = body.search(/\s*[|｜]\s*/);
  if (pipeIdx !== -1) {
    const match = body.match(/^(.*?)\s*[|｜]\s*(.+)$/);
    if (match) {
      body = match[1].trim();
      note = match[2].trim() || undefined;
    }
  }

  // 格式 1：误识词1, 误识词2 -> 规范词（支持 -> / => / →）
  const arrowMatch = body.match(/^(.+?)\s*(?:->|=>|→)\s*(.+)$/);
  if (arrowMatch) {
    const rawAliases = arrowMatch[1]
      .split(/[,，、;；]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const term = arrowMatch[2].trim();
    if (!term) return undefined;
    return {
      term,
      aliases: rawAliases.filter((alias) => alias.toLowerCase() !== term.toLowerCase()),
      note,
    };
  }

  // 格式 2：规范词: 说明（若未通过 | 提供说明）
  if (!note) {
    const colonMatch = body.match(/^([^:：]+)[:：]\s*(.+)$/);
    if (colonMatch) {
      const term = colonMatch[1].trim();
      const desc = colonMatch[2].trim();
      if (!term) return undefined;
      return { term, aliases: [], note: desc || undefined };
    }
  }

  // 格式 3：纯规范词
  return body ? { term: body, aliases: [], note } : undefined;
}

function parseGlossaryJson(raw: string): GlossaryEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`术语表 JSON 解析失败：${reason}`);
  }

  const entries: GlossaryEntry[] = [];

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (typeof item === "string" && item.trim()) {
        entries.push({ term: item.trim(), aliases: [] });
        continue;
      }
      if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        const term = typeof obj.term === "string" ? obj.term.trim() : "";
        if (!term) continue;
        const aliases = Array.isArray(obj.aliases)
          ? obj.aliases
              .filter((a): a is string => typeof a === "string")
              .map((a) => a.trim())
              .filter((a) => a.length > 0 && a.toLowerCase() !== term.toLowerCase())
          : [];
        const note = typeof obj.note === "string" && obj.note.trim() ? obj.note.trim() : undefined;
        entries.push({ term, aliases, note });
      }
    }
    return deduplicateGlossary(entries);
  }

  if (parsed && typeof parsed === "object") {
    // 简写映射：{ "白莲": "百炼", "白连": "百炼" }
    const byTerm = new Map<string, GlossaryEntry>();
    for (const [alias, rawTerm] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof rawTerm !== "string" || !rawTerm.trim()) continue;
      const term = rawTerm.trim();
      const key = term.toLowerCase();
      const existing = byTerm.get(key) ?? { term, aliases: [] };
      const trimmedAlias = alias.trim();
      if (trimmedAlias && trimmedAlias.toLowerCase() !== key) {
        existing.aliases.push(trimmedAlias);
      }
      byTerm.set(key, existing);
    }
    return deduplicateGlossary([...byTerm.values()]);
  }

  throw new Error("术语表 JSON 必须是数组或键值对对象。");
}

function deduplicateGlossary(entries: readonly GlossaryEntry[]): GlossaryEntry[] {
  const merged = new Map<string, GlossaryEntry>();

  for (const entry of entries) {
    const term = entry.term.trim();
    if (!term) continue;
    const key = term.toLowerCase();
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        term,
        aliases: [...new Set(entry.aliases)],
        note: entry.note,
      });
    } else {
      const aliasSet = new Set(existing.aliases.map((a) => a.toLowerCase()));
      for (const alias of entry.aliases) {
        if (!aliasSet.has(alias.toLowerCase())) {
          existing.aliases.push(alias);
          aliasSet.add(alias.toLowerCase());
        }
      }
      if (!existing.note && entry.note) {
        existing.note = entry.note;
      }
    }
  }

  return [...merged.values()];
}
