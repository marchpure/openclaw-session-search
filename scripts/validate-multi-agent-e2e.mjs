import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-search-multi-agent-"));
const pluginRoot = path.join(workRoot, "plugin");
const stateRoot = path.join(workRoot, "state");
const fakeDistDir = path.join(workRoot, "dist");
const AGENTS = ["a-mpgtowbf5xplok", "ai-2222", "ai-3333", "main"];
const SCOPED_LABEL_AGENT = "a-mpgtowbf5xplok";
const SCOPED_LABEL_SESSION_NAME = "web-23771cfd-cf5a-49e8-aca3-4dc20098250c";
const SCOPED_LABEL_TITLE = "沪市今天的指数";
const TARGET_CASES = 1000;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function message(role, text, timestamp) {
  return { type: "message", timestamp: new Date(timestamp).toISOString(), message: { role, content: [{ type: "text", text }], timestamp } };
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
  fs.writeFileSync(path.join(fakeDistDir, "session-binding-service-multi.js"), "export function getSessionBindingService() { return null; }\n");
}

function sessionsDir(agentId) {
  return path.join(stateRoot, "agents", agentId, "sessions");
}

function addSession(store, dir, agentId, name, { label, text, updatedAt, kind = "visible" }) {
  const sessionId = `${agentId}-${name}`;
  const key = `agent:${agentId}:${name}`;
  const sessionFile = path.join(dir, `${sessionId}.jsonl`);
  const entry = { sessionId, sessionFile, updatedAt, ...(label ? { label } : {}) };
  if (kind === "visible") {
    Object.assign(entry, {
      chatType: "direct",
      lastChannel: "feishu",
      origin: { provider: "feishu", surface: "feishu", chatType: "direct" },
      deliveryContext: { channel: "feishu" },
    });
  }
  if (kind === "cron") entry.scheduleId = "daily";
  if (kind === "subagent") entry.spawnedBy = `agent:${agentId}:parent`;
  store[key] = entry;
  writeJsonl(sessionFile, [
    sessionHeader(sessionId, updatedAt - 10000),
    message("user", text, updatedAt - 9000),
    message("assistant", `reply ${agentId}/${name} project-x repeated-summary`, updatedAt),
  ]);
}

function createFixture() {
  const now = Date.now();
  writeJson(path.join(stateRoot, "openclaw.json"), {
    agents: { list: AGENTS.map((id) => ({ id, name: id === "main" ? "Main Agent" : `Agent ${id}` })) },
  });
  for (const agentId of AGENTS) {
    const dir = sessionsDir(agentId);
    fs.mkdirSync(dir, { recursive: true });
    const store = {};
    for (let i = 0; i < 20; i += 1) {
      addSession(store, dir, agentId, `project-x-${i}`, {
        label: `Project X ${agentId} session ${i}`,
        text: [
          `project-x shared-topic ${agentId} session-${i}`,
          i % 2 === 0 ? "memory-lancedb" : "google博客",
          i % 3 === 0 ? "foo.bar(baz)" : "2026/5/16 16:30:35",
          "repeated-summary",
        ].join(" "),
        updatedAt: now - i * 1000,
      });
    }
    for (let i = 0; i < 5; i += 1) {
      addSession(store, dir, agentId, `unique-decision-${i}`, {
        label: `Unique decision ${agentId} ${i}`,
        text: `unique-decision-${agentId}-${i} final owner=${agentId} risk=${i % 2 === 0 ? "medium" : "low"}`,
        updatedAt: now - 30000 - i,
      });
    }
    for (let i = 0; i < 4; i += 1) {
      addSession(store, dir, agentId, `cron-hidden-${i}`, {
        label: `cron hidden ${i}`,
        text: "project-x hidden cron should not surface",
        updatedAt: now - i,
        kind: "cron",
      });
      addSession(store, dir, agentId, `subagent-hidden-${i}`, {
        label: `subagent hidden ${i}`,
        text: "project-x hidden subagent should not surface",
        updatedAt: now - i,
        kind: "subagent",
      });
    }
    addSession(store, dir, agentId, "tool-hidden", {
      label: "/session-search project-x",
      text: "历史会话搜索：project-x",
      updatedAt: now,
    });
    if (agentId === SCOPED_LABEL_AGENT) {
      addSession(store, dir, agentId, SCOPED_LABEL_SESSION_NAME, {
        label: `<agent:${agentId}:${SCOPED_LABEL_SESSION_NAME}>${SCOPED_LABEL_TITLE}`,
        text: `${SCOPED_LABEL_TITLE} project-x market summary`,
        updatedAt: now + 1000,
      });
    }
    writeJson(path.join(dir, "sessions.json"), store);
  }
}

