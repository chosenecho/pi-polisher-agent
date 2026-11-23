import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface PolishSkill {
  /** Skill 唯一标识（如 formal、concise、vivid） */
  name: string;
  /** 简短描述，用于列表展示与上下文提示 */
  description: string;
  /** Skill 正文内容（风格规则、约束与示例） */
  content: string;
  /** Skill 来源文件路径（内存构造的 Skill 可省略） */
  filePath?: string;
}

export interface LoadSkillsOptions {
  /** 自定义 Skill 根目录，默认指向项目内置 skills/ 目录 */
  skillsDir?: string;
}

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SKILLS_DIR = resolve(CURRENT_DIR, "../skills");

/**
 * 解析包含 YAML Frontmatter 的 SKILL.md 文本
 */
export function parseSkillMarkdown(
  raw: string,
  fallbackName: string,
  filePath?: string,
): PolishSkill {
  const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  let name = fallbackName.trim();
  let description = "";
  let body = normalized;

  const frontmatterMatch = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1];
    body = normalized.slice(frontmatterMatch[0].length);

    for (const line of frontmatter.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const colonIdx = trimmed.indexOf(":");
      if (colonIdx <= 0) continue;

      const key = trimmed.slice(0, colonIdx).trim().toLowerCase();
      const value = stripMatchingQuotes(trimmed.slice(colonIdx + 1).trim());

      if (key === "name" && value) {
        name = value;
      } else if (key === "description") {
        description = value;
      }
    }
  }

  const content = body.trim();
  if (!name) {
    throw new Error(`Skill 缺少有效名称${filePath ? `：${filePath}` : ""}`);
  }
  if (!content) {
    throw new Error(`Skill "${name}" 内容为空${filePath ? `：${filePath}` : ""}`);
  }

  return {
    name,
    description,
    content,
    filePath,
  };
}

/**
 * 扫描目录中所有 <skillsDir>/<name>/SKILL.md 并返回可用 Skill 列表
 */
export async function discoverSkills(skillsDir: string = DEFAULT_SKILLS_DIR): Promise<PolishSkill[]> {
  const resolvedDir = resolve(skillsDir);
  let entries;
  try {
    entries = await readdir(resolvedDir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`Skill 目录不存在：${resolvedDir}`);
    }
    throw error;
  }

  const skills: PolishSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillFile = join(resolvedDir, entry.name, "SKILL.md");
    try {
      await access(skillFile);
    } catch {
      continue;
    }

    const raw = await readFile(skillFile, "utf-8");
    skills.push(parseSkillMarkdown(raw, entry.name, skillFile));
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/**
 * 按名称加载一个或多个风格 Skill（保持传入顺序并自动去重）
 */
export async function loadSkills(
  names: readonly string[],
  options: LoadSkillsOptions = {},
): Promise<PolishSkill[]> {
  const uniqueNames: string[] = [];
  const seen = new Set<string>();

  for (const rawName of names) {
    const trimmed = rawName.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueNames.push(trimmed);
  }

  if (uniqueNames.length === 0) {
    return [];
  }

  const available = await discoverSkills(options.skillsDir);
  const byKey = new Map(available.map((skill) => [skill.name.toLowerCase(), skill]));
  const availableNames = available.map((skill) => skill.name);

  const loaded: PolishSkill[] = [];
  for (const requested of uniqueNames) {
    const found = byKey.get(requested.toLowerCase());
    if (!found) {
      const hint =
        availableNames.length > 0 ? `可用 Skill：${availableNames.join(", ")}` : "当前目录下没有可用 Skill";
      throw new Error(`未找到风格 Skill "${requested}"。${hint}`);
    }
    loaded.push(found);
  }

  return loaded;
}

/**
 * 将已选择的风格 Skill 序列化为注入模型的结构化指令块
 */
export function formatSkillsForInjection(skills: readonly PolishSkill[]): string {
  if (skills.length === 0) {
    return "";
  }

  const blocks = skills.map((skill) => {
    const attrs = [`name="${escapeXmlAttr(skill.name)}"`];
    if (skill.description) {
      attrs.push(`description="${escapeXmlAttr(skill.description)}"`);
    }
    return `<skill ${attrs.join(" ")}>\n${skill.content}\n</skill>`;
  });

  return [
    "<style_skills>",
    "以下为本次润色已注入的风格 Skill，请在遵循基础角色准则的前提下严格执行其风格规范：",
    "",
    blocks.join("\n\n"),
    "</style_skills>",
  ].join("\n");
}

function stripMatchingQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function escapeXmlAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;");
}
