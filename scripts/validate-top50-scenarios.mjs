import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-search-top50-"));
const pluginRoot = path.join(workRoot, "plugin");
const stateRoot = path.join(workRoot, "state");
const fakeDistDir = path.join(workRoot, "dist");
const agents = [
  { id: "main", name: "Main Agent" },
  { id: "a-motfnybup5ffml", name: "文档解析专家" },
];

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function message(role, text, timestamp) {
  return {
    type: "message",
    timestamp: new Date(timestamp).toISOString(),
    message: { role, content: [{ type: "text", text }], timestamp },
  };
}

function sessionHeader(id, timestamp) {
  return { type: "session", version: 3, id, timestamp: new Date(timestamp).toISOString(), cwd: "/tmp" };
}

function installPluginSandbox() {
  fs.mkdirSync(path.join(pluginRoot, "node_modules", "openclaw", "plugin-sdk"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "index.js"), path.join(pluginRoot, "index.js"));
  writeJson(path.join(pluginRoot, "package.json"), { type: "module" });
  fs.writeFileSync(
    path.join(pluginRoot, "node_modules", "openclaw", "package.json"),
    JSON.stringify({ type: "module", exports: { "./plugin-sdk/plugin-entry": "./plugin-sdk/plugin-entry.js" } }),
  );
  fs.writeFileSync(path.join(pluginRoot, "node_modules", "openclaw", "plugin-sdk", "plugin-entry.js"), "export function definePluginEntry(entry) { return entry; }\n");
  fs.mkdirSync(fakeDistDir, { recursive: true });
}

function addSession(store, agentId, name, { label, messages, updatedAt }) {
  const dir = path.join(stateRoot, "agents", agentId, "sessions");
  const sessionId = `${agentId}-${name}`;
  const sessionFile = path.join(dir, `${sessionId}.jsonl`);
  const key = `agent:${agentId}:${name}`;
  store[key] = {
    sessionId,
    sessionFile,
    updatedAt,
    label,
    chatType: "direct",
    lastChannel: "feishu",
    origin: { provider: "feishu", surface: "feishu", chatType: "direct" },
    deliveryContext: { channel: "feishu" },
  };
  writeJsonl(sessionFile, [sessionHeader(sessionId, updatedAt - 3000), ...messages]);
}

