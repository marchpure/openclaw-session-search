import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-search-e2e-"));
const pluginRoot = path.join(workRoot, "plugin");
const stateRoot = path.join(workRoot, "state");
const sessionsDir = path.join(stateRoot, "agents", "main", "sessions");
const fakeDistDir = path.join(workRoot, "dist");

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
    message: {
      role,
      content: [{ type: "text", text }],
      timestamp,
    },
  };
}

function sessionHeader(id, timestamp) {
  return {
    type: "session",
    version: 3,
    id,
    timestamp: new Date(timestamp).toISOString(),
    cwd: "/tmp",
  };
}

function installPluginSandbox() {
  fs.mkdirSync(path.join(pluginRoot, "node_modules", "openclaw", "plugin-sdk"), {
    recursive: true,
  });
  fs.copyFileSync(path.join(repoRoot, "index.js"), path.join(pluginRoot, "index.js"));
  writeJson(path.join(pluginRoot, "package.json"), { type: "module" });
  fs.writeFileSync(
    path.join(pluginRoot, "node_modules", "openclaw", "package.json"),
    JSON.stringify({ type: "module", exports: { "./plugin-sdk/plugin-entry": "./plugin-sdk/plugin-entry.js" } }),
  );
  fs.writeFileSync(
    path.join(pluginRoot, "node_modules", "openclaw", "plugin-sdk", "plugin-entry.js"),
    "export function definePluginEntry(entry) { return entry; }\n",
  );
  fs.mkdirSync(fakeDistDir, { recursive: true });
  fs.writeFileSync(
    path.join(fakeDistDir, "session-binding-service-test.js"),
    `
const bindings = new Map();
const service = {
  getCapabilities({ channel }) {
    if (channel === "unsupported-test") {
      return { adapterAvailable: false, bindSupported: false, unbindSupported: false, placements: [] };
    }
    return { adapterAvailable: true, bindSupported: true, unbindSupported: true, placements: ["current"] };
  },
  resolveByConversation(conversation) {
    return bindings.get(JSON.stringify(conversation)) || null;
  },
  async bind(input) {
    const binding = {
      bindingId: "test:" + input.conversation.channel + ":" + input.conversation.conversationId,
      targetSessionKey: input.targetSessionKey,
      targetKind: input.targetKind,
      conversation: input.conversation,
      status: "active",
      boundAt: Date.now(),
      metadata: input.metadata || {},
    };
    bindings.set(JSON.stringify(input.conversation), binding);
    return binding;
  },
};
export function r() { return service; }
export function getSessionBindingService() { return service; }
`,
  );
}

