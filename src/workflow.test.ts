import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  contentText,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  getCurrentSystemPrompt,
} from "@earendil-works/pi-ai";
import { createCustomOpenAIConfig, parseThinkingLevel, parseTokenCount } from "./models.js";
import {
  composePolisherSystemPrompt,
  composeReviewerSystemPrompt,
  POLISHER_SYSTEM_PROMPT,
} from "./prompts.js";
import { parseReviewFromText, SUBMIT_REVIEW_TOOL_NAME } from "./reviewer.js";
import { discoverSkills, loadSkills, parseSkillMarkdown, type PolishSkill } from "./skills.js";
import { parseMaxAttempts, polishText, type PolishLoopEvent } from "./workflow.js";

test("polishText 关闭评审且未注入 Skill 时仅使用角色扮演基础系统提示词并流式输出", async () => {
  const faux = fauxProvider({ provider: "faux-polisher" });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();

  let capturedSystemPrompt = "";
  let capturedUserPrompt = "";

  faux.setResponses([
    (context) => {
      capturedSystemPrompt = getCurrentSystemPrompt(context.messages) ?? "";
      const userMsg = context.messages.find((m) => m.role === "user");
      capturedUserPrompt = userMsg ? contentText(userMsg.content) : "";
      return fauxAssistantMessage([
        fauxText("今天我去公园游玩，天气晴朗宜人，园内百花盛开，景色十分迷人。"),
      ]);
    },
  ]);

  const deltas: string[] = [];
  const inputText = "今天我去公园玩了，天气特别特别好，然后我看到了很多花都很漂亮。";

  const result = await polishText(inputText, {
    models,
    model,
    review: false,
    onTextDelta: (delta) => deltas.push(delta),
  });

  assert.equal(capturedSystemPrompt, POLISHER_SYSTEM_PROMPT);
  assert.doesNotMatch(capturedSystemPrompt, /<style_skills>/);
  assert.ok(capturedUserPrompt.includes(inputText));
  assert.equal(result.originalText, inputText);
  assert.equal(
    result.polishedText,
    "今天我去公园游玩，天气晴朗宜人，园内百花盛开，景色十分迷人。",
  );
  assert.deepEqual(result.appliedSkills, []);
  assert.equal(result.reviewEnabled, false);
  assert.equal(result.passed, true);
  assert.equal(result.attempts, 1);
  assert.equal(result.rounds.length, 1);
  assert.equal(deltas.join(""), result.polishedText);
  assert.equal(result.provider, "faux-polisher");
  assert.equal(faux.state.callCount, 1);
});

test("polishText 通过 skillNames 选择并注入内置风格 Skill（单轮直出）", async () => {
  const faux = fauxProvider({ provider: "faux-skill" });
  const models = createModels();
  models.setProvider(faux.provider);

  let capturedSystemPrompt = "";
  faux.setResponses([
    (context) => {
      capturedSystemPrompt = getCurrentSystemPrompt(context.messages) ?? "";
      return fauxAssistantMessage([fauxText("明日上午9:00将召开项目会议，请各位准时参会。")]);
    },
  ]);

  const result = await polishText("明天早上9点开个项目会，别迟到啊。", {
    models,
    model: faux.getModel(),
    skillNames: ["formal"],
    review: false,
  });

  const [formalSkill] = await loadSkills(["formal"]);
  assert.equal(capturedSystemPrompt, composePolisherSystemPrompt([formalSkill]));
  assert.ok(capturedSystemPrompt.startsWith(POLISHER_SYSTEM_PROMPT));
  assert.match(capturedSystemPrompt, /<skill name="formal"/);
  assert.match(capturedSystemPrompt, /正式商务风格/);
  assert.deepEqual(result.appliedSkills, ["formal"]);
  assert.equal(result.polishedText, "明日上午9:00将召开项目会议，请各位准时参会。");
});