function createFixture() {
  const now = Date.now();
  writeJson(path.join(stateRoot, "openclaw.json"), { agents: { list: agents } });
  const mainStore = {};
  const docStore = {};
  const top50Phrases = [
    "打开那个文档解析任务继续",
    "之前关于方案 A 的结论是什么",
    "那个报告是哪次任务生成的",
    "这是哪个专家处理的",
    "之前几次讨论有什么不同",
    "帮我基于历史讨论生成回答并带引用",
    "上次提到的 blocker 是什么",
    "谁负责后续 follow up",
    "查找之前提到的 GitHub 分支",
    "哪个 session 里说了 agentName",
    "上次怎么处理飞书 CLI 授权",
    "之前的报错 3380004 是什么",
    "谁说过 token 不要写日志",
    "找到和 OpenClaw Gateway 握手相关的讨论",
    "之前怎么验证 session search 可用",
    "main agent 上次怎么回复的",
    "sessionGroups 是否要移除",
    "response 兼容性怎么定的",
    "飞书 CLI 授权",
    "token 不要写日志",
    "只返回命中正文够不够",
    "验收标准",
    "最近一次关于权限的讨论",
    "跨用户泄漏风险",
    "飞书文档写权限",
    "安装了 lark-cli",
    "已授权后做了什么",
    "rg backend 性能讨论",
    "哪些 session 命中了 心态",
    "文档解析专家 所有相关讨论",
    "maxHitsPerSession 应该是多少",
    "如何展示标题命中的结果",
    "继续 AI Search Session 检索 Response 这份文档",
    "之前有哪些验收标准",
    "找和 contextBefore 相关的设计",
    "有没有讨论过无结果怎么展示",
    "找某个 sessionId 对应的会话 main-api-design",
    "找最近一次关于权限的讨论",
    "之前有没有提到跨用户泄漏风险",
    "找飞书文档写权限那次操作",
    "查哪个 session 里安装了 lark-cli",
    "上次用户确认已授权后做了什么",
    "找和 rg backend 相关的性能讨论",
    "之前哪些 session 命中了 心态",
    "找某个 agent 的所有相关讨论",
    "这条结论是不是来自助手回复",
    "命中内容前一句用户问了什么",
    "命中内容后续有没有行动项",
    "这个结果为什么被搜出来",
    "把相关 session 按最近时间列出来",
    "生成回答时引用哪个 session",
    "打开第一个最相关 session",
    "metadata snippet 很奇怪",
    "GitHub 分支",
    "3380004",
    "OpenClaw Gateway 握手",
    "验证 session search 可用",
    "AI Search Session 检索 Response",
    "contextBefore",
    "main-api-design",
    "lark-cli",
  ];
  addSession(mainStore, "main", "top50-coverage", {
    label: "Top50 Session Search 场景覆盖",
    updatedAt: now - 500,
    messages: [
      message("user", "请汇总 AI Search session search 的 top50 常用场景。", now - 5000),
      ...top50Phrases.map((text, index) => message(index % 2 === 0 ? "assistant" : "user", text, now - 4000 + index)),
      message("assistant", "这些场景共同要求返回 key sessionId agentId agentName title snippet hitCount hits context metadataMatches lastMessageAt。", now - 3000),
    ],
  });
  addSession(mainStore, "main", "project-progress", {
    label: "客户 A 推进计划",
    updatedAt: now - 1000,
    messages: [
      message("user", "上次我们聊客户 A 推进计划到哪了，后续 follow up 谁负责？", now - 9000),
      message("assistant", "客户 A 推进计划目前卡在 blocker：预算审批未完成，owner=张三，后续 follow up 是本周三确认采购反馈。", now - 8000),
      message("user", "最近项目有什么进展？", now - 7000),
      message("assistant", "最近进展：已完成需求梳理，下一步输出报告并补充引用。", now - 6000),
    ],
  });
  addSession(mainStore, "main", "api-design", {
    label: "AI Search Session 检索 Response 讨论",
    updatedAt: now - 2000,
    messages: [
      message("user", "昨天讨论的 API 怎么设计？response 兼容性怎么定的？", now - 12000),
      message("assistant", "最终 response 保持 results 单结构，key/sessionId/agentId 保持兼容，sessionGroups 移除。", now - 11000),
      message("user", "只返回命中正文够不够？", now - 10000),
      message("assistant", "只把命中的正文句子返回给 AI Search 不够，需要返回前后上下文，contextBefore 和 contextAfter 默认各一条。", now - 9000),
      message("assistant", "metadataMatches 用于解释标题、日期、agentName、sessionId 等非正文命中；target 当前不是必要字段。", now - 8000),
    ],
  });
  addSession(mainStore, "main", "rg-decision", {
    label: "rg backend 性能与决策",
    updatedAt: now - 3000,
    messages: [
      message("user", "为什么当时决定用 rg 搜索？", now - 15000),
      message("assistant", "选择 rg backend 是因为固定字符串搜索快、可解释、对 5800 sessions 的性能稳定。", now - 14000),
      message("assistant", "性能讨论还包括 maxHitsPerSession 默认 2，避免 response 太长。", now - 13000),
    ],
  });
  addSession(mainStore, "main", "security", {
    label: "权限与安全要求",
    updatedAt: now - 4000,
    messages: [
      message("user", "之前有没有提到跨用户泄漏风险？", now - 18000),
      message("assistant", "安全风险：需要确认 ChatToken 和 operator.read 不会导致跨用户 session 泄漏，token 不要写日志。", now - 17000),
      message("user", "之前的报错 3380004 是什么？", now - 16000),
      message("assistant", "3380004 表示飞书文档没有权限，需要让应用或用户获得 view/edit 权限。", now - 15000),
    ],
  });
  addSession(mainStore, "main", "gateway", {
    label: "OpenClaw Gateway 调用链路",
    updatedAt: now - 5000,
    messages: [
      message("user", "找到和 OpenClaw Gateway 握手相关的讨论。", now - 21000),
      message("assistant", "OpenClaw Gateway 先发 connect.challenge，客户端再用 client.id=cli 完成 connect 握手。", now - 20000),
      message("user", "之前怎么验证 session search 可用？", now - 19000),
      message("assistant", "通过 gateway call session-search.search 验证 backend=rg、searchedFiles、tookMs 和 count。", now - 18000),
    ],
  });
  addSession(mainStore, "main", "feishu-cli", {
    label: "飞书 CLI 授权和文档写权限",
    updatedAt: now - 6000,
    messages: [
      message("user", "上次怎么处理飞书 CLI 授权？", now - 24000),
      message("assistant", "先 lark-cli config init，再 auth login 获取 docx:document:create 和 docx:document:write_only。", now - 23000),
      message("user", "上次用户确认已授权后做了什么？", now - 22000),
      message("assistant", "用户确认已授权后，继续 device-code 轮询，然后刷新飞书文档。", now - 21000),
    ],
  });
  addSession(docStore, "a-motfnybup5ffml", "doc-parse", {
    label: "合同 PDF 解析",
    updatedAt: now - 7000,
    messages: [
      message("user", "帮我解析这份合同 PDF。", now - 26000),
      message("assistant", "已完成合同 PDF 的结构化解析，并提取了关键条款。那个报告就是这次任务生成的。", now - 25000),
    ],
  });
  addSession(docStore, "a-motfnybup5ffml", "mindset", {
    label: "保持心态轻松",
    updatedAt: now - 8000,
    messages: [
      message("user", "保持心态轻松", now - 28000),
      message("assistant", "收到！心态轻松，随时待命。", now - 27000),
    ],
  });
  addSession(docStore, "a-motfnybup5ffml", "doc-date", {
    label: "2026-05-25 文档解析会话",
    updatedAt: new Date("2026-05-25T08:07:00Z").getTime(),
    messages: [
      message("user", "文档解析专家 最近做了什么？", new Date("2026-05-25T08:06:00Z").getTime()),
      message("assistant", "文档解析专家 最近完成了合同 PDF 解析和 AI Search response 文档刷新。", new Date("2026-05-25T08:07:00Z").getTime()),
    ],
  });
  writeJson(path.join(stateRoot, "agents", "main", "sessions", "sessions.json"), mainStore);
  writeJson(path.join(stateRoot, "agents", "a-motfnybup5ffml", "sessions", "sessions.json"), docStore);
}