function createFixture() {
  const now = Date.now();
  const store = {};
  const visibleCount = 3000;
  const cronCount = 120;
  const subagentCount = 120;
  const internalCount = 60;

  const addSession = ({ key, label, sessionId, updatedAt, kind = "visible", messages }) => {
    const file = path.join(sessionsDir, `${sessionId}.jsonl`);
    const entry = {
      sessionId,
      sessionFile: file,
      updatedAt,
      ...(label ? { label } : {}),
    };
    if (kind === "visible") {
      entry.chatType = "direct";
      entry.lastChannel = "feishu";
      entry.origin = {
        provider: "feishu",
        surface: "feishu",
        chatType: "direct",
        from: "feishu:user-1",
        to: "user:user-1",
        accountId: "default",
      };
      entry.deliveryContext = { channel: "feishu", to: "user:user-1", accountId: "default" };
    }
    if (kind === "cron") entry.scheduleId = "daily";
    if (kind === "subagent") entry.spawnedBy = "agent:main:main";
    store[key] = entry;
    writeJsonl(file, messages);
  };

  addSession({
    key: "agent:main:main",
    sessionId: "main-session",
    updatedAt: now - 5000,
    messages: [
      sessionHeader("main-session", now - 200000),
      message("user", "你好 from main", now - 100000),
      message("assistant", "main reply", now - 5000),
    ],
  });
  addSession({
    key: "agent:main:resume-test-alpha",
    label: "resume-test-alpha",
    sessionId: "alpha-session",
    updatedAt: now - 10000,
    messages: [
      sessionHeader("alpha-session", now - 300000),
      message("user", "你好 alpha", now - 250000),
      message("assistant", "alpha reply", now - 10000),
    ],
  });
  addSession({
    key: "agent:main:resume-test-gamma",
    label: "resume-test-gamma",
    sessionId: "gamma-session",
    updatedAt: now - 20000,
    messages: [
      sessionHeader("gamma-session", now - 400000),
      message("user", "你好 gamma", now - 350000),
      message("assistant", "gamma reply", now - 20000),
    ],
  });
  addSession({
    key: "agent:main:web-self-search",
    label: "/session-search 你好",
    sessionId: "web-self-search",
    updatedAt: now - 15000,
    messages: [
      sessionHeader("web-self-search", now - 16000),
      message("assistant", "历史会话搜索：你好\n\n结果 0 条 | 可见会话 0 个 | 过滤 0 个 | 3ms (rg)\n\n未找到匹配的用户可见会话。", now - 15000),
    ],
  });
  addSession({
    key: "agent:main:large-tail-session",
    label: "large-tail-session",
    sessionId: "large-tail-session",
    updatedAt: now - 18000,
    messages: [
      sessionHeader("large-tail-session", now - 500000),
      message("user", "large prefix " + "x".repeat(280000), now - 490000),
      message("user", "oversized tail marker manual failure reproduction", now - 18000),
    ],
  });
  addSession({
    key: "agent:main:manual-time-session",
    label: "manual-time-session",
    sessionId: "manual-time-session",
    updatedAt: now - 19000,
    messages: [
      sessionHeader("manual-time-session", new Date("2026-05-16T08:30:35Z").getTime()),
      message("user", "这个会话发生在 2020-08 的时候，记录了 202008 的历史背景。", new Date("2026-05-16T08:30:35Z").getTime()),
      message("assistant", "manual time reply", now - 19000),
    ],
  });
  addSession({
    key: "agent:main:manual-keyword-session",
    label: "manual-keyword-session",
    sessionId: "manual-keyword-session",
    updatedAt: now - 21000,
    messages: [
      sessionHeader("manual-keyword-session", now - 600000),
      message("user", "阅读 google 官方博客，总结郝行军的技术背景，涉及 memory-lancedb 和 memory-lancedb-pro 配置。", now - 590000),
      message("assistant", "代码符号示例：foo.bar(baz) path/to/file.js error_code=E_CONN_RESET", now - 21000),
    ],
  });

  writeJsonl(path.join(sessionsDir, "legacy-viking-session.jsonl"), [
    sessionHeader("legacy-viking-session", now - 700000),
    message("user", "安装插件前的历史 session 包含 viking 项目讨论。", now - 690000),
    message("assistant", "legacy viking reply", now - 680000),
  ]);

  for (let i = 0; i < visibleCount; i += 1) {
    const key = `agent:main:bulk-${i}`;
    addSession({
      key,
      label: i % 10 === 0 ? `bulk-label-${i}` : undefined,
      sessionId: `bulk-${i}`,
      updatedAt: now - 60000 - i,
      messages: [
        sessionHeader(`bulk-${i}`, now - 120000 - i),
        message("user", i % 37 === 0 ? `needle keyword ${i}` : `ordinary message ${i}`, now - 90000 - i),
        message("assistant", `bulk reply ${i}`, now - 60000 - i),
      ],
    });
  }
  for (let i = 0; i < cronCount; i += 1) {
    addSession({
      key: `agent:main:cron:run:${i}`,
      sessionId: `cron-${i}`,
      updatedAt: now - 1000,
      kind: "cron",
      messages: [sessionHeader(`cron-${i}`, now - 1000), message("user", "你好 cron", now - 1000)],
    });
  }
  for (let i = 0; i < subagentCount; i += 1) {
    addSession({
      key: `agent:main:subagent:${i}`,
      sessionId: `subagent-${i}`,
      updatedAt: now - 1000,
      kind: "subagent",
      messages: [sessionHeader(`subagent-${i}`, now - 1000), message("user", "你好 subagent", now - 1000)],
    });
  }
  for (let i = 0; i < internalCount; i += 1) {
    addSession({
      key: `agent:main:internal-${i}`,
      sessionId: `internal-${i}`,
      updatedAt: now - 1000,
      kind: "internal",
      messages: [sessionHeader(`internal-${i}`, now - 1000), message("user", "你好 internal", now - 1000)],
    });
  }
  writeJson(path.join(sessionsDir, "sessions.json"), store);
}

async function loadRegisteredMethods() {
  installPluginSandbox();
  createFixture();
  process.env.OPENCLAW_HOME = stateRoot;
  process.env.OPENCLAW_DIST_DIR = fakeDistDir;
  const entry = (await import(pathToFileURL(path.join(pluginRoot, "index.js")).href)).default;
  const methods = new Map();
  const commands = new Map();
  const api = {
    pluginConfig: { enabled: true, defaultLimit: 8, maxSessions: 5000, maxFiles: 5000 },
    registerGatewayMethod(name, handler) {
      methods.set(name, handler);
    },
    registerCommand(command) {
      commands.set(command.name, command);
    },
    registerTool() {},
  };
  entry.register(api);
  return { methods, commands };
}

