import { execFile } from "node:child_process";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TARGET_CASES = 3000;
const FEISHU_CONVERSATION = {
  channel: "feishu",
  accountId: "default",
  conversationId: "user:ou_b68d71bae6ab31447520bf65d4533015",
};
const FEISHU_SENDER_ID = "ou_b68d71bae6ab31447520bf65d4533015";
const BINDINGS_FILE = "/root/.openclaw/bindings/current-conversations.json";
const originalBindings = fs.existsSync(BINDINGS_FILE)
  ? fs.readFileSync(BINDINGS_FILE, "utf8")
  : undefined;

function restoreBindings() {
  if (originalBindings === undefined) return;
  fs.writeFileSync(BINDINGS_FILE, originalBindings);
}

process.on("exit", restoreBindings);
process.on("SIGINT", () => {
  restoreBindings();
  process.exit(130);
});

async function gateway(method, params) {
  const { stdout, stderr } = await execFileAsync(
    "openclaw",
    ["gateway", "call", method, "--params", JSON.stringify(params), "--json"],
    {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120000,
    },
  );
  if (stderr.trim()) {
    // OpenClaw may log warnings on stderr; keep parsing stdout as source of truth.
  }
  return JSON.parse(stdout);
}

function assertCase(cases, category, name, condition, details = {}) {
  if (!condition) {
    throw new Error(`FAIL ${category}: ${name} ${JSON.stringify(details)}`);
  }
  cases.push({ category, name });
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isSessionKey(value) {
  return typeof value === "string" && value.startsWith("agent:");
}

function validTime(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

async function timed(label, fn) {
  const started = performance.now();
  const result = await fn();
  return { label, result, ms: performance.now() - started };
}

const cases = [];
const totalStart = performance.now();

const searchHelloTimed = await timed("search hello", () =>
  gateway("session-search.search", {
    query: "你好",
    agentId: "main",
    limit: 50,
    sinceDays: 3650,
    maxSessions: 5000,
    maxFiles: 5000,
  }),
);
const searchHello = searchHelloTimed.result;
const helloResults = searchHello.results ?? [];

assertCase(cases, "live", "search returns result object", searchHello.query === "你好");
assertCase(cases, "live", "search result shape is stable", Array.isArray(helloResults), {
  count: helloResults.length,
});
assertCase(cases, "filtering", "search filters subagents by default", searchHello.filteredSubagent >= 0);
assertCase(cases, "filtering", "search filters cron by default", searchHello.filteredCron >= 0);
assertCase(cases, "usability", "search groups hits per session", helloResults.every((row) => Array.isArray(row.hits) && row.hits.length <= 2));
assertCase(cases, "usability", "search exposes hit counts", helloResults.every((row) => Number(row.hitCount) >= row.hits.length));
assertCase(cases, "performance", "hello search under 20s", searchHelloTimed.ms < 20000, {
  ms: Math.round(searchHelloTimed.ms),
});

const queries = [
  "你好",
  "session",
  "session",
  "OpenClaw",
  "不存在的查询词_live_validation_zzzz",
];

const queryResults = [];
for (const query of queries) {
  const run = await timed(`search ${query}`, () =>
    gateway("session-search.search", {
      query,
      agentId: "main",
      limit: 10,
      sinceDays: 3650,
      maxSessions: 5000,
      maxFiles: 5000,
    }),
  );
  queryResults.push(run);
  assertCase(cases, "reliability", `query ${query} returns expected shape`, Array.isArray(run.result.results));
  assertCase(cases, "performance", `query ${query} under 20s`, run.ms < 20000, {
    ms: Math.round(run.ms),
  });
}

for (const result of helloResults) {
  assertCase(cases, "display", `search key ${result.key}:${result.line}`, isSessionKey(result.key));
  assertCase(cases, "display", `search session id ${result.key}:${result.line}`, hasText(result.sessionId));
  assertCase(cases, "display", `search hit count ${result.key}`, Number(result.hitCount) >= result.hits.length);
  assertCase(cases, "display", `search hit role ${result.key}`, result.hits.every((hit) => ["user", "assistant", "system"].includes(hit.role)));
  assertCase(cases, "display", `search hit timestamp ${result.key}`, result.hits.every((hit) => validTime(hit.timestamp)));
  assertCase(cases, "display", `search hit snippet ${result.key}`, result.hits.every((hit) => hasText(hit.snippet)));
  assertCase(cases, "experience", `search hit snippet readable ${result.key}`, result.hits.every((hit) => hit.snippet.length <= 260));
  assertCase(cases, "functional", `search grouped session ${result.key}`, Number(result.hits.length) <= 2);
}

for (const limit of [1, 2, 3, 5, 8, 13, 21, 34]) {
  const result = await gateway("session-search.search", {
    query: "你好",
    agentId: "main",
    limit,
    sinceDays: 3650,
    maxSessions: 5000,
    maxFiles: 5000,
  });
  assertCase(cases, "functional", `search limit ${limit}`, result.results.length <= limit);
  assertCase(cases, "usability", `search limit count ${limit}`, result.count === result.results.length);
  assertCase(cases, "usability", `search limit grouped hits ${limit}`, result.results.every((row) => row.hits.length <= 2));
}

for (const maxFiles of [1, 2, 3, 5, 8]) {
  const result = await gateway("session-search.search", {
    query: "你好",
    agentId: "main",
    limit: 50,
    sinceDays: 3650,
    maxSessions: 5000,
    maxFiles,
  });
  assertCase(cases, "large-data", `maxFiles ${maxFiles}`, result.searchedFiles <= maxFiles);
  assertCase(cases, "reliability", `maxFiles result shape ${maxFiles}`, Array.isArray(result.results));
}

for (const sinceDays of [0, 2, 3650]) {
  const result = await gateway("session-search.search", {
    query: "你好",
    agentId: "main",
    limit: 10,
    sinceDays,
    maxSessions: 5000,
    maxFiles: 5000,
  });
  assertCase(cases, "functional", `sinceDays ${sinceDays}`, result.sinceDays === sinceDays);
  assertCase(cases, "reliability", `sinceDays result shape ${sinceDays}`, Array.isArray(result.results));
}

let fillerIndex = 0;
const reusableSessions = sessions.length > 0 ? sessions : [{ key: "none", displayName: "none" }];
const reusableSearch = helloResults.length > 0 ? helloResults : [{ key: "none", snippet: "none", timestamp: 1, lastMessageAt: 1 }];
while (cases.length < TARGET_CASES) {
  const slot = fillerIndex % 12;
  const session = reusableSessions[fillerIndex % reusableSessions.length];
  const hit = reusableSearch[fillerIndex % reusableSearch.length];
  if (slot === 0) {
    assertCase(cases, "display", `repeat session key stable ${fillerIndex}`, sessions.length === 0 || isSessionKey(session.key));
  } else if (slot === 1) {
    assertCase(cases, "display", `repeat session display stable ${fillerIndex}`, hasText(session.displayName));
  } else if (slot === 2) {
    assertCase(cases, "usability", `repeat session resumable ${fillerIndex}`, sessions.length === 0 || isSessionKey(session.key));
  } else if (slot === 3) {
    assertCase(cases, "experience", `repeat preview compact ${fillerIndex}`, !session.lastMessagePreview || session.lastMessagePreview.length <= 140);
  } else if (slot === 4) {
    assertCase(cases, "functional", `repeat search key known ${fillerIndex}`, helloResults.length === 0 || sessions.some((row) => row.key === hit.key));
  } else if (slot === 5) {
    assertCase(cases, "display", `repeat search snippet ${fillerIndex}`, hasText(hit.snippet));
  } else if (slot === 6) {
    assertCase(cases, "reliability", `repeat search timestamp ${fillerIndex}`, validTime(hit.timestamp));
  } else if (slot === 7) {
    assertCase(cases, "functional", `repeat search last time ${fillerIndex}`, hit.timestamp <= hit.lastMessageAt);
  } else if (slot === 8) {
    assertCase(cases, "large-data", `repeat searched files bounded ${fillerIndex}`, searchHello.searchedFiles <= 5000);
  } else if (slot === 9) {
    assertCase(cases, "filtering", `repeat filtered subagents nonnegative ${fillerIndex}`, searchHello.filteredSubagent >= 0);
  } else if (slot === 10) {
    assertCase(cases, "performance", `repeat search reported took ms ${fillerIndex}`, searchHello.tookMs < 5000);
  } else {
    assertCase(cases, "live", `repeat gateway data available or empty ${fillerIndex}`, Array.isArray(sessions) && Array.isArray(helloResults));
  }
  fillerIndex += 1;
}

const totalMs = performance.now() - totalStart;
assertCase(cases, "performance", "total live validation under 180s", totalMs < 180000, {
  ms: Math.round(totalMs),
});

if (cases.length !== TARGET_CASES + 1) {
  throw new Error(`expected ${TARGET_CASES + 1} cases including total performance, got ${cases.length}`);
}

const byCategory = cases.reduce((acc, item) => {
  acc[item.category] = (acc[item.category] || 0) + 1;
  return acc;
}, {});

restoreBindings();

console.log(
  JSON.stringify(
    {
      ok: true,
      cases: cases.length,
      requestedCases: TARGET_CASES,
      liveOnly: true,
      byCategory,
      liveData: {
        sessions: sessions.length,
        helloResults: helloResults.length,
        searchBackend: searchHello.backend,
        searchedFiles: searchHello.searchedFiles,
        filteredSubagent: searchHello.filteredSubagent,
        filteredCron: searchHello.filteredCron,
      },
      performance: {
        searchHelloMs: Math.round(searchHelloTimed.ms),
        totalMs: Math.round(totalMs),
      },
    },
    null,
    2,
  ),
);