async function loadMethods() {
  installPluginSandbox();
  createFixture();
  process.env.OPENCLAW_HOME = stateRoot;
  process.env.OPENCLAW_DIST_DIR = fakeDistDir;
  const entry = (await import(pathToFileURL(path.join(pluginRoot, "index.js")).href)).default;
  const methods = new Map();
  entry.register({
    pluginConfig: { enabled: true, defaultLimit: 10, maxSessions: 1000, maxFiles: 1000 },
    registerGatewayMethod(name, handler) {
      methods.set(name, handler);
    },
    registerCommand() {},
    registerTool() {},
  });
  return methods;
}

async function callMethod(methods, params) {
  let payload;
  await methods.get("session-search.search")({
    params,
    respond(ok, result, error) {
      if (!ok) throw new Error(error?.message || error?.code || "gateway call failed");
      payload = result;
    },
  });
  return payload;
}

function assertCase(cases, name, condition, details = {}) {
  if (!condition) throw new Error(`FAIL ${name} ${JSON.stringify(details)}`);
  cases.push({ name });
}

const scenarios = [
  "上次我们聊客户 A 推进计划到哪了",
  "打开那个文档解析任务继续",
  "之前关于方案 A 的结论是什么",
  "为什么当时决定用 rg 搜索",
  "那个报告是哪次任务生成的",
  "这是哪个专家处理的",
  "最近项目有什么进展",
  "之前几次讨论有什么不同",
  "保持心态轻松",
  "帮我基于历史讨论生成回答并带引用",
  "上次提到的 blocker 是什么",
  "谁负责后续 follow up",
  "昨天讨论的 API 怎么设计",
  "2026-05-25 的文档解析会话",
  "文档解析专家 最近做了什么",
  "main agent 上次怎么回复的",
  "session-search.search",
  "metadata snippet 很奇怪",
  "sessionGroups 是否要移除",
  "response 兼容性怎么定的",
  "GitHub 分支",
  "agentName",
  "飞书 CLI 授权",
  "3380004",
  "token 不要写日志",
  "OpenClaw Gateway 握手",
  "验证 session search 可用",
  "maxHitsPerSession",
  "只返回命中正文够不够",
  "如何展示标题命中的结果",
  "AI Search Session 检索 Response",
  "验收标准",
  "contextBefore",
  "有没有讨论过无结果怎么展示",
  "main-api-design",
  "最近一次关于权限的讨论",
  "跨用户泄漏风险",
  "飞书文档写权限",
  "安装了 lark-cli",
  "已授权后做了什么",
  "rg backend 性能讨论",
  "哪些 session 命中了 心态",
  "文档解析专家 所有相关讨论",
  "这条结论是不是来自助手回复",
  "命中内容前一句用户问了什么",
  "命中内容后续有没有行动项",
  "这个结果为什么被搜出来",
  "把相关 session 按最近时间列出来",
  "生成回答时引用哪个 session",
  "打开第一个最相关 session",
];