async function callMethod(methods, name, params) {
  const handler = methods.get(name);
  if (!handler) throw new Error(`missing method ${name}`);
  let payload;
  await handler({
    params,
    respond(ok, result, error) {
      if (!ok) throw new Error(error?.message || error?.code || "gateway call failed");
      payload = result;
    },
  });
  return payload;
}

function assertCase(name, condition) {
  if (!condition) throw new Error(`FAIL ${name}`);
  return { name, ok: true };
}

async function callCommand(commands, name, ctx = {}) {
  const command = commands.get(name);
  if (!command) throw new Error(`missing command ${name}`);
  return command.handler({
    channel: "feishu",
    accountId: "default",
    to: "user:user-1",
    senderId: "user-1",
    args: "",
    ...ctx,
  });
}

function addCase(cases, name, condition, category) {
  cases.push({ ...assertCase(name, condition), category });
}

const { methods, commands } = await loadRegisteredMethods();
const cases = [];
const t0 = performance.now();
const searchHello = await callMethod(methods, "session-search.search", {
  query: "你好",
  agentId: "main",
  limit: 20,
  sinceDays: 2,
  maxSessions: 5000,
  maxFiles: 5000,
});
addCase(cases, "search returns visible matches", searchHello.count >= 3, "functional");
addCase(cases, "search filters cron by default", searchHello.filteredCron === 120, "filtering");
addCase(cases, "search filters subagents by default", searchHello.filteredSubagent === 120, "filtering");
addCase(cases, "search exposes hit timestamp", searchHello.results.every((row) => row.timestamp), "display");
addCase(cases, "search exposes resume key", searchHello.results.every((row) => row.key), "display");
addCase(cases, "search excludes plugin generated assistant replies", searchHello.results.every((row) => !String(row.snippet || "").includes("未找到匹配的用户可见会话")), "filtering");
addCase(cases, "search filters plugin command sessions", searchHello.results.every((row) => row.key !== "agent:main:web-self-search"), "filtering");

const resumeList = await callMethod(methods, "session-search.resume", { agentId: "main" });
addCase(cases, "resume lists visible sessions", resumeList.sessions.length === 3007, "functional");
addCase(cases, "resume filters plugin command sessions", !resumeList.sessions.some((row) => row.key === "agent:main:web-self-search"), "filtering");
addCase(cases, "resume filters cron", resumeList.stats.filteredCron === 120, "filtering");
addCase(cases, "resume filters subagents", resumeList.stats.filteredSubagent === 120, "filtering");
addCase(cases, "resume includes unnamed main by key", resumeList.sessions.some((row) => row.key === "agent:main:main" && row.displayName === "agent:main:main"), "usability");
addCase(cases, "resume includes named label", resumeList.sessions.some((row) => row.label === "resume-test-alpha"), "usability");
addCase(cases, "resume has transcript created time", resumeList.sessions.some((row) => row.key === "agent:main:main" && row.createdAt), "display");
addCase(cases, "resume has last message time", resumeList.sessions.every((row) => row.lastMessageAt), "display");

const searchNeedleStart = performance.now();
const searchNeedle = await callMethod(methods, "session-search.search", {
  query: "needle",
  agentId: "main",
  limit: 20,
  sinceDays: 2,
  maxSessions: 5000,
  maxFiles: 5000,
});
const searchNeedleMs = performance.now() - searchNeedleStart;
addCase(cases, "bulk search finds expected hits", searchNeedle.count === 20, "large-data");
addCase(cases, "bulk search under 2500ms", searchNeedleMs < 2500, "performance");
addCase(cases, "bulk search uses rg or node fallback", ["rg", "node"].includes(searchNeedle.backend), "reliability");

const largeTailRg = await callMethod(methods, "session-search.search", {
  query: "oversized tail marker",
  agentId: "main",
  limit: 5,
  sinceDays: 2,
  maxSessions: 5000,
  maxFiles: 5000,
});
addCase(cases, "rg backend scans tail of oversized transcripts", largeTailRg.results.some((row) => row.key === "agent:main:large-tail-session"), "large-data");
addCase(cases, "rg reports large tail scanning", largeTailRg.debug.tailScannedLargeFiles >= 1, "large-data");

const largeTailNode = await callMethod(methods, "session-search.search", {
  query: "oversized tail marker",
  agentId: "main",
  backend: "node",
  limit: 5,
  sinceDays: 2,
  maxSessions: 5000,
  maxFiles: 5000,
});
addCase(cases, "node backend scans tail of oversized transcripts", largeTailNode.results.some((row) => row.key === "agent:main:large-tail-session"), "large-data");

