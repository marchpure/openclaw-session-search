import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-search-30x-"));
const pluginRoot = path.join(workRoot, "plugin");
const stateRoot = path.join(workRoot, "state");
const sessionsDir = path.join(stateRoot, "agents", "main", "sessions");
const fakeDistDir = path.join(workRoot, "dist");
const QUERY_CASES = intArg("cases", 3000);

function intArg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  const value = hit ? Number(hit.slice(prefix.length)) : fallback;
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

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
  fs.writeFileSync(
    path.join(fakeDistDir, "session-binding-service-30x.js"),
    "export function getSessionBindingService() { return null; }\n",
  );
}

function addVisibleSession(store, { key, label, sessionId, updatedAt, rows, extra = {} }) {
  const file = path.join(sessionsDir, `${sessionId}.jsonl`);
  store[key] = {
    sessionId,
    sessionFile: file,
    updatedAt,
    ...(label ? { label } : {}),
    chatType: "direct",
    lastChannel: "feishu",
    origin: { provider: "feishu", surface: "feishu", chatType: "direct" },
    deliveryContext: { channel: "feishu" },
    ...extra,
  };
  writeJsonl(file, rows);
}

function createFixture() {
  const now = Date.now();
  const store = {};
  const manualTime = new Date("2026-05-16T08:30:35Z").getTime();
  addVisibleSession(store, {
    key: "agent:main:title-alpha",
    label: "Resume Test Alpha Project",
    sessionId: "title-alpha",
    updatedAt: now - 1000,
    rows: [
      sessionHeader("title-alpha", now - 100000),
      message("user", "title body needle keyword ordinary message", now - 90000),
      message("assistant", "main reply with OpenClaw session search", now - 1000),
    ],
  });
  addVisibleSession(store, {
    key: "agent:main:manual-keyword-session",
    label: "manual keyword code symbols",
    sessionId: "manual-keyword-session",
    updatedAt: now - 2000,
    rows: [
      sessionHeader("manual-keyword-session", now - 200000),
      message("user", "阅读 google 官方博客，总结郝行军的技术背景，涉及 memory-lancedb 和 memory-lancedb-pro 配置。", now - 190000),
      message("assistant", "代码符号示例：foo.bar(baz) path/to/file.js error_code=E_CONN_RESET https://example.com/a-b?x=1", now - 2000),
    ],
  });
  addVisibleSession(store, {
    key: "agent:main:manual-time-session",
    label: "manual time session",
    sessionId: "manual-time-session",
    updatedAt: now - 3000,
    rows: [
      sessionHeader("manual-time-session", manualTime),
      message("user", "这个会话发生在 2020-08 的时候，记录了 202008 的历史背景。", manualTime),
      message("assistant", "ISO time 2026-05-16T16:30:35+08:00", now - 3000),
    ],
  });
  addVisibleSession(store, {
    key: "agent:main:large-tail-session",
    label: "large tail session",
    sessionId: "large-tail-session",
    updatedAt: now - 4000,
    rows: [
      sessionHeader("large-tail-session", now - 400000),
      message("user", `large prefix ${"x".repeat(280000)}`, now - 390000),
      message("user", "oversized tail marker manual failure reproduction", now - 4000),
    ],
  });
  store["agent:main:web-self-search"] = {
    sessionId: "web-self-search",
    sessionFile: path.join(sessionsDir, "web-self-search.jsonl"),
    updatedAt: now - 5000,
    label: "/session-search 你好",
    chatType: "direct",
    lastChannel: "feishu",
    origin: { provider: "feishu", surface: "feishu" },
    deliveryContext: { channel: "feishu" },
  };
  writeJsonl(store["agent:main:web-self-search"].sessionFile, [
    sessionHeader("web-self-search", now - 5000),
    message("assistant", "历史会话搜索：你好\n\n未找到匹配的用户可见会话。", now - 5000),
  ]);
  for (let i = 0; i < 60; i += 1) {
    store[`agent:main:cron:run:${i}`] = {
      sessionId: `cron-${i}`,
      sessionFile: path.join(sessionsDir, `cron-${i}.jsonl`),
      updatedAt: now - 1,
      scheduleId: "daily",
    };
    writeJsonl(store[`agent:main:cron:run:${i}`].sessionFile, [
      sessionHeader(`cron-${i}`, now - 1),
      message("user", "你好 cron hidden", now - 1),
    ]);
  }
  for (let i = 0; i < 60; i += 1) {
    store[`agent:main:subagent:${i}`] = {
      sessionId: `subagent-${i}`,
      sessionFile: path.join(sessionsDir, `subagent-${i}.jsonl`),
      updatedAt: now - 1,
      spawnedBy: "agent:main:title-alpha",
    };
    writeJsonl(store[`agent:main:subagent:${i}`].sessionFile, [
      sessionHeader(`subagent-${i}`, now - 1),
      message("user", "你好 subagent hidden", now - 1),
    ]);
  }
  writeJsonl(path.join(sessionsDir, "legacy-viking-session.jsonl"), [
    sessionHeader("legacy-viking-session", now - 500000),
    message("user", "安装插件前的历史 session 包含 viking 项目讨论。", now - 490000),
  ]);
  writeJson(path.join(sessionsDir, "sessions.json"), store);
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

const queryVariants = {
  title: [
    ["Resume Test Alpha Project", "agent:main:title-alpha"],
    ["resume test alpha", "agent:main:title-alpha"],
    ["TITLE-ALPHA", "agent:main:title-alpha"],
    ["title-alpha", "agent:main:title-alpha"],
    ["agent:main:title-alpha", "agent:main:title-alpha"],
  ],
  body: [
    ["needle keyword", "agent:main:title-alpha"],
    ["ordinary message", "agent:main:title-alpha"],
    ["OpenClaw session search", "agent:main:title-alpha"],
    ["main reply", "agent:main:title-alpha"],
    ["title body", "agent:main:title-alpha"],
  ],
  phrase: [
    ["oversized tail marker", "agent:main:large-tail-session"],
    ["manual failure reproduction", "agent:main:large-tail-session"],
    ["tail marker manual", "agent:main:large-tail-session"],
    ["large-tail-session", "agent:main:large-tail-session"],
    ["oversized", "agent:main:large-tail-session"],
  ],
  multi: [
    ["google博客", "agent:main:manual-keyword-session"],
    ["google 官方博客", "agent:main:manual-keyword-session"],
    ["郝行军背景", "agent:main:manual-keyword-session"],
    ["google 郝行军", "agent:main:manual-keyword-session"],
    ["博客 背景", "agent:main:manual-keyword-session"],
  ],
  entity: [
    ["郝行军", "agent:main:manual-keyword-session"],
    ["memory-lancedb", "agent:main:manual-keyword-session"],
    ["memory-lancedb-pro", "agent:main:manual-keyword-session"],
    ["manual keyword", "agent:main:manual-keyword-session"],
    ["E_CONN_RESET", "agent:main:manual-keyword-session"],
  ],
  symbol: [
    ["foo.bar(baz)", "agent:main:manual-keyword-session"],
    ["path/to/file.js", "agent:main:manual-keyword-session"],
    ["error_code=E_CONN_RESET", "agent:main:manual-keyword-session"],
    ["https://example.com/a-b?x=1", "agent:main:manual-keyword-session"],
    ["a-b?x=1", "agent:main:manual-keyword-session"],
  ],
  mixed: [
    ["OpenClaw会话", "agent:main:title-alpha"],
    ["google博客", "agent:main:manual-keyword-session"],
    ["memory-lancedb配置", "agent:main:manual-keyword-session"],
    ["ISO time", "agent:main:manual-time-session"],
    ["session检索", "agent:main:legacy:legacy-viking-session"],
  ],
  normalize: [
    ["Memory-LanceDB-Pro", "agent:main:manual-keyword-session"],
    ["memory_lancedb", "agent:main:manual-keyword-session"],
    ["2026-05-16", "agent:main:manual-time-session"],
    ["2026/5/16", "agent:main:manual-time-session"],
    ["E_CONN_RESET", "agent:main:manual-keyword-session"],
  ],
  time: [
    ["2026/5/16 16:30:35", "agent:main:manual-time-session"],
    ["20260516", "agent:main:manual-time-session"],
    ["202008的时候", "agent:main:manual-time-session"],
    ["2020-08", "agent:main:manual-time-session"],
    ["16:30:35", "agent:main:manual-time-session"],
  ],
  "no-result": [
    ["不存在的查询词_30x_zzzz", null],
    ["no-such-term-abcxyz", null],
    ["火星数据库不存在", null],
    ["99999999-not-found", null],
    ["完全没有命中", null],
  ],
  lifecycle: [
    ["viking", "agent:main:legacy:legacy-viking-session"],
    ["legacy-viking-session", "agent:main:legacy:legacy-viking-session"],
    ["安装插件前", "agent:main:legacy:legacy-viking-session"],
    ["历史 session", "agent:main:legacy:legacy-viking-session"],
    ["legacy", "agent:main:legacy:legacy-viking-session"],
  ],
  filtering: [
    ["你好", null],
    ["cron hidden", null],
    ["subagent hidden", null],
    ["/session-search 你好", null],
    ["未找到匹配的用户可见会话", null],
  ],
};

const methods = await loadMethods();
const cases = [];
const timings = [];
const started = performance.now();

const groupEntries = Object.entries(queryVariants);
const casesPerGroup = Math.ceil(QUERY_CASES / groupEntries.length);

for (const [category, variants] of groupEntries) {
  for (let i = 0; i < casesPerGroup; i += 1) {
    if (timings.length >= QUERY_CASES) break;
    const [query, expectedKey] = variants[i % variants.length];
    const params = {
      query,
      agentId: "main",
      limit: 10,
      sinceDays: 3650,
      maxSessions: 1000,
      maxFiles: 1000,
      includeAssistant: true,
    };
    const t0 = performance.now();
    const result = await callMethod(methods, "session-search.search", params);
    timings.push(performance.now() - t0);
    if (category === "no-result") {
      assertCase(cases, category, `${category} ${i + 1}`, result.count === 0, { query, count: result.count });
    } else if (category === "filtering") {
      assertCase(
        cases,
        category,
        `${category} ${i + 1}`,
        result.results.every((row) => !row.key.includes("cron") && !row.key.includes("subagent") && row.key !== "agent:main:web-self-search"),
        { query, results: result.results.map((row) => row.key) },
      );
    } else {
      assertCase(
        cases,
        category,
        `${category} ${i + 1}`,
        result.results.some((row) => row.key === expectedKey),
        { query, expectedKey, results: result.results.map((row) => row.key) },
      );
      assertCase(cases, `${category}-shape`, `${category} shape ${i + 1}`, result.results.every((row) => row.key && row.snippet), { query });
    }
  }
}

const totalMs = performance.now() - started;
const expectedShapeCases = groupEntries.reduce((sum, [category], index) => {
  const start = index * casesPerGroup;
  const count = Math.max(0, Math.min(casesPerGroup, QUERY_CASES - start));
  return category === "no-result" || category === "filtering" ? sum : sum + count;
}, 0);
const expectedCases = QUERY_CASES + expectedShapeCases;
if (cases.length !== expectedCases) {
  throw new Error(`expected ${expectedCases} assertions, got ${cases.length}`);
}

const byCategory = cases.reduce((acc, item) => {
  acc[item.category] = (acc[item.category] || 0) + 1;
  return acc;
}, {});
const sortedTimings = [...timings].sort((a, b) => a - b);
const percentile = (p) => Math.round(sortedTimings[Math.min(sortedTimings.length - 1, Math.floor(sortedTimings.length * p))] || 0);

console.log(
  JSON.stringify(
    {
      ok: true,
      workRoot,
      queryCases: QUERY_CASES,
      assertions: cases.length,
      byCategory,
      performance: {
        totalMs: Math.round(totalMs),
        avgMs: Math.round(timings.reduce((sum, item) => sum + item, 0) / timings.length),
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        maxMs: Math.round(sortedTimings.at(-1) || 0),
      },
    },
    null,
    2,
  ),
);