async function loadMethods() {
  installPluginSandbox();
  createFixture();
  process.env.OPENCLAW_HOME = stateRoot;
  process.env.OPENCLAW_DIST_DIR = fakeDistDir;
  const entry = (await import(pathToFileURL(path.join(pluginRoot, "index.js")).href)).default;
  const methods = new Map();
  entry.register({
    pluginConfig: { enabled: true, defaultLimit: 8, maxSessions: 1000, maxFiles: 1000 },
    registerGatewayMethod(name, handler) {
      methods.set(name, handler);
    },
    registerCommand() {},
    registerTool() {},
  });
  return methods;
}

async function callMethod(methods, name, params) {
  let payload;
  await methods.get(name)({
    params,
    respond(ok, result, error) {
      if (!ok) throw new Error(error?.message || error?.code || "gateway call failed");
      payload = result;
    },
  });
  return payload;
}

function assertCase(cases, category, name, condition, details = {}) {
  if (!condition) throw new Error(`FAIL ${category}: ${name} ${JSON.stringify(details)}`);
  cases.push({ category, name });
}

function uniqueSessionKeys(results) {
  return Array.from(new Set(results.map((row) => row.key)));
}

function groupByAgent(results) {
  return results.reduce((acc, row) => {
    const agentId = row.key.split(":")[1] || "unknown";
    acc[agentId] = acc[agentId] || [];
    acc[agentId].push(row);
    return acc;
  }, {});
}

const methods = await loadMethods();
const cases = [];
const timings = [];
const started = performance.now();
const querySet = [
  "project-x",
  "shared-topic",
  "memory-lancedb",
  "google博客",
  "foo.bar(baz)",
  "2026/5/16 16:30:35",
  "repeated-summary",
  "risk=medium",
  "unique-decision",
  "不存在的查询词火星水星木星",
];

for (let i = 0; i < TARGET_CASES; i += 1) {
  const agentId = AGENTS[i % AGENTS.length];
  const query = querySet[i % querySet.length];
  const t0 = performance.now();
  const result = await callMethod(methods, "session-search.search", {
    query,
    agentId,
    limit: 50,
    sinceDays: 3650,
    maxSessions: 1000,
    maxFiles: 1000,
  });
  timings.push(performance.now() - t0);
  if (query === "不存在的查询词火星水星木星") {
    assertCase(cases, "functional", `no-result ${i}`, result.count === 0 && result.results.length === 0 && !Object.hasOwn(result, "sessionGroups"), result);
    continue;
  }
  assertCase(cases, "functional", `results stay in requested agent ${i}`, result.results.every((row) => row.key.startsWith(`agent:${agentId}:`)), result.results.slice(0, 3));
  assertCase(cases, "filtering", `hidden filtered ${i}`, result.filteredCron === 4 && result.filteredSubagent === 4 && result.filteredTool === 1, result);
  assertCase(cases, "experience", `results are deduped ${i}`, uniqueSessionKeys(result.results).length === result.results.length, {
    count: result.count,
    results: result.results.length,
  });
  assertCase(cases, "experience", `result shape ${i}`, result.results.every((row) => row.key && row.sessionId && row.agentName && row.snippet && row.hitCount >= 1 && Array.isArray(row.hits)), result.results[0]);
  if (query === "project-x" || query === "shared-topic" || query === "repeated-summary") {
    assertCase(cases, "functional", `many sessions found ${i}`, uniqueSessionKeys(result.results).length >= 10, { query, count: result.count });
  }
}

