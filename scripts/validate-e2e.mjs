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
}

function createFixture() {
  const now = Date.now();
  const store = {};
  const visibleCount = 900;
  const cronCount = 40;
  const subagentCount = 40;
  const internalCount = 20;

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
  const entry = (await import(pathToFileURL(path.join(pluginRoot, "index.js")).href)).default;
  const methods = new Map();
  const commands = new Map();
  const api = {
    pluginConfig: { enabled: true, defaultLimit: 8, maxSessions: 2000, maxFiles: 2000 },
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

const { methods } = await loadRegisteredMethods();
const cases = [];
const t0 = performance.now();
const searchHello = await callMethod(methods, "session-search.search", {
  query: "你好",
  agentId: "main",
  limit: 20,
  sinceDays: 2,
  maxSessions: 2000,
  maxFiles: 2000,
});
cases.push(assertCase("search returns visible matches", searchHello.count >= 3));
cases.push(assertCase("search filters cron by default", searchHello.filteredCron === 40));
cases.push(assertCase("search filters subagents by default", searchHello.filteredSubagent === 40));
cases.push(assertCase("search exposes hit timestamp", searchHello.results.every((row) => row.timestamp)));
cases.push(assertCase("search exposes resume key", searchHello.results.every((row) => row.key)));

const resumeList = await callMethod(methods, "session-search.resume", { agentId: "main" });
cases.push(assertCase("resume lists visible sessions", resumeList.sessions.length === 903));
cases.push(assertCase("resume filters cron", resumeList.stats.filteredCron === 40));
cases.push(assertCase("resume filters subagents", resumeList.stats.filteredSubagent === 40));
cases.push(assertCase("resume includes unnamed main by key", resumeList.sessions.some((row) => row.key === "agent:main:main" && row.displayName === "agent:main:main")));
cases.push(assertCase("resume includes named label", resumeList.sessions.some((row) => row.label === "resume-test-alpha")));
cases.push(assertCase("resume has transcript created time", resumeList.sessions.some((row) => row.key === "agent:main:main" && row.createdAt)));
cases.push(assertCase("resume has last message time", resumeList.sessions.every((row) => row.lastMessageAt)));

const searchNeedleStart = performance.now();
const searchNeedle = await callMethod(methods, "session-search.search", {
  query: "needle",
  agentId: "main",
  limit: 20,
  sinceDays: 2,
  maxSessions: 2000,
  maxFiles: 2000,
});
const searchNeedleMs = performance.now() - searchNeedleStart;
cases.push(assertCase("bulk search finds expected hits", searchNeedle.count === 20));
cases.push(assertCase("bulk search under 1500ms", searchNeedleMs < 1500));
cases.push(assertCase("bulk search uses rg or node fallback", ["rg", "node"].includes(searchNeedle.backend)));

const resolveByLabel = await callMethod(methods, "session-search.resume", {
  agentId: "main",
  label: "resume-test-alpha",
  conversation: { channel: "unsupported-test", accountId: "default", conversationId: "c1" },
});
cases.push(assertCase("resume label resolves before binding", resolveByLabel.code === "binding_unavailable"));

const resolveByKey = await callMethod(methods, "session-search.resume", {
  agentId: "main",
  label: "agent:main:main",
  conversation: { channel: "unsupported-test", accountId: "default", conversationId: "c1" },
});
cases.push(assertCase("resume key resolves before binding", resolveByKey.code === "binding_unavailable"));

for (let i = 0; i < 28; i += 1) {
  const result = await callMethod(methods, "session-search.search", {
    query: i % 2 === 0 ? "ordinary" : "keyword",
    agentId: "main",
    limit: 5 + (i % 5),
    sinceDays: 2,
    maxSessions: 2000,
    maxFiles: 2000,
    includeAssistant: i % 3 === 0,
  });
  cases.push(assertCase(`search matrix ${i + 1}`, result.count > 0 && result.results.length <= 9));
}

for (let i = 0; i < 14; i += 1) {
  const result = await callMethod(methods, "session-search.resume", {
    agentId: "main",
    label: i % 2 === 0 ? `bulk-label-${i * 10}` : `agent:main:bulk-${i}`,
    conversation: { channel: "unsupported-test", accountId: "default", conversationId: `c-${i}` },
  });
  cases.push(assertCase(`resume matrix ${i + 1}`, result.code === "binding_unavailable"));
}

const totalMs = performance.now() - t0;
cases.push(assertCase("total e2e under 6000ms", totalMs < 6000));

console.log(
  JSON.stringify(
    {
      ok: true,
      cases: cases.length,
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
