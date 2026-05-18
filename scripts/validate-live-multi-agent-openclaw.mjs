import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || "/root/.openclaw";
const PROJECT_ROOT = path.join(OPENCLAW_HOME, ".arkclaw-team", "projects", "project-1");
const DEFAULT_CASES = 1000;
const AGENTS = ["ai-1111", "ai-2222", "ai-3333", "ai-4444", "ai-5555"];
const TOPIC_COUNT = 30;

function parseArgs() {
  const args = new Map();
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) args.set(match[1], match[2]);
  }
  return {
    cases: Math.max(1, Number.parseInt(args.get("cases") || `${DEFAULT_CASES}`, 10)),
    concurrency: Math.max(1, Number.parseInt(args.get("concurrency") || "10", 10)),
    agents: (args.get("agents") || AGENTS.join(","))
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
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
    cwd: "/root/live-openclaw-validation",
  };
}

function sessionsDir(agentId) {
  return path.join(OPENCLAW_HOME, "agents", agentId, "sessions");
}

function visibleSessionEntry(sessionId, sessionFile, label, updatedAt) {
  return {
    sessionId,
    sessionFile,
    updatedAt,
    label,
    chatType: "direct",
    lastChannel: "feishu",
    origin: { provider: "feishu", surface: "feishu", chatType: "direct" },
    deliveryContext: { channel: "feishu" },
  };
}

function hiddenSessionEntry(sessionId, sessionFile, label, updatedAt, kind) {
  const entry = { sessionId, sessionFile, updatedAt, label };
  if (kind === "cron") entry.scheduleId = "live-openclaw-daily";
  if (kind === "subagent") entry.spawnedBy = "agent:parent:live-openclaw";
  return entry;
}

async function runOpenClaw(args, options = {}) {
  const { stdout } = await execFileAsync("openclaw", args, {
    timeout: options.timeout || 120000,
    maxBuffer: 128 * 1024 * 1024,
  });
  return stdout;
}

function parseJsonOutput(stdout) {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error(`OpenClaw did not return JSON: ${stdout.slice(0, 500)}`);
  }
  return JSON.parse(stdout.slice(start, end + 1));
}

async function ensureAgent(agentId) {
  const numeric = agentId.replace(/^ai-/, "");
  const agentDir = path.join(PROJECT_ROOT, "agents", agentId, "agent");
  const workspace = path.join(PROJECT_ROOT, "workspaces", agentId);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  try {
    await runOpenClaw(
      [
        "agents",
        "add",
        `ai-${numeric}`,
        "--agent-dir",
        agentDir,
        "--workspace",
        workspace,
        "--non-interactive",
        "--json",
      ],
      { timeout: 60000 },
    );
  } catch (error) {
    const output = `${error.stdout || ""}\n${error.stderr || ""}`;
    if (!/already exists|exists|duplicate|EEXIST/i.test(output)) {
      throw error;
    }
  }
}

function installFixture(agentId) {
  const dir = sessionsDir(agentId);
  fs.mkdirSync(dir, { recursive: true });
  const storeFile = path.join(dir, "sessions.json");
  const store = readJson(storeFile);
  const now = Date.now();

  for (let topic = 0; topic < TOPIC_COUNT; topic += 1) {
    const sessionId = `live-openclaw-${agentId}-topic-${topic}`;
    const key = `agent:${agentId}:live-openclaw-topic-${topic}`;
    const file = path.join(dir, `${sessionId}.jsonl`);
    const updatedAt = now - topic * 1000;
    const text = [
      `live-openclaw agent=${agentId} topic=${topic}`,
      `live-shared-topic-${topic % 10}`,
      topic % 2 === 0 ? "memory-lancedb" : "google博客",
      topic % 3 === 0 ? "foo.bar(baz)" : "2026/5/16 16:30:35",
      `decision-owner=${agentId}`,
      "multi-session-real-gateway",
    ].join(" ");
    store[key] = visibleSessionEntry(
      sessionId,
      file,
      `Live OpenClaw ${agentId} topic ${topic}`,
      updatedAt,
    );
    writeJsonl(file, [
      sessionHeader(sessionId, updatedAt - 15000),
      message("user", text, updatedAt - 12000),
      message("assistant", `ack live-openclaw ${agentId} topic ${topic}`, updatedAt - 10000),
      message("assistant", `summary live-shared-topic-${topic % 10} grouped answer`, updatedAt),
    ]);
  }

  for (const kind of ["cron", "subagent", "tool"]) {
    const sessionId = `live-openclaw-${agentId}-${kind}-hidden`;
    const key =
      kind === "tool"
        ? `agent:${agentId}:tool:live-openclaw-hidden`
        : `agent:${agentId}:${kind}:live-openclaw-hidden`;
    const file = path.join(dir, `${sessionId}.jsonl`);
    const updatedAt = now - 99999;
    const label = kind === "tool" ? "/session-search live-openclaw" : `hidden ${kind}`;
    store[key] = hiddenSessionEntry(sessionId, file, label, updatedAt, kind);
    writeJsonl(file, [
      sessionHeader(sessionId, updatedAt - 1000),
      message("user", `live-openclaw hidden ${kind} should not appear`, updatedAt),
    ]);
  }

  writeJson(storeFile, store);
}

async function gateway(method, params) {
  const started = performance.now();
  const stdout = await runOpenClaw(
    ["gateway", "call", method, "--params", JSON.stringify(params), "--json"],
    { timeout: 120000 },
  );
  return { result: parseJsonOutput(stdout), ms: performance.now() - started };
}

