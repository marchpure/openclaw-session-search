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
  fs.writeFileSync(
    path.join(pluginRoot, "node_modules", "openclaw", "plugin-sdk", "plugin-entry.js"),
    "export function definePluginEntry(entry) { return entry; }\n",
  );
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
    message("assistant", `reply ${agentId}/${name}`, updatedAt),
  ]);
}

function createFixture() {
  const now = Date.now();
  for (const agentId of ["ai-1111", "ai-2222", "main"]) {
    const dir = sessionsDir(agentId);
    fs.mkdirSync(dir, { recursive: true });
    const store = {};
    for (let i = 0; i < 8; i += 1) {
      addSession(store, dir, agentId, `project-x-${i}`, {
        label: `Project X ${agentId} session ${i}`,
        text: `project-x shared-topic ${agentId} session-${i} ${i % 2 === 0 ? "memory-lancedb" : "google博客"} repeated-summary`,
        updatedAt: now - i * 1000,
      });
    }
    addSession(store, dir, agentId, "unique-decision", {
      label: `Unique decision ${agentId}`,
      text: `unique-decision-${agentId} final owner=${agentId} risk=medium`,
      updatedAt: now - 20000,
    });
    addSession(store, dir, agentId, "cron-hidden", {
      label: "cron hidden",
      text: "project-x hidden cron should not surface",
      updatedAt: now,
      kind: "cron",
    });
    addSession(store, dir, agentId, "subagent-hidden", {
      label: "subagent hidden",
      text: "project-x hidden subagent should not surface",
      updatedAt: now,
      kind: "subagent",
    });
    addSession(store, dir, agentId, "tool-hidden", {
      label: "/session-search project-x",
      text: "历史会话搜索：project-x",
      updatedAt: now,
    });
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
    pluginConfig: { enabled: true, defaultLimit: 8, maxSessions: 500, maxFiles: 500 },
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

function groupByAgent(results) {
  return results.reduce((acc, row) => {
    const agentId = row.key.split(":")[1] || "unknown";
    acc[agentId] = acc[agentId] || [];
    acc[agentId].push(row);
    return acc;
  }, {});
}

function uniqueSessionKeys(results) {
  return Array.from(new Set(results.map((row) => row.key)));
}

function topSessionsByKey(results, limit) {
  const seen = new Set();
  const sessions = [];
  for (const row of results) {
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    sessions.push(row);
    if (sessions.length >= limit) break;
  }
  return sessions;
}

const methods = await loadMethods();
const cases = [];
const timings = [];
const started = performance.now();

for (const agentId of ["ai-1111", "ai-2222", "main"]) {
  const t0 = performance.now();
  const result = await callMethod(methods, "session-search.search", {
    query: "project-x",
    agentId,
    limit: 50,
    sinceDays: 3650,
    maxSessions: 500,
    maxFiles: 500,
  });
  timings.push(performance.now() - t0);
  assertCase(cases, "single-agent", `${agentId} returns many visible sessions`, uniqueSessionKeys(result.results).length === 8, { count: result.count });
  assertCase(cases, "single-agent", `${agentId} filters hidden classes`, result.filteredCron === 1 && result.filteredSubagent === 1 && result.filteredTool === 1, result);
  assertCase(cases, "single-agent", `${agentId} result keys stay in agent`, result.results.every((row) => row.key.startsWith(`agent:${agentId}:`)));
}

const crossAgentResults = [];
for (const agentId of ["ai-1111", "ai-2222", "main"]) {
  const result = await callMethod(methods, "session-search.search", {
    query: "project-x",
    agentId,
    limit: 50,
    sinceDays: 3650,
    maxSessions: 500,
    maxFiles: 500,
  });
  crossAgentResults.push(...result.results);
}
const grouped = groupByAgent(crossAgentResults);
assertCase(cases, "cross-agent", "cross agent aggregation has three groups", Object.keys(grouped).length === 3, grouped);
assertCase(cases, "cross-agent", "each agent group has eight unique sessions", Object.values(grouped).every((rows) => uniqueSessionKeys(rows).length === 8), grouped);

for (const agentId of ["ai-1111", "ai-2222", "main"]) {
  const result = await callMethod(methods, "session-search.search", {
    query: `unique-decision-${agentId}`,
    agentId,
    limit: 5,
    sinceDays: 3650,
    maxSessions: 500,
    maxFiles: 500,
  });
  assertCase(cases, "precision", `${agentId} unique query returns one session`, result.count === 1, result);
  assertCase(cases, "precision", `${agentId} unique query resolves expected key`, result.results[0]?.key === `agent:${agentId}:unique-decision`, result.results[0]);
}

const proposedAgentSummaries = Object.entries(grouped).map(([agentId, rows]) => ({
  agentId,
  totalHits: rows.length,
  totalSessions: uniqueSessionKeys(rows).length,
  topSessions: topSessionsByKey(rows, 3).map((row) => ({ key: row.key, label: row.label, snippet: row.snippet })),
  hiddenOverflow: Math.max(0, uniqueSessionKeys(rows).length - 3),
}));
assertCase(cases, "ux", "grouped summary caps top sessions per agent", proposedAgentSummaries.every((group) => group.topSessions.length <= 3), proposedAgentSummaries);
assertCase(cases, "ux", "grouped summary exposes overflow count", proposedAgentSummaries.every((group) => group.hiddenOverflow === 5), proposedAgentSummaries);

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
      assertions: cases.length,
      byCategory,
      proposedResultShape: {
        query: "project-x",
        groups: proposedAgentSummaries,
      },
      performance: {
        totalMs: Math.round(totalMs),
        avgSingleAgentMs: Math.round(timings.reduce((sum, item) => sum + item, 0) / timings.length),
      },
    },
    null,
    2,
  ),
);