test("polishText 支持组合注入多个 Skill 并自动去重", async () => {
  const faux = fauxProvider({ provider: "faux-multi-skill" });
  const models = createModels();
  models.setProvider(faux.provider);

  const inlineSkill: PolishSkill = {
    name: "custom-brand",
    description: "品牌调性规范",
    content: "禁用感叹号，保持温和克制。",
  };

  let capturedSystemPrompt = "";
  faux.setResponses([
    (context) => {
      capturedSystemPrompt = getCurrentSystemPrompt(context.messages) ?? "";
      return fauxAssistantMessage([fauxText("方案方向可行，预算部分请进一步细化。")]);
    },
  ]);

  const result = await polishText("这个方案大体还行，就是预算太模糊了，改改吧！", {
    models,
    model: faux.getModel(),
    skills: [inlineSkill],
    skillNames: ["formal", "concise", "FORMAL"],
    review: false,
  });

  assert.deepEqual(result.appliedSkills, ["custom-brand", "formal", "concise"]);
  assert.match(capturedSystemPrompt, /<skill name="custom-brand"/);
  assert.match(capturedSystemPrompt, /<skill name="formal"/);
  assert.match(capturedSystemPrompt, /<skill name="concise"/);
  assert.equal(capturedSystemPrompt.match(/<skill name="formal"/g)?.length, 1);
});

test("AgentLoop 评审闭环：首轮评审通过时直接结束并同步注入同一组风格 Skill", async () => {
  const polisherFaux = fauxProvider({ provider: "faux-polisher-loop" });
  const reviewerFaux = fauxProvider({ provider: "faux-reviewer-loop" });
  const models = createModels();
  models.setProvider(polisherFaux.provider);
  models.setProvider(reviewerFaux.provider);

  let reviewerSystemPrompt = "";
  let reviewerUserPrompt = "";

  polisherFaux.setResponses([
    fauxAssistantMessage([fauxText("明日上午9:00将召开项目会议，请各位准时参会。")]),
  ]);

  reviewerFaux.setResponses([
    (context) => {
      reviewerSystemPrompt = getCurrentSystemPrompt(context.messages) ?? "";
      const userMsg = context.messages.find((m) => m.role === "user");
      reviewerUserPrompt = userMsg ? contentText(userMsg.content) : "";
      return fauxAssistantMessage([
        fauxToolCall(SUBMIT_REVIEW_TOOL_NAME, {
          passed: true,
          summary: "符合正式商务风格，忠于原意且表述干净。",
          issues: [],
          suggestions: [],
        }),
      ]);
    },
  ]);

  const events: PolishLoopEvent["type"][] = [];
  const result = await polishText("明天早上9点开个项目会，别迟到啊。", {
    models,
    model: polisherFaux.getModel(),
    reviewModels: models,
    reviewModel: reviewerFaux.getModel(),
    skillNames: ["formal"],
    onLoopEvent: (event) => events.push(event.type),
  });

  const [formalSkill] = await loadSkills(["formal"]);
  assert.equal(reviewerSystemPrompt, composeReviewerSystemPrompt([formalSkill]));
  assert.match(reviewerUserPrompt, /明天早上9点开个项目会，别迟到啊。/);
  assert.match(reviewerUserPrompt, /明日上午9:00将召开项目会议，请各位准时参会。/);

  assert.equal(result.reviewEnabled, true);
  assert.equal(result.passed, true);
  assert.equal(result.attempts, 1);
  assert.equal(result.review?.passed, true);
  assert.equal(result.rounds.length, 1);
  assert.equal(polisherFaux.state.callCount, 1);
  // submit_review 设置了 terminate: true，因此评审 Agent 仅发起 1 次 LLM 请求
  assert.equal(reviewerFaux.state.callCount, 1);
  assert.deepEqual(events, [
    "polish_start",
    "polish_complete",
    "review_start",
    "review_complete",
  ]);
});

