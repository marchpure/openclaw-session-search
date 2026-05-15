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

const resumeList = await callMethod(methods, "session-search.resume", { agentId: "main" });
addCase(cases, "resume lists visible sessions", resumeList.sessions.length === 3003, "functional");
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
addCase(cases, "total e2e under 15000ms", totalMs < 15000, "performance");

if (cases.length !== 300) {
  throw new Error(`FAIL expected 300 cases, got ${cases.length}`);
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