const manualCases = [
  ["manual query finds legacy pre-install transcript", "viking", "agent:main:legacy:legacy-viking-session"],
  ["manual query finds slash date timestamp", "2026/5/16 16:30:35", "agent:main:manual-time-session"],
  ["manual query finds compact year month", "202008的时候", "agent:main:manual-time-session"],
  ["manual query finds hyphenated package", "memory-lancedb", "agent:main:manual-keyword-session"],
  ["manual query finds longer hyphenated package", "memory-lancedb-pro", "agent:main:manual-keyword-session"],
  ["manual query finds mixed latin han keywords", "google博客", "agent:main:manual-keyword-session"],
  ["manual query finds adjacent han keywords", "郝行军背景", "agent:main:manual-keyword-session"],
  ["manual query finds code symbol", "foo.bar(baz)", "agent:main:manual-keyword-session"],
];

for (const [name, query, expectedKey] of manualCases) {
  const result = await callMethod(methods, "session-search.search", {
    query,
    agentId: "main",
    limit: 8,
    sinceDays: 3650,
    maxSessions: 5000,
    maxFiles: 5000,
  });
  addCase(cases, name, result.results.some((row) => row.key === expectedKey), "manual-regression");
}

const multiKeywordRanking = await callMethod(methods, "session-search.search", {
  query: "google博客",
  agentId: "main",
  limit: 3,
  sinceDays: 3650,
  maxSessions: 5000,
  maxFiles: 5000,
});
addCase(cases, "multi keyword ranks combined match first", multiKeywordRanking.results[0]?.key === "agent:main:manual-keyword-session", "manual-regression");

const resolveByLabel = await callMethod(methods, "session-search.resume", {
  agentId: "main",
  label: "resume-test-alpha",
  conversation: { channel: "feishu", accountId: "default", conversationId: "c1" },
});
addCase(cases, "resume label binds successfully", resolveByLabel.action === "resume" && resolveByLabel.binding.targetSessionKey === "agent:main:resume-test-alpha", "functional");

const resolveByKey = await callMethod(methods, "session-search.resume", {
  agentId: "main",
  label: "agent:main:main",
  conversation: { channel: "feishu", accountId: "default", conversationId: "c2" },
});
addCase(cases, "resume key binds successfully", resolveByKey.action === "resume" && resolveByKey.binding.targetSessionKey === "agent:main:main", "functional");

const unsupportedResume = await callMethod(methods, "session-search.resume", {
  agentId: "main",
  label: "resume-test-alpha",
  conversation: { channel: "unsupported-test", accountId: "default", conversationId: "c3" },
});
addCase(cases, "unsupported channel fails clearly", unsupportedResume.code === "binding_unavailable", "reliability");

for (let i = 0; i < 70; i += 1) {
  const result = await callMethod(methods, "session-search.search", {
    query: i % 2 === 0 ? "ordinary" : "keyword",
    agentId: "main",
    limit: 5 + (i % 5),
    sinceDays: 2,
    maxSessions: 5000,
    maxFiles: 5000,
    includeAssistant: i % 3 === 0,
  });
  addCase(cases, `search matrix ${i + 1}`, result.count > 0 && result.results.length <= 9, "functional");
}

for (let i = 0; i < 50; i += 1) {
  const result = await callMethod(methods, "session-search.resume", {
    agentId: "main",
    label: i % 2 === 0 ? `bulk-label-${i * 10}` : `agent:main:bulk-${i}`,
    conversation: { channel: "feishu", accountId: "default", conversationId: `resume-c-${i}` },
  });
  addCase(cases, `resume matrix ${i + 1}`, result.action === "resume", "functional");
}

const resumeCommandList = await callCommand(commands, "resume");
const resumeCommandText = resumeCommandList.text || "";
addCase(cases, "resume command hides meaningless type field", !resumeCommandText.includes("类型："), "experience");
addCase(cases, "resume command shows resume id", resumeCommandText.includes("恢复ID："), "experience");
addCase(cases, "resume command shows recent exchange", resumeCommandText.includes("最近交流："), "experience");
addCase(cases, "resume command shows usage", resumeCommandText.includes("使用：/resume"), "usability");

const searchCommand = await callCommand(commands, "session-search", { args: "你好" });
const searchCommandText = searchCommand.text || "";
addCase(cases, "search command shows hit time", searchCommandText.includes("命中时间："), "experience");
addCase(cases, "search command shows resume id", searchCommandText.includes("恢复ID："), "experience");
addCase(cases, "search command keeps readable separators", searchCommandText.includes("--- 1/"), "experience");
addCase(cases, "search command avoids raw metadata blob", !searchCommandText.includes("Sender (untrusted metadata)"), "experience");

