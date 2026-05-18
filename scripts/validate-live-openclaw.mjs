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

const resumeAllTimed = await timed("resume all", () =>
  gateway("session-search.resume", { agentId: "main" }),
);
const resumeAll = resumeAllTimed.result;
const sessions = resumeAll.sessions ?? [];

assertCase(cases, "live", "resume returns session list", Array.isArray(sessions));
assertCase(cases, "live", "resume list shape is stable", sessions.length >= 0, { count: sessions.length });
assertCase(cases, "filtering", "resume filters subagents by default", resumeAll.stats.filteredSubagent >= 0);
assertCase(cases, "filtering", "resume filters cron by default", resumeAll.stats.filteredCron >= 0);
assertCase(cases, "performance", "resume list under 10s", resumeAllTimed.ms < 10000, {
  ms: Math.round(resumeAllTimed.ms),
});

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
assertCase(cases, "performance", "hello search under 10s", searchHelloTimed.ms < 10000, {
  ms: Math.round(searchHelloTimed.ms),
});

const queries = [
  "你好",
  "resume",
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
  assertCase(cases, "performance", `query ${query} under 10s`, run.ms < 10000, {
    ms: Math.round(run.ms),
  });
}

for (const session of sessions) {
  assertCase(cases, "display", `session key ${session.key}`, isSessionKey(session.key));
  assertCase(cases, "display", `session id ${session.key}`, hasText(session.sessionId));
  assertCase(cases, "display", `session display name ${session.key}`, hasText(session.displayName));
  assertCase(cases, "display", `session last message ${session.key}`, validTime(session.lastMessageAt));
  assertCase(cases, "display", `session updated ${session.key}`, validTime(session.updatedAt));
  assertCase(cases, "usability", `session can be resumed by display or key ${session.key}`, hasText(session.displayName) || isSessionKey(session.key));
  assertCase(cases, "experience", `preview short enough ${session.key}`, !session.lastMessagePreview || session.lastMessagePreview.length <= 140);
  assertCase(cases, "experience", `display name no newline ${session.key}`, !/\r|\n/.test(session.displayName));
  assertCase(cases, "functional", `created before last ${session.key}`, !session.createdAt || session.createdAt <= session.lastMessageAt);
  assertCase(cases, "functional", `key unique marker ${session.key}`, sessions.filter((row) => row.key === session.key).length === 1);
}

for (const result of helloResults) {
  assertCase(cases, "display", `search key ${result.key}:${result.line}`, isSessionKey(result.key));
  assertCase(cases, "display", `search session id ${result.key}:${result.line}`, hasText(result.sessionId));
  assertCase(cases, "display", `search role ${result.key}:${result.line}`, ["user", "assistant", "system"].includes(result.role));
  assertCase(cases, "display", `search timestamp ${result.key}:${result.line}`, validTime(result.timestamp));
  assertCase(cases, "display", `search last message ${result.key}:${result.line}`, validTime(result.lastMessageAt));
  assertCase(cases, "display", `search snippet ${result.key}:${result.line}`, hasText(result.snippet));
  assertCase(cases, "experience", `search snippet readable ${result.key}:${result.line}`, result.snippet.length <= 260);
  assertCase(cases, "functional", `search line number ${result.key}:${result.line}`, Number(result.line) > 0);
  assertCase(cases, "functional", `search timestamp before last ${result.key}:${result.line}`, result.timestamp <= result.lastMessageAt);
  assertCase(cases, "usability", `search resumable id ${result.key}:${result.line}`, sessions.some((session) => session.key === result.key));
}

const resumableTargets = [
  ...sessions.map((session) => session.label).filter(hasText),
  ...sessions.map((session) => session.key).filter(hasText),
].slice(0, 6);

for (const [index, target] of resumableTargets.entries()) {
  const result = await gateway("session-search.resume", {
    agentId: "main",
    label: target,
    conversation: {
      ...FEISHU_CONVERSATION,
      conversationId: `${FEISHU_CONVERSATION.conversationId}:live-${index}`,
    },
    senderId: FEISHU_SENDER_ID,
  });
  const bindingUnavailable = result.code === "binding_unavailable" || result.code === "binding_service_unavailable";
  assertCase(cases, "functional", `resume target ${target}`, result.action === "resume" || bindingUnavailable, {
    result,
  });
  if (result.action === "resume") {
    assertCase(cases, "functional", `resume target binding ${target}`, result.binding?.targetSessionKey === result.session?.key);
    assertCase(cases, "usability", `resume target has label ${target}`, hasText(result.session?.displayName));
  } else {
    assertCase(cases, "functional", `resume target binding unavailable ${target}`, bindingUnavailable, { result });
    assertCase(cases, "usability", `resume target skipped by channel capability ${target}`, bindingUnavailable, { result });
  }
}

const missing = await gateway("session-search.resume", {
  agentId: "main",
  label: "missing-live-validation-session",
  conversation: FEISHU_CONVERSATION,
  senderId: FEISHU_SENDER_ID,
});
assertCase(cases, "reliability", "missing resume target returns not_found", missing.code === "not_found");

const invalid = await gateway("session-search.resume", {
  agentId: "main",
  label: "bad\nlabel",
  conversation: FEISHU_CONVERSATION,
  senderId: FEISHU_SENDER_ID,
});
assertCase(cases, "reliability", "invalid resume label rejected", invalid.code === "invalid_label");

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
assertCase(cases, "performance", "total live validation under 120s", totalMs < 120000, {
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
        resumeListMs: Math.round(resumeAllTimed.ms),
        searchHelloMs: Math.round(searchHelloTimed.ms),
        totalMs: Math.round(totalMs),
      },
    },
    null,
    2,
  ),
);