const crossAgentHits = [];
for (const agentId of AGENTS) {
  const result = await callMethod(methods, "session-search.search", {
    query: "project-x",
    agentId,
    limit: 50,
    sinceDays: 3650,
    maxSessions: 1000,
    maxFiles: 1000,
  });
  crossAgentHits.push(...result.results);
}
const grouped = groupByAgent(crossAgentHits);
assertCase(cases, "cross-agent", "four agent groups present", Object.keys(grouped).length === 4, grouped);
assertCase(cases, "cross-agent", "each group has at least ten sessions", Object.values(grouped).every((rows) => uniqueSessionKeys(rows).length >= 10), grouped);

const allAgentResult = await callMethod(methods, "session-search.search", {
  query: "project-x",
  limit: 50,
  sinceDays: 3650,
  maxSessions: 1000,
  maxFiles: 1000,
});
assertCase(cases, "cross-agent", "default search covers configured agents", allAgentResult.agentsSearched.length === AGENTS.length, allAgentResult);
assertCase(
  cases,
  "cross-agent",
  "all-agent keys keep original session key",
  allAgentResult.results.every((row) => row.key.startsWith(`agent:${row.agentId}:`) && !row.key.startsWith(`${row.agentId}:`)),
  allAgentResult.results.slice(0, 3),
);
assertCase(
  cases,
  "cross-agent",
  "all-agent result does not add scoped key",
  allAgentResult.results.every((row) => !Object.hasOwn(row, "agentScopedKey")),
  allAgentResult.results.slice(0, 3),
);

const scopedLabelKey = `agent:${SCOPED_LABEL_AGENT}:${SCOPED_LABEL_SESSION_NAME}`;
const scopedLabelResult = await callMethod(methods, "session-search.search", {
  query: SCOPED_LABEL_TITLE,
  limit: 5,
  sinceDays: 3650,
  maxSessions: 1000,
  maxFiles: 1000,
});
const scopedLabelRow = scopedLabelResult.results.find((row) => row.key === scopedLabelKey);
assertCase(cases, "cross-agent", "scoped label result keeps original key", scopedLabelRow?.key === scopedLabelKey, scopedLabelResult.results);
assertCase(cases, "experience", "scoped label display strips agent wrapper", scopedLabelRow?.displayName === SCOPED_LABEL_TITLE, scopedLabelRow);
assertCase(cases, "experience", "scoped label exposes title", scopedLabelRow?.title === SCOPED_LABEL_TITLE, scopedLabelRow);
assertCase(cases, "experience", "all-agent omits legacy sessionGroups", !Object.hasOwn(allAgentResult, "sessionGroups") && !Object.hasOwn(allAgentResult, "sessionGroupCount"), allAgentResult);

const sortedTimings = [...timings].sort((a, b) => a - b);
const percentile = (p) => Math.round(sortedTimings[Math.min(sortedTimings.length - 1, Math.floor(sortedTimings.length * p))] || 0);
const totalMs = performance.now() - started;
const byCategory = cases.reduce((acc, item) => {
  acc[item.category] = (acc[item.category] || 0) + 1;
  return acc;
}, {});

console.log(
  JSON.stringify(
    {
      ok: true,
      workRoot,
      queryCases: TARGET_CASES,
      assertions: cases.length,
      byCategory,
      agents: AGENTS,
      performance: {
        totalMs: Math.round(totalMs),
        avgMs: Math.round(timings.reduce((sum, item) => sum + item, 0) / timings.length),
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        maxMs: Math.round(sortedTimings.at(-1) || 0),
      },
      recommendedUx: "Render the results array directly. Use title, agentName, snippet, hits.context, metadataMatches, and key/sessionId for navigation.",
    },
    null,
    2,
  ),
);