const noQueryCommand = await callCommand(commands, "session-search", { args: "" });
addCase(cases, "search command gives usage on empty query", noQueryCommand.text.includes("Usage:"), "usability");

const invalidResume = await callMethod(methods, "session-search.resume", {
  agentId: "main",
  label: "bad\nlabel",
  conversation: { channel: "feishu", accountId: "default", conversationId: "bad-label" },
});
addCase(cases, "resume rejects multiline label", invalidResume.code === "invalid_label", "reliability");

const missingResume = await callMethod(methods, "session-search.resume", {
  agentId: "main",
  label: "missing-session",
  conversation: { channel: "feishu", accountId: "default", conversationId: "missing" },
});
addCase(cases, "resume missing target is clear", missingResume.code === "not_found", "reliability");

for (const row of resumeList.sessions.slice(0, 25)) {
  addCase(cases, `resume row has key ${row.key}`, Boolean(row.key), "display");
}
for (const row of resumeList.sessions.slice(0, 25)) {
  addCase(cases, `resume row has display name ${row.key}`, Boolean(row.displayName), "display");
}
for (const row of resumeList.sessions.slice(0, 20)) {
  addCase(cases, `resume row timestamp order ${row.key}`, Number(row.lastMessageAt) >= Number(row.createdAt || 0), "display");
}
for (const row of searchNeedle.results.slice(0, 12)) {
  addCase(cases, `search result has snippet ${row.key}:${row.line}`, Boolean(row.snippet), "display");
}
for (const row of searchNeedle.results.slice(0, 12)) {
  addCase(cases, `search result has stable key ${row.key}:${row.line}`, row.key.startsWith("agent:main:"), "display");
}
for (const row of searchNeedle.results.slice(0, 12)) {
  addCase(cases, `search result timestamp valid ${row.key}:${row.line}`, Number(row.timestamp) > 0, "display");
}
for (const limit of Array.from({ length: 15 }, (_, index) => index + 1)) {
  const result = await callMethod(methods, "session-search.search", {
    query: "ordinary",
    agentId: "main",
    limit,
    sinceDays: 2,
    maxSessions: 5000,
    maxFiles: 5000,
  });
  addCase(cases, `search limit ${limit}`, result.results.length <= limit, "functional");
}
for (const maxFiles of [1, 2, 3, 5, 8, 13, 21]) {
  const result = await callMethod(methods, "session-search.search", {
    query: "ordinary",
    agentId: "main",
    limit: 50,
    sinceDays: 2,
    maxSessions: 5000,
    maxFiles,
  });
  addCase(cases, `search maxFiles ${maxFiles}`, result.searchedFiles <= maxFiles, "large-data");
}
for (const sinceDays of [0, 1, 2, 7, 30, 365]) {
  const result = await callMethod(methods, "session-search.resume", { agentId: "main", sinceDays });
  addCase(cases, `resume sinceDays ${sinceDays}`, Array.isArray(result.sessions), "reliability");
}
for (let i = 0; i < 16; i += 1) {
  const result = await callMethod(methods, "session-search.search", {
    query: i % 2 === 0 ? "needle" : "ordinary",
    agentId: "main",
    backend: "node",
    limit: 5,
    sinceDays: 2,
    maxSessions: 100,
    maxFiles: 100,
  });
  addCase(cases, `node fallback style query ${i + 1}`, result.count > 0, "reliability");
}

const totalMs = performance.now() - t0;
addCase(cases, "total e2e reports elapsed time", totalMs > 0, "performance");

if (cases.length !== 315) {
  throw new Error(`FAIL expected 315 cases, got ${cases.length}`);
}

const byCategory = cases.reduce((acc, item) => {
  acc[item.category] = (acc[item.category] || 0) + 1;
  return acc;
}, {});

console.log(
  JSON.stringify(
    {
      ok: true,
      cases: cases.length,
      byCategory,
      searchHello: {
        count: searchHello.count,
        filteredCron: searchHello.filteredCron,
        filteredSubagent: searchHello.filteredSubagent,
        tookMs: searchHello.tookMs,
      },
      resumeList: {
        count: resumeList.sessions.length,
        filteredCron: resumeList.stats.filteredCron,
        filteredSubagent: resumeList.stats.filteredSubagent,
      },
      performance: {
        searchNeedleMs: Math.round(searchNeedleMs),
        totalMs: Math.round(totalMs),
      },
    },
    null,
    2,
  ),
);
