import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-search-bench-"));
const pluginRoot = path.join(workRoot, "plugin");
const stateRoot = path.join(workRoot, "state");
const sessionsDir = path.join(stateRoot, "agents", "main", "sessions");
const fakeDistDir = path.join(workRoot, "dist");

function intArg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  const value = hit ? Number(hit.slice(prefix.length)) : fallback;
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

const scales = process.argv
  .filter((arg) => arg.startsWith("--scale="))
  .flatMap((arg) => arg.slice("--scale=".length).split(","))
  .map((value) => Number(value))
  .filter((value) => Number.isFinite(value) && value > 0);
const SCALE_SET = scales.length ? scales : [1000, 5000, 10000];
const LARGE_FILES = intArg("large-files", 30);

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
    path.join(fakeDistDir, "session-binding-service-bench.js"),
    "export function getSessionBindingService() { return null; }\n",
  );
}

function createFixture(totalSessions) {
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  const now = Date.now();
  const store = {};
  for (let i = 0; i < totalSessions; i += 1) {
    const sessionId = `bench-${totalSessions}-${i}`;
    const key = `agent:main:bench-${totalSessions}-${i}`;
    const file = path.join(sessionsDir, `${sessionId}.jsonl`);
    const isLarge = i < LARGE_FILES;
    const hasNeedle = i % 41 === 0;
    const rows = [
      sessionHeader(sessionId, now - 180000 - i),
      message("user", `ordinary benchmark message ${i}`, now - 120000 - i),
      message(
        "assistant",
        isLarge ? `large filler ${"x".repeat(280000)}` : `assistant benchmark reply ${i}`,
        now - 90000 - i,
      ),
      message(
        "user",
        hasNeedle
          ? `benchmark needle phrase ${i} google博客 郝行军背景 memory-lancedb-pro foo.bar(baz) 2026/5/16 16:30:35`
          : `closing benchmark message ${i}`,
        now - 30000 - i,
      ),
    ];
    store[key] = {
      sessionId,
      sessionFile: file,
      updatedAt: now - i,
      label: i % 10 === 0 ? `bench-label-${totalSessions}-${i}` : undefined,
      chatType: "direct",
      lastChannel: "feishu",
      origin: { provider: "feishu", surface: "feishu", chatType: "direct" },
      deliveryContext: { channel: "feishu" },
    };
    writeJsonl(file, rows);
  }
  writeJson(path.join(sessionsDir, "sessions.json"), store);
}

async function loadMethods() {
  installPluginSandbox();
  process.env.OPENCLAW_HOME = stateRoot;
  process.env.OPENCLAW_DIST_DIR = fakeDistDir;
  const entry = (await import(pathToFileURL(path.join(pluginRoot, "index.js")).href)).default;
  const methods = new Map();
  entry.register({
    pluginConfig: {
      enabled: true,
      backend: "rg",
      fallbackToNode: true,
      defaultLimit: 20,
      maxSessions: 10000,
      maxFiles: 10000,
      timeoutMs: 10000,
    },
    registerGatewayMethod(name, handler) {
      methods.set(name, handler);
    },
    registerCommand() {},
    registerTool() {},
  });
  return methods;
}

async function callMethod(methods, name, params) {
  const handler = methods.get(name);
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

async function timed(fn) {
  const started = performance.now();
  const result = await fn();
  return { ms: Math.round(performance.now() - started), result };
}

const methods = await loadMethods();
const runs = [];

for (const scale of SCALE_SET) {
  createFixture(scale);
  const resume = await timed(() =>
    callMethod(methods, "session-search.resume", {
      agentId: "main",
      maxSessions: scale,
      sinceDays: 2,
    }),
  );
  const rgNeedle = await timed(() =>
    callMethod(methods, "session-search.search", {
      query: "benchmark needle phrase",
      agentId: "main",
      limit: 20,
      sinceDays: 2,
      maxSessions: scale,
      maxFiles: scale,
    }),
  );
  const nodeNeedle = await timed(() =>
    callMethod(methods, "session-search.search", {
      query: "benchmark needle phrase",
      agentId: "main",
      backend: "node",
      limit: 20,
      sinceDays: 2,
      maxSessions: scale,
      maxFiles: scale,
    }),
  );
  const zeroHit = await timed(() =>
    callMethod(methods, "session-search.search", {
      query: "不存在的性能压测查询词 zzz",
      agentId: "main",
      limit: 20,
      sinceDays: 2,
      maxSessions: scale,
      maxFiles: scale,
    }),
  );
  const mixedQuery = await timed(() =>
    callMethod(methods, "session-search.search", {
      query: "google博客 foo.bar(baz) 2026/5/16 16:30:35",
      agentId: "main",
      limit: 20,
      sinceDays: 2,
      maxSessions: scale,
      maxFiles: scale,
    }),
  );
  runs.push({
    scale,
    largeFiles: LARGE_FILES,
    resumeListMs: resume.ms,
    rgNeedleMs: rgNeedle.ms,
    nodeNeedleMs: nodeNeedle.ms,
    zeroHitMs: zeroHit.ms,
    mixedQueryMs: mixedQuery.ms,
    rgHits: rgNeedle.result.count,
    nodeHits: nodeNeedle.result.count,
    mixedHits: mixedQuery.result.count,
    tailScannedLargeFiles: rgNeedle.result.debug.tailScannedLargeFiles,
    searchedFiles: rgNeedle.result.searchedFiles,
  });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      workRoot,
      runs,
    },
    null,
    2,
  ),
);