test("AgentLoop 评审闭环：质量不达标打回重做，第二轮修订通过", async () => {
  const polisherFaux = fauxProvider({ provider: "faux-polisher-retry" });
  const reviewerFaux = fauxProvider({ provider: "faux-reviewer-retry" });
  const models = createModels();
  models.setProvider(polisherFaux.provider);
  models.setProvider(reviewerFaux.provider);

  let secondTurnUserPrompt = "";

  polisherFaux.setResponses([
    // 第 1 轮：夹带解释前缀且仍偏口语
    fauxAssistantMessage([fauxText("润色如下：明天上午9点开项目会，别迟到。")]),
    // 第 2 轮：接收打回意见后修订
    (context) => {
      const userMessages = context.messages.filter((m) => m.role === "user");
      const lastUser = userMessages[userMessages.length - 1];
      secondTurnUserPrompt = lastUser ? contentText(lastUser.content) : "";
      return fauxAssistantMessage([fauxText("明日上午9:00将召开项目会议，请各位准时出席。")]);
    },
  ]);

  reviewerFaux.setResponses([
    // 第 1 轮评审：不通过
    fauxAssistantMessage([
      fauxToolCall(SUBMIT_REVIEW_TOOL_NAME, {
        passed: false,
        summary: "包含多余前缀且语气偏口语",
        issues: ["开头夹带“润色如下：”说明前缀", "“别迟到”不符合正式商务风格"],
        suggestions: ["删除前缀直接输出正文", "改用“请各位准时出席”等正式措辞"],
      }),
    ]),
    // 第 2 轮评审：通过
    fauxAssistantMessage([
      fauxToolCall(SUBMIT_REVIEW_TOOL_NAME, {
        passed: true,
        summary: "已修正所有问题，正式得体。",
      }),
    ]),
  ]);

  const events: PolishLoopEvent["type"][] = [];
  const result = await polishText("明天早上9点开个项目会，别迟到啊。", {
    models,
    model: polisherFaux.getModel(),
    reviewModels: models,
    reviewModel: reviewerFaux.getModel(),
    skillNames: ["formal"],
    maxAttempts: 3,
    onLoopEvent: (event) => events.push(event.type),
  });

  assert.match(secondTurnUserPrompt, /评审员未通过你第 1 轮的润色稿/);
  assert.match(secondTurnUserPrompt, /开头夹带“润色如下：”说明前缀/);
  assert.match(secondTurnUserPrompt, /删除前缀直接输出正文/);

  assert.equal(result.attempts, 2);
  assert.equal(result.passed, true);
  assert.equal(result.polishedText, "明日上午9:00将召开项目会议，请各位准时出席。");
  assert.equal(result.rounds[0]?.review?.passed, false);
  assert.equal(result.rounds[1]?.review?.passed, true);
  assert.equal(polisherFaux.state.callCount, 2);
  assert.equal(reviewerFaux.state.callCount, 2);
  assert.deepEqual(events, [
    "polish_start",
    "polish_complete",
    "review_start",
    "review_complete",
    "retry_scheduled",
    "polish_start",
    "polish_complete",
    "review_start",
    "review_complete",
  ]);
});

test("AgentLoop 评审闭环：达到 maxAttempts 仍未通过时停止循环并标记 passed=false", async () => {
  const polisherFaux = fauxProvider({ provider: "faux-polisher-cap" });
  const reviewerFaux = fauxProvider({ provider: "faux-reviewer-cap" });
  const models = createModels();
  models.setProvider(polisherFaux.provider);
  models.setProvider(reviewerFaux.provider);

  polisherFaux.setResponses([
    fauxAssistantMessage([fauxText("第一版草稿")]),
    fauxAssistantMessage([fauxText("第二版草稿")]),
  ]);

  reviewerFaux.setResponses([
    fauxAssistantMessage([
      fauxToolCall(SUBMIT_REVIEW_TOOL_NAME, {
        passed: false,
        summary: "第一版仍遗漏时间信息",
        issues: ["遗漏时间信息"],
        suggestions: ["补全上午9点的时间信息"],
      }),
    ]),
    fauxAssistantMessage([
      fauxToolCall(SUBMIT_REVIEW_TOOL_NAME, {
        passed: false,
        summary: "第二版依然遗漏时间信息",
        issues: ["时间信息仍缺失"],
        suggestions: ["明确写出上午9:00"],
      }),
    ]),
  ]);

  const result = await polishText("明天早上9点开个项目会。", {
    models,
    model: polisherFaux.getModel(),
    reviewModels: models,
    reviewModel: reviewerFaux.getModel(),
    maxAttempts: 2,
  });

  assert.equal(result.attempts, 2);
  assert.equal(result.passed, false);
  assert.equal(result.polishedText, "第二版草稿");
  assert.equal(result.review?.summary, "第二版依然遗漏时间信息");
  assert.equal(polisherFaux.state.callCount, 2);
  assert.equal(reviewerFaux.state.callCount, 2);
});