function assertCase(cases, category, name, condition, details = {}) {
  if (!condition) {
    throw new Error(`FAIL ${category}: ${name} ${JSON.stringify(details).slice(0, 1000)}`);
  }
  cases.push({ category, name });
}

function uniqueKeys(rows) {
  return new Set((rows || []).map((row) => row.key));
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 0);
}

const options = parseArgs();
const cases = [];
const timings = [];
const start = performance.now();
let completedQueries = 0;

for (const agentId of options.agents) {
  await ensureAgent(agentId);
  installFixture(agentId);
}

const queries = [
  "live-openclaw",
  "multi-session-real-gateway",
  "memory-lancedb",
  "google博客",
  "foo.bar(baz)",
  "2026/5/16 16:30:35",
  "live-shared-topic-3",
  "decision-owner=",
  "not-exist-live-openclaw-zzzz",
];

const representative = [];
async function runQueryCase(i) {
  const agentId = options.agents[i % options.agents.length];
  const query = queries[i % queries.length];
  const { result, ms } = await gateway("session-search.search", {
    query,
    agentId,
    limit: 50,
    sinceDays: 3650,
    maxSessions: 5000,
    maxFiles: 5000,
  });
  timings.push(ms);
  if (representative.length < 8) representative.push({ agentId, query, ms: Math.round(ms), count: result.count });
  completedQueries += 1;
  if (completedQueries % 50 === 0 || completedQueries === options.cases) {
    process.stderr.write(`completed ${completedQueries}/${options.cases} live gateway query cases\n`);
  }

  assertCase(cases, "live", `gateway result shape ${i}`, Array.isArray(result.results));
  assertCase(cases, "performance", `gateway call under 120s ${i}`, ms < 120000, { ms });
  assertCase(cases, "filtering", `hidden sessions filtered ${i}`, result.filteredCron >= 1 && result.filteredSubagent >= 1 && result.filteredTool >= 1, result);
  assertCase(cases, "experience", `sessionGroups exists ${i}`, Array.isArray(result.sessionGroups) && typeof result.sessionGroupCount === "number", result);
  assertCase(cases, "experience", `sessionGroups bounded ${i}`, result.sessionGroupCount <= 50, result);

  if (query === "not-exist-live-openclaw-zzzz") {
    assertCase(cases, "functional", `no result query ${i}`, result.count === 0 && result.sessionGroupCount === 0, result);
    return;
  }

  assertCase(
    cases,
    "functional",
    `agent scoped ${i}`,
    result.results.every((row) => row.key.startsWith(`agent:${agentId}:`)),
    result.results.slice(0, 3),
  );
  assertCase(
    cases,
    "experience",
    `group shape ${i}`,
    result.sessionGroups.every((group) => group.key && group.bestHit?.snippet && group.hitCount >= 1),
    result.sessionGroups[0],
  );
  if (query === "live-openclaw" || query === "multi-session-real-gateway") {
    assertCase(cases, "functional", `multi-session recall ${i}`, uniqueKeys(result.results).size >= 20, {
      count: result.count,
      groups: result.sessionGroupCount,
    });
  }
}

async function runPool(total, concurrency, worker) {
  let next = 0;
  const workers = Array.from({ length: Math.min(total, concurrency) }, async () => {
    while (next < total) {
      const index = next;
      next += 1;
      await worker(index);
    }
  });
  await Promise.all(workers);
}

await runPool(options.cases, options.concurrency, runQueryCase);

const crossAgentSummary = [];
for (const agentId of options.agents) {
  const { result, ms } = await gateway("session-search.search", {
    query: "live-openclaw",
    agentId,
    limit: 50,
    sinceDays: 3650,
    maxSessions: 5000,
    maxFiles: 5000,
  });
  timings.push(ms);
  const keys = uniqueKeys(result.results);
  crossAgentSummary.push({ agentId, count: result.count, sessionGroupCount: result.sessionGroupCount });
  assertCase(cases, "cross-agent", `${agentId} returns own sessions`, result.results.every((row) => row.key.startsWith(`agent:${agentId}:`)), result.results.slice(0, 3));
  assertCase(cases, "cross-agent", `${agentId} has many live sessions`, keys.size >= 20, { keys: keys.size });
  assertCase(cases, "experience", `${agentId} groups many sessions`, result.sessionGroupCount >= 20, result);
}

const totalMs = performance.now() - start;
assertCase(cases, "performance", "total live multi-agent validation under 3 hours", totalMs < 3 * 60 * 60 * 1000, { totalMs });

const byCategory = cases.reduce((acc, item) => {
  acc[item.category] = (acc[item.category] || 0) + 1;
  return acc;
}, {});

console.log(
  JSON.stringify(
    {
      ok: true,
      liveOnly: true,
      invocation: "openclaw gateway call session-search.search",
      agents: options.agents,
      queryCases: options.cases,
      concurrency: options.concurrency,
      assertions: cases.length,
      byCategory,
      fixture: {
        visibleSessionsPerAgent: TOPIC_COUNT,
        hiddenSessionsPerAgent: 3,
        storage: `${OPENCLAW_HOME}/agents/<agentId>/sessions`,
      },
      crossAgentSummary,
      representative,
      performance: {
        totalMs: Math.round(totalMs),
        avgGatewayCallMs: Math.round(timings.reduce((sum, item) => sum + item, 0) / timings.length),
        p50GatewayCallMs: percentile(timings, 0.5),
        p95GatewayCallMs: percentile(timings, 0.95),
        maxGatewayCallMs: Math.round(Math.max(...timings)),
      },
      uxRecommendation:
        "Render grouped by agentId first, then sessionGroups. Show bestHit and hitCount per session; expand only when the user wants individual hits.",
    },
    null,
    2,
  ),
);