const methods = await loadMethods();
const cases = [];
for (const [index, query] of scenarios.entries()) {
  const result = await callMethod(methods, {
    query,
    limit: 10,
    sinceDays: 3650,
    maxSessions: 1000,
    maxFiles: 1000,
    contextBefore: 1,
    contextAfter: 1,
  });
  assertCase(cases, `top50 ${index + 1} response shape`, result.query === query && Array.isArray(result.results) && !Object.hasOwn(result, "sessionGroups"), result);
  if (query === "有没有讨论过无结果怎么展示") {
    assertCase(cases, `top50 ${index + 1} empty result supported`, typeof result.count === "number", result);
    continue;
  }
  assertCase(cases, `top50 ${index + 1} returns result`, result.count > 0 && result.results.length > 0, { query, result });
  const row = result.results[0];
  assertCase(cases, `top50 ${index + 1} required fields`, row.key && row.sessionId && row.agentId && row.agentName && row.title && row.snippet && typeof row.lastMessageAt === "number" && typeof row.hitCount === "number" && Array.isArray(row.hits), row);
  assertCase(cases, `top50 ${index + 1} no target`, !Object.hasOwn(row, "target"), row);
  assertCase(cases, `top50 ${index + 1} no raw metadata blob`, !String(row.snippet).includes("agent:") || query.includes("agentName"), row);
}

const contextResult = await callMethod(methods, {
  query: "只返回命中正文够不够",
  limit: 10,
  sinceDays: 3650,
  contextBefore: 1,
  contextAfter: 1,
});
assertCase(cases, "context before and after present", Array.isArray(contextResult.results[0]?.hits[0]?.context?.before) && Array.isArray(contextResult.results[0]?.hits[0]?.context?.after), contextResult.results[0]);

const metadataResult = await callMethod(methods, {
  query: "文档解析专家",
  limit: 10,
  sinceDays: 3650,
});
assertCase(cases, "metadataMatches present for agentName", metadataResult.results.some((row) => row.metadataMatches?.some((item) => item.field === "agentName")), metadataResult.results);

console.log(
  JSON.stringify(
    {
      ok: true,
      scenarios: scenarios.length,
      assertions: cases.length,
      workRoot,
    },
    null,
    2,
  ),
);