test("评审 Agent 未调用工具但返回 JSON 文本时支持兜底解析", async () => {
  const polisherFaux = fauxProvider({ provider: "faux-polisher-json" });
  const reviewerFaux = fauxProvider({ provider: "faux-reviewer-json" });
  const models = createModels();
  models.setProvider(polisherFaux.provider);
  models.setProvider(reviewerFaux.provider);

  polisherFaux.setResponses([
    fauxAssistantMessage([fauxText("方案整体可行，建议进一步明确预算明细。")]),
  ]);

  reviewerFaux.setResponses([
    fauxAssistantMessage([
      fauxText('```json\n{"passed": true, "summary": "表述清晰得体，通过评审。"}\n```'),
    ]),
  ]);

  const result = await polishText("这个方案还行，预算再细化一下。", {
    models,
    model: polisherFaux.getModel(),
    reviewModels: models,
    reviewModel: reviewerFaux.getModel(),
  });

  assert.equal(result.passed, true);
  assert.equal(result.review?.summary, "表述清晰得体，通过评审。");

  const parsedFallback = parseReviewFromText('{"passed": false, "summary": "存在错别字"}');
  assert.equal(parsedFallback.passed, false);
  assert.deepEqual(parsedFallback.issues, ["存在错别字"]);
  assert.throws(() => parseMaxAttempts(0), /无效的最大轮次/);
});

test("discoverSkills 与 loadSkills 正确扫描、解析并支持自定义目录", async () => {
  const builtin = await discoverSkills();
  assert.deepEqual(
    builtin.map((s) => s.name),
    ["concise", "formal", "transcript", "vivid"],
  );

  await assert.rejects(() => loadSkills(["non-existent"]), /未找到风格 Skill "non-existent"/);

  const parsed = parseSkillMarkdown(
    "---\nname: academic\ndescription: \"学术论文风格\"\n---\n\n使用客观学术措辞。",
    "fallback",
  );
  assert.equal(parsed.name, "academic");
  assert.equal(parsed.description, "学术论文风格");
  assert.equal(parsed.content, "使用客观学术措辞。");

  const tempDir = await mkdtemp(join(tmpdir(), "pi-polisher-skills-"));
  try {
    const customSkillDir = join(tempDir, "academic");
    await mkdir(customSkillDir, { recursive: true });
    await writeFile(
      join(customSkillDir, "SKILL.md"),
      "---\nname: academic\ndescription: 学术论文表达规范\n---\n\n保持客观中立，避免第一人称口语。\n",
      "utf-8",
    );

    const [loaded] = await loadSkills(["academic"], { skillsDir: tempDir });
    assert.equal(loaded.name, "academic");
    assert.equal(loaded.description, "学术论文表达规范");
    assert.match(loaded.content, /客观中立/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("polishText 对空文本和模型错误进行正确处理", async () => {
  const faux = fauxProvider({ provider: "faux-error" });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();

  await assert.rejects(() => polishText("   ", { models, model }), /输入文本不能为空/);

  faux.setResponses([
    fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "API 限流，请稍后重试",
    }),
  ]);

  await assert.rejects(() => polishText("测试文本", { models, model }), /API 限流，请稍后重试/);
});

test("createCustomOpenAIConfig 正确注册自定义 OpenAI 兼容模型与推理参数", () => {
  const { models, model, thinkingLevel } = createCustomOpenAIConfig({
    baseUrl: "http://127.0.0.1:3425/v1",
    modelId: "auto/deepseek-v4.1-flash",
    apiKey: "sk-placeholder",
    maxTokens: "64k",
    contextWindow: "1m",
    thinkingLevel: "high",
  });

  assert.equal(model.api, "openai-completions");
  assert.equal(model.id, "auto/deepseek-v4.1-flash");
  assert.equal(model.baseUrl, "http://127.0.0.1:3425/v1");
  assert.equal(model.maxTokens, 65536);
  assert.equal(model.contextWindow, 1048576);
  assert.equal(model.reasoning, true);
  assert.equal(thinkingLevel, "high");
  assert.equal(
    models.getModel(model.provider, "auto/deepseek-v4.1-flash")?.id,
    "auto/deepseek-v4.1-flash",
  );

  assert.equal(parseTokenCount("64k", 8192, "maxTokens"), 65536);
  assert.equal(parseTokenCount("1m", 128000, "contextWindow"), 1048576);
  assert.equal(parseThinkingLevel("HIGH"), "high");
  assert.throws(() => parseThinkingLevel("invalid"), /无效的思考强度/);
});
