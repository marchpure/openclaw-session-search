import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const DEFAULTS = {
  enabled: false,
  backend: "rg",
  fallbackToNode: true,
  defaultLimit: 8,
  maxSessions: 200,
  maxCharsPerMessage: 800,
  maxTranscriptBytes: 256 * 1024,
  maxFiles: 1000,
  sinceDays: 2,
  timeoutMs: 3000,
  rgBatchSize: 200,
  includeAssistantByDefault: true,
  includeCron: false,
  includeSubagents: false,
  includeInternal: false,
};

const SEARCHABLE_ROLES = new Set(["user", "assistant", "system"]);

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function resolveConfig(raw) {
  const cfg = asRecord(raw);
  return {
    enabled: typeof cfg.enabled === "boolean" ? cfg.enabled : DEFAULTS.enabled,
    backend: cfg.backend === "node" ? "node" : DEFAULTS.backend,
    fallbackToNode:
      typeof cfg.fallbackToNode === "boolean" ? cfg.fallbackToNode : DEFAULTS.fallbackToNode,
    defaultLimit: clampInt(cfg.defaultLimit, DEFAULTS.defaultLimit, 1, 50),
    maxSessions: clampInt(cfg.maxSessions, DEFAULTS.maxSessions, 1, 10000),
    maxCharsPerMessage: clampInt(
      cfg.maxCharsPerMessage,
      DEFAULTS.maxCharsPerMessage,
      80,
      4000,
    ),
    maxTranscriptBytes: clampInt(
      cfg.maxTranscriptBytes,
      DEFAULTS.maxTranscriptBytes,
      4096,
      2 * 1024 * 1024,
    ),
    maxFiles: clampInt(cfg.maxFiles, DEFAULTS.maxFiles, 1, 10000),
    sinceDays: clampInt(cfg.sinceDays, DEFAULTS.sinceDays, 0, 3650),
    timeoutMs: clampInt(cfg.timeoutMs, DEFAULTS.timeoutMs, 100, 60000),
    rgBatchSize: clampInt(cfg.rgBatchSize, DEFAULTS.rgBatchSize, 1, 500),
    includeAssistantByDefault:
      typeof cfg.includeAssistantByDefault === "boolean"
        ? cfg.includeAssistantByDefault
        : DEFAULTS.includeAssistantByDefault,
    includeCron: typeof cfg.includeCron === "boolean" ? cfg.includeCron : DEFAULTS.includeCron,
    includeSubagents:
      typeof cfg.includeSubagents === "boolean" ? cfg.includeSubagents : DEFAULTS.includeSubagents,
    includeInternal:
      typeof cfg.includeInternal === "boolean" ? cfg.includeInternal : DEFAULTS.includeInternal,
  };
}

function nowMs() {
  return Date.now();
}

function normalizeAgentId(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw || "main";
}

function stateRoot() {
  return process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
}

function sessionsDirForAgent(agentId) {
  return path.join(stateRoot(), "agents", normalizeAgentId(agentId), "sessions");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function hasPathSegment(key, segment) {
  return key.split(":").includes(segment);
}

function isCronRunAlias(key) {
  const parts = key.split(":");
  const cronIndex = parts.indexOf("cron");
  const runIndex = parts.indexOf("run");
  return cronIndex >= 0 && runIndex > cronIndex;
}

function stringFromEntry(entry, key) {
  const value = entry[key];
  return typeof value === "string" ? value.trim() : "";
}

function hasUserVisibleChannel(entry) {
  const origin = asRecord(entry.origin);
  const deliveryContext = asRecord(entry.deliveryContext);
  return Boolean(
    stringFromEntry(entry, "chatType") ||
      stringFromEntry(entry, "lastChannel") ||
      stringFromEntry(origin, "provider") ||
      stringFromEntry(origin, "surface") ||
      stringFromEntry(origin, "chatType") ||
      stringFromEntry(deliveryContext, "channel"),
  );
}

function classifySessionVisibility(key, entry) {
  if (hasPathSegment(key, "subagent") || stringFromEntry(entry, "spawnedBy") || stringFromEntry(entry, "subagentRole")) {
    return "subagent";
  }
  if (hasPathSegment(key, "cron") || isCronRunAlias(key) || stringFromEntry(entry, "scheduleId")) {
    return "cron";
  }
  if (hasPathSegment(key, "tool") || stringFromEntry(entry, "toolName") || stringFromEntry(entry, "toolCallId")) {
    return "tool";
  }
  if (!hasUserVisibleChannel(entry)) {
    return "internal";
  }
  return "visible";
}

function shouldIncludeSession(key, entry, opts) {
  const visibility = classifySessionVisibility(key, entry);
  if (visibility === "visible") return { include: true, visibility };
  if (visibility === "subagent" && opts.includeSubagents) return { include: true, visibility };
  if (visibility === "cron" && opts.includeCron) return { include: true, visibility };
  if ((visibility === "internal" || visibility === "tool") && opts.includeInternal) {
    return { include: true, visibility };
  }
  return { include: false, visibility };
}

function listSessionEntries(agentId, opts) {
  const dir = sessionsDirForAgent(agentId);
  const storePath = path.join(dir, "sessions.json");
  const stats = {
    candidateSessions: 0,
    visibleSessions: 0,
    filteredSubagent: 0,
    filteredCron: 0,
    filteredTool: 0,
    filteredInternal: 0,
  };
  if (!fs.existsSync(storePath)) return { sessions: [], stats };
  const cutoff =
    opts.sinceDays > 0 ? nowMs() - opts.sinceDays * 24 * 60 * 60 * 1000 : Number.NEGATIVE_INFINITY;
  const store = readJson(storePath);
  const sessions = Object.entries(asRecord(store))
    .map(([key, entry]) => ({ key, entry: asRecord(entry) }))
    .filter(({ entry }) => typeof entry.sessionId === "string")
    .filter(({ entry }) => Number(entry.updatedAt || 0) >= cutoff)
    .filter(({ key, entry }) => {
      stats.candidateSessions += 1;
      const decision = shouldIncludeSession(key, entry, opts);
      if (decision.include) {
        stats.visibleSessions += 1;
        return true;
      }
      if (decision.visibility === "subagent") stats.filteredSubagent += 1;
      else if (decision.visibility === "cron") stats.filteredCron += 1;
      else if (decision.visibility === "tool") stats.filteredTool += 1;
      else stats.filteredInternal += 1;
      return false;
    })
    .sort((a, b) => Number(b.entry.updatedAt || 0) - Number(a.entry.updatedAt || 0))
    .slice(0, opts.maxSessions)
    .map(({ key, entry }) => ({
      key,
      label: typeof entry.label === "string" ? entry.label : undefined,
      sessionId: entry.sessionId,
      updatedAt: Number(entry.updatedAt || 0),
      sessionFile: resolveSessionFile(dir, entry),
    }));
  return { sessions, stats };
}

function parseAgentIdFromSessionKey(key) {
  const parts = String(key ?? "").split(":");
  const agentIndex = parts.indexOf("agent");
  if (agentIndex >= 0 && parts[agentIndex + 1]) return parts[agentIndex + 1];
  return "main";
}

function resolveSessionFile(dir, entry) {
  const raw = typeof entry.sessionFile === "string" ? entry.sessionFile.trim() : "";
  if (raw) return path.isAbsolute(raw) ? raw : path.resolve(dir, raw);
  return path.join(dir, `${entry.sessionId}.jsonl`);
}

function extractText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) return extractText(value.content);
  return "";
}

function parseTranscriptLine(line) {
  try {
    const raw = JSON.parse(line);
    const role = raw.role ?? raw.message?.role ?? raw.type;
    const text = extractText(raw.content ?? raw.message?.content ?? raw.text ?? raw);
    const timestamp = raw.timestamp ?? raw.createdAt ?? raw.ts;
    if (!text.trim()) return null;
    return {
      role: typeof role === "string" ? role : "unknown",
      text: text.trim(),
      timestamp: typeof timestamp === "number" ? timestamp : undefined,
    };
  } catch {
    return null;
  }
}

function readLastMessagePreview(sessionFile, maxChars = 96) {
  if (!sessionFile || !fs.existsSync(sessionFile)) return "";
  try {
    const stat = fs.statSync(sessionFile);
    const readBytes = Math.min(stat.size, 64 * 1024);
    const fd = fs.openSync(sessionFile, "r");
    const buffer = Buffer.alloc(readBytes);
    fs.readSync(fd, buffer, 0, readBytes, Math.max(0, stat.size - readBytes));
    fs.closeSync(fd);
    const lines = buffer.toString("utf8").trim().split(/\r?\n/).reverse();
    for (const line of lines) {
      const msg = parseTranscriptLine(line);
      if (!msg || !SEARCHABLE_ROLES.has(msg.role)) continue;
      return `${roleLabel(msg.role)}：${singleLine(msg.text, maxChars)}`;
    }
  } catch {
    return "";
  }
  return "";
}

function normalizeSessionLabel(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseSessionResumeLabel(raw) {
  const label = normalizeSessionLabel(raw);
  if (!label) return { ok: false, error: "请提供要恢复的命名会话。" };
  if (label.length > 120) return { ok: false, error: "会话名过长，最多 120 个字符。" };
  if (/[\r\n\t]/.test(label)) return { ok: false, error: "会话名不能包含换行或制表符。" };
  return { ok: true, label };
}

function sessionDisplayName(session) {
  return normalizeSessionLabel(session.label) || session.key || session.sessionId || "session";
}

function listResumableSessions(agentId, cfg, params = {}) {
  const listed = listSessionEntries(agentId, {
    maxSessions: clampInt(params.maxSessions, 100, 1, cfg.maxSessions),
    sinceDays: clampInt(params.sinceDays, 3650, 0, 3650),
    includeCron: false,
    includeSubagents: false,
    includeInternal: false,
  });
  const sessions = listed.sessions.map((session) => ({
    ...session,
    label: normalizeSessionLabel(session.label),
    displayName: sessionDisplayName(session),
    lastMessagePreview: readLastMessagePreview(session.sessionFile),
  }));
  return { sessions, stats: listed.stats };
}

function resolveResumableSession(agentId, target, cfg) {
  const { sessions } = listResumableSessions(agentId, cfg, { maxSessions: cfg.maxSessions });
  const exact = sessions.filter((session) => session.label === target || session.key === target);
  if (exact.length === 1) return { ok: true, session: exact[0] };
  if (exact.length > 1) {
    return { ok: false, code: "ambiguous", matches: exact };
  }
  const targetLower = target.toLowerCase();
  const insensitive = sessions.filter(
    (session) => session.label.toLowerCase() === targetLower || session.key.toLowerCase() === targetLower,
  );
  if (insensitive.length === 1) return { ok: true, session: insensitive[0] };
  if (insensitive.length > 1) {
    return { ok: false, code: "ambiguous", matches: insensitive };
  }
  return { ok: false, code: "not_found", matches: [] };
}

function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}

function scoreText(text, terms) {
  const lower = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    let index = lower.indexOf(term);
    while (index !== -1) {
      score += term.length >= 4 ? 3 : 1;
      index = lower.indexOf(term, index + term.length);
    }
  }
  return score;
}

function snippet(text, terms, maxChars) {
  const lower = text.toLowerCase();
  const firstHit = terms
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  if (firstHit === undefined) return text.slice(0, maxChars);
  const start = Math.max(0, firstHit - Math.floor(maxChars / 3));
  const end = Math.min(text.length, start + maxChars);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}

function searchableSessions(sessions, opts) {
  const accepted = [];
  let skippedMissing = 0;
  let skippedLarge = 0;
  let skippedUnsafePath = 0;
  for (const session of sessions) {
    if (!session.sessionFile || !fs.existsSync(session.sessionFile)) {
      skippedMissing += 1;
      continue;
    }
    if (opts.sessionsDir && !isPathInside(opts.sessionsDir, session.sessionFile)) {
      skippedUnsafePath += 1;
      continue;
    }
    const size = fs.statSync(session.sessionFile).size;
    if (size > opts.maxTranscriptBytes) {
      skippedLarge += 1;
      continue;
    }
    accepted.push({ ...session, size });
    if (accepted.length >= opts.maxFiles) break;
  }
  return { sessions: accepted, skippedMissing, skippedLarge, skippedUnsafePath };
}

function isPathInside(parentDir, childPath) {
  const parent = path.resolve(parentDir);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function searchTranscriptNode(session, terms, opts) {
  if (!session.sessionFile || !fs.existsSync(session.sessionFile)) return [];
  const stat = fs.statSync(session.sessionFile);
  const fd = fs.openSync(session.sessionFile, "r");
  const readBytes = Math.min(stat.size, opts.maxTranscriptBytes);
  const buffer = Buffer.alloc(readBytes);
  fs.readSync(fd, buffer, 0, readBytes, Math.max(0, stat.size - readBytes));
  fs.closeSync(fd);
  const lines = buffer.toString("utf8").split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const msg = parseTranscriptLine(lines[i]);
    if (!msg) continue;
    if (!SEARCHABLE_ROLES.has(msg.role)) continue;
    if (!opts.includeAssistant && msg.role === "assistant") continue;
    const score = scoreText(msg.text, terms);
    if (score <= 0) continue;
    hits.push({
      score,
      key: session.key,
      label: session.label,
      sessionId: session.sessionId,
      updatedAt: session.updatedAt,
      role: msg.role,
      line: i + 1,
      timestamp: msg.timestamp,
      snippet: snippet(msg.text, terms, opts.maxChars),
    });
  }
  return hits;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function findRgCommand() {
  const candidates = [
    process.env.OPENCLAW_SESSION_SEARCH_RG,
    "/usr/bin/rg",
    "/usr/local/bin/rg",
    "/usr/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/path/rg",
    "rg",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (candidate === "rg") return candidate;
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return "rg";
}

function runRgBatch({ rgCommand, terms, files, timeoutMs }) {
  return new Promise((resolve) => {
    const args = [
      "--json",
      "--fixed-strings",
      "--ignore-case",
      "--line-number",
      "--with-filename",
      "--max-count",
      "50",
    ];
    for (const term of terms) args.push("-e", term);
    args.push("--", ...files);
    const child = spawn(rgCommand, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, timedOut, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // ripgrep exits 1 for no matches.
      resolve({ ok: code === 0 || code === 1, timedOut, stdout, stderr, code });
    });
  });
}

function parseRgMatches(stdout, sessionByFile, terms, opts) {
  const hits = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    let event;
    try {
      event = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (event.type !== "match") continue;
    const filePath = event.data?.path?.text;
    const session = filePath ? sessionByFile.get(path.resolve(filePath)) : undefined;
    if (!session) continue;
    const rawText = typeof event.data?.lines?.text === "string" ? event.data.lines.text.trim() : "";
    if (!rawText) continue;
    const msg = parseTranscriptLine(rawText);
    if (!msg) continue;
    if (!SEARCHABLE_ROLES.has(msg.role)) continue;
    if (!opts.includeAssistant && msg.role === "assistant") continue;
    const score = scoreText(msg.text, terms);
    hits.push({
      score: score > 0 ? score : 1,
      key: session.key,
      label: session.label,
      sessionId: session.sessionId,
      updatedAt: session.updatedAt,
      role: msg.role,
      line: Number(event.data?.line_number || 0),
      timestamp: msg.timestamp,
      snippet: snippet(msg.text, terms, opts.maxChars),
    });
  }
  return hits;
}

async function searchWithRg(sessions, terms, opts) {
  const rgCommand = findRgCommand();
  const sessionByFile = new Map(
    sessions.map((session) => [path.resolve(session.sessionFile), session]),
  );
  const files = sessions.map((session) => session.sessionFile);
  const hits = [];
  let timedOut = false;
  let failed = false;
  let stderr = "";
  for (const batch of chunkArray(files, opts.rgBatchSize)) {
    const result = await runRgBatch({
      rgCommand,
      terms,
      files: batch,
      timeoutMs: opts.timeoutMs,
    });
    if (result.timedOut) timedOut = true;
    if (!result.ok) failed = true;
    if (result.stderr) stderr = result.stderr.slice(0, 1000);
    hits.push(...parseRgMatches(result.stdout, sessionByFile, terms, opts));
    if (hits.length >= opts.limit * 8 || timedOut || failed) break;
  }
  return { hits, meta: { backend: "rg", rgCommand, timedOut, failed, stderr } };
}

function searchWithNode(sessions, terms, opts) {
  return {
    hits: sessions.flatMap((session) =>
      searchTranscriptNode(session, terms, {
        includeAssistant: opts.includeAssistant,
        maxChars: opts.maxChars,
        maxTranscriptBytes: opts.maxTranscriptBytes,
      }),
    ),
    meta: { backend: "node" },
  };
}

function formatTime(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  try {
    return new Date(n).toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour12: false,
    });
  } catch {
    return new Date(n).toISOString();
  }
}

function singleLine(value, maxChars) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function roleLabel(role) {
  if (role === "user") return "用户";
  if (role === "assistant") return "助手";
  if (role === "system") return "系统";
  return role || "未知";
}

function stripKnownChannelPrefix(channel, value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  const prefix = `${String(channel ?? "").trim().toLowerCase()}:`;
  return prefix && text.toLowerCase().startsWith(prefix) ? text.slice(prefix.length) : text;
}

function resolveCommandConversation(ctx) {
  const channel = String(ctx.channel ?? ctx.channelId ?? "").trim().toLowerCase();
  if (!channel) return null;
  const accountId = String(ctx.accountId ?? "default").trim() || "default";
  const rawConversation =
    typeof ctx.to === "string" && ctx.to.trim()
      ? ctx.to
      : typeof ctx.from === "string" && ctx.from.trim()
        ? ctx.from
        : typeof ctx.senderId === "string" && ctx.senderId.trim()
          ? `user:${ctx.senderId.trim()}`
          : "";
  const conversationId = stripKnownChannelPrefix(channel, rawConversation);
  if (!conversationId) return null;
  const parentConversationId =
    typeof ctx.threadParentId === "string" && ctx.threadParentId.trim()
      ? stripKnownChannelPrefix(channel, ctx.threadParentId)
      : undefined;
  return {
    channel,
    accountId,
    conversationId:
      typeof ctx.messageThreadId === "string" || typeof ctx.messageThreadId === "number"
        ? String(ctx.messageThreadId)
        : conversationId,
    ...(parentConversationId ? { parentConversationId } : {}),
  };
}

function resolveOpenClawDistDir() {
  const candidates = [
    process.env.OPENCLAW_DIST_DIR,
    "/usr/lib/node_modules/openclaw/dist",
    path.join(process.cwd(), "dist"),
  ].filter(Boolean);
  return candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  });
}

async function importOpenClawInternalChunk(prefix) {
  const distDir = resolveOpenClawDistDir();
  if (!distDir) return null;
  const direct = path.join(distDir, `${prefix}.js`);
  const file = fs.existsSync(direct)
    ? direct
    : fs.readdirSync(distDir).find((name) => name.startsWith(`${prefix}-`) && name.endsWith(".js"));
  if (!file) return null;
  const filePath = path.isAbsolute(file) ? file : path.join(distDir, file);
  return import(pathToFileURL(filePath).href);
}

async function getCoreSessionBindingService() {
  const mod = await importOpenClawInternalChunk("session-binding-service");
  const getter = mod?.getSessionBindingService ?? mod?.r;
  return typeof getter === "function" ? getter() : null;
}

function formatNamedSessionsReply(sessions, stats) {
  if (!sessions.length) {
    return "可恢复会话：0 个\n\n没有找到用户可见会话。";
  }
  const lines = [
    `可恢复会话：${sessions.length} 个`,
    `范围：可见会话 ${stats.visibleSessions} 个`,
    "",
  ];
  sessions.slice(0, 20).forEach((session, index) => {
    lines.push(`--- ${index + 1}/${Math.min(sessions.length, 20)} ---`);
    lines.push(`会话：${singleLine(session.displayName || sessionDisplayName(session), 80)}`);
    if (!session.label && session.key) lines.push(`类型：未命名会话，可用 key 恢复`);
    const when = formatTime(session.updatedAt);
    if (when) lines.push(`时间：${when}`);
    if (session.lastMessagePreview) lines.push(`最近：${singleLine(session.lastMessagePreview, 120)}`);
    lines.push("");
  });
  if (sessions.length > 20) lines.push(`还有 ${sessions.length - 20} 个未展示，请输入更精确的会话名或 key。`);
  lines.push("使用：/resume <会话名或 session key>");
  return lines.join("\n");
}

function formatResumeSuccessReply(session, binding) {
  return [
    `已恢复会话：${session.displayName || sessionDisplayName(session)}`,
    "",
    `目标：${session.key}`,
    binding?.bindingId ? `绑定：${binding.bindingId}` : "",
    "后续消息会继续进入这个会话。",
  ]
    .filter(Boolean)
    .join("\n");
}

async function sessionResume(params, cfg) {
  const agentId = normalizeAgentId(params.agentId);
  const labelRaw = typeof params.label === "string" ? params.label : "";
  if (!labelRaw.trim()) {
    return {
      action: "list",
      ...listResumableSessions(agentId, cfg, { maxSessions: cfg.maxSessions }),
    };
  }
  const parsed = parseSessionResumeLabel(labelRaw);
  if (!parsed.ok) {
    return { action: "error", code: "invalid_label", message: parsed.error };
  }
  const resolved = resolveResumableSession(agentId, parsed.label, cfg);
  if (!resolved.ok) {
    return {
      action: "error",
      code: resolved.code,
      message:
        resolved.code === "ambiguous"
          ? `可恢复会话不唯一：${parsed.label}`
          : `找不到可恢复会话：${parsed.label}`,
      matches: resolved.matches?.map((session) => ({
        key: session.key,
        label: session.label,
        displayName: session.displayName,
        updatedAt: session.updatedAt,
      })),
    };
  }
  const conversation = params.conversation ?? null;
  if (!conversation?.channel || !conversation?.conversationId) {
    return {
      action: "error",
      code: "conversation_unavailable",
      message: "/resume 必须在可绑定的会话里执行。",
    };
  }
  const service = await getCoreSessionBindingService();
  if (!service?.bind || !service?.getCapabilities) {
    return {
      action: "error",
      code: "binding_service_unavailable",
      message: "当前 OpenClaw 运行时没有暴露会话绑定服务。",
    };
  }
  const capabilities = service.getCapabilities({
    channel: conversation.channel,
    accountId: conversation.accountId ?? "default",
  });
  if (
    !capabilities?.adapterAvailable ||
    !capabilities.bindSupported ||
    !capabilities.placements?.includes("current")
  ) {
    return {
      action: "error",
      code: "binding_unavailable",
      message: `当前通道不支持会话绑定：${conversation.channel}:${conversation.accountId ?? "default"}`,
      capabilities,
    };
  }
  const senderId = typeof params.senderId === "string" ? params.senderId.trim() : "";
  const existing = service.resolveByConversation?.(conversation);
  const boundBy = typeof existing?.metadata?.boundBy === "string" ? existing.metadata.boundBy.trim() : "";
  if (existing && boundBy && boundBy !== "system" && senderId && senderId !== boundBy) {
    return {
      action: "error",
      code: "owned_by_other_sender",
      message: `当前会话只能由 ${boundBy} 恢复。`,
    };
  }
  try {
    const targetAgentId = parseAgentIdFromSessionKey(resolved.session.key);
    const displayName = resolved.session.displayName || sessionDisplayName(resolved.session);
    const binding = await service.bind({
      targetSessionKey: resolved.session.key,
      targetKind: "session",
      conversation,
      placement: "current",
      metadata: {
        threadName: `OpenClaw ${targetAgentId}/${displayName}`,
        introText: `Resumed session ${displayName}.`,
        agentId: targetAgentId,
        label: displayName,
        boundBy: senderId || "unknown",
      },
    });
    return {
      action: "resume",
      session: resolved.session,
      binding,
    };
  } catch (error) {
    return {
      action: "error",
      code: "bind_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatSessionResumeCommandReply(result) {
  if (result.action === "list") {
    return formatNamedSessionsReply(result.sessions, result.stats);
  }
  if (result.action === "resume") {
    return formatResumeSuccessReply(result.session, result.binding);
  }
  const lines = [`恢复会话失败：${result.message || result.code || "unknown"}`];
  if (Array.isArray(result.matches) && result.matches.length > 0) {
    lines.push("", "候选会话：");
    result.matches.slice(0, 10).forEach((session, index) => {
      lines.push(`${index + 1}. ${session.displayName || session.label || session.key}`);
    });
  }
  return lines.join("\n");
}

function cleanDisplaySnippet(value, query) {
  let text = String(value ?? "")
    .replace(/```(?:json)?/gi, " ")
    .replace(/Sender \(untrusted metadata\):/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const queryText = String(query ?? "").trim();
  if (queryText) {
    const hit = text.toLowerCase().lastIndexOf(queryText.toLowerCase());
    if (hit > 0 && /[{}":]/.test(text.slice(0, hit))) {
      text = text.slice(hit).trim();
    }
  }
  return singleLine(text, 96);
}

function formatSessionSearchCommandReply(result) {
  const filtered =
    result.filteredSubagent + result.filteredCron + result.filteredTool + result.filteredInternal;
  const lines = [
    `历史会话搜索：${result.query}`,
    "",
    `结果 ${result.count} 条 | 可见会话 ${result.searchedFiles} 个 | 过滤 ${filtered} 个 | ${result.tookMs}ms (${result.backend})`,
  ];
  if (!Array.isArray(result.results) || result.results.length === 0) {
    lines.push("", "未找到匹配的用户可见会话。");
    return lines.join("\n");
  }
  lines.push("");
  result.results.forEach((item, index) => {
    const when = formatTime(item.updatedAt);
    const label = item.label || item.key || item.sessionId || "session";
    lines.push(`--- ${index + 1}/${result.results.length} ---`);
    lines.push(`会话：${singleLine(label, 56)}`);
    if (when) lines.push(`时间：${when}`);
    lines.push(`角色：${roleLabel(item.role)}`);
    lines.push(`片段：${cleanDisplaySnippet(item.snippet, result.query)}`);
    lines.push("");
  });
  return lines.join("\n");
}

async function sessionSearch(params, cfg) {
  const startedAt = Date.now();
  const query = typeof params.query === "string" ? params.query.trim() : "";
  if (!query) throw new Error("query is required");
  const agentId = normalizeAgentId(params.agentId);
  const limit = clampInt(params.limit, cfg.defaultLimit, 1, 50);
  const maxSessions = clampInt(params.maxSessions, cfg.maxSessions, 1, 10000);
  const maxChars = clampInt(params.maxChars, cfg.maxCharsPerMessage, 80, 4000);
  const maxTranscriptBytes = clampInt(
    params.maxTranscriptBytes,
    cfg.maxTranscriptBytes,
    4096,
    2 * 1024 * 1024,
  );
  const maxFiles = clampInt(params.maxFiles, cfg.maxFiles, 1, 10000);
  const sinceDays = clampInt(params.sinceDays, cfg.sinceDays, 0, 3650);
  const timeoutMs = clampInt(params.timeoutMs, cfg.timeoutMs, 100, 60000);
  const rgBatchSize = clampInt(params.rgBatchSize, cfg.rgBatchSize, 1, 500);
  const includeCron = typeof params.includeCron === "boolean" ? params.includeCron : cfg.includeCron;
  const includeSubagents =
    typeof params.includeSubagents === "boolean" ? params.includeSubagents : cfg.includeSubagents;
  const includeInternal =
    typeof params.includeInternal === "boolean" ? params.includeInternal : cfg.includeInternal;
  const includeAssistant =
    typeof params.includeAssistant === "boolean"
      ? params.includeAssistant
      : cfg.includeAssistantByDefault;
  const terms = Array.from(new Set(tokenize(query)));
  if (terms.length === 0) throw new Error("query has no searchable terms");
  const listed = listSessionEntries(agentId, {
    maxSessions,
    sinceDays,
    includeCron,
    includeSubagents,
    includeInternal,
  });
  const selected = searchableSessions(listed.sessions, {
    maxTranscriptBytes,
    maxFiles,
    sessionsDir: sessionsDirForAgent(agentId),
  });
  const searchOpts = {
    limit,
    includeAssistant,
    maxChars,
    maxTranscriptBytes,
    timeoutMs,
    rgBatchSize,
  };
  let search =
    cfg.backend === "rg"
      ? await searchWithRg(selected.sessions, terms, searchOpts)
      : searchWithNode(selected.sessions, terms, searchOpts);
  if (search.meta.failed && cfg.fallbackToNode) {
    search = searchWithNode(selected.sessions, terms, searchOpts);
    search.meta.fallbackFrom = "rg";
  }
  const results = search.hits
    .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
    .slice(0, limit);
  return {
    query,
    agentId,
    backend: search.meta.backend,
    candidateSessions: listed.stats.candidateSessions,
    visibleSessions: listed.stats.visibleSessions,
    searchedSessions: listed.sessions.length,
    searchedFiles: selected.sessions.length,
    skippedMissing: selected.skippedMissing,
    skippedLarge: selected.skippedLarge,
    skippedUnsafePath: selected.skippedUnsafePath,
    filteredSubagent: listed.stats.filteredSubagent,
    filteredCron: listed.stats.filteredCron,
    filteredTool: listed.stats.filteredTool,
    filteredInternal: listed.stats.filteredInternal,
    sinceDays,
    maxTranscriptBytes,
    tookMs: Date.now() - startedAt,
    count: results.length,
    results,
    debug: {
      ...search.meta,
      stderr: search.meta.stderr || undefined,
    },
  };
}

export default definePluginEntry({
  id: "session-search",
  name: "Session Search",
  description: "Low-frequency search over OpenClaw session transcripts.",
  register(api) {
    api.registerGatewayMethod(
      "session-search.search",
      async ({ params, respond }) => {
        const cfg = resolveConfig(api.pluginConfig);
        if (!cfg.enabled) {
          respond(false, undefined, {
            code: "disabled",
            message: "session-search plugin is disabled",
          });
          return;
        }
        try {
          respond(true, await sessionSearch(asRecord(params), cfg));
        } catch (error) {
          respond(false, undefined, {
            code: "session_search_failed",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
      { scope: "operator.read" },
    );

    api.registerGatewayMethod(
      "session-search.resume",
      async ({ params, respond }) => {
        const cfg = resolveConfig(api.pluginConfig);
        if (!cfg.enabled) {
          respond(false, undefined, {
            code: "disabled",
            message: "session-search plugin is disabled",
          });
          return;
        }
        try {
          respond(true, await sessionResume(asRecord(params), cfg));
        } catch (error) {
          respond(false, undefined, {
            code: "session_resume_failed",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
      { scope: "operator.write" },
    );

    api.registerTool(
      () => {
        const cfg = resolveConfig(api.pluginConfig);
        if (!cfg.enabled) return null;
        return {
          name: "session_search",
          label: "Session Search",
          description:
            "Search prior OpenClaw session transcripts. Use for low-frequency recall of previous conversations, tasks, decisions, or blocked work. This is independent from memory_recall and does not use the memory slot.",
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["query"],
            properties: {
              query: { type: "string", description: "Search query." },
              agentId: { type: "string", description: "Agent id to search, default main." },
              limit: { type: "number", description: "Maximum results, default plugin config." },
              maxSessions: { type: "number", description: "Maximum recent sessions to scan." },
              maxFiles: { type: "number", description: "Maximum transcript files to scan." },
              sinceDays: { type: "number", description: "Only search sessions updated within N days." },
              timeoutMs: { type: "number", description: "Per-rg-batch timeout in milliseconds." },
              maxChars: { type: "number", description: "Maximum snippet chars." },
              maxTranscriptBytes: {
                type: "number",
                description: "Maximum bytes to scan from the tail of each transcript.",
              },
              includeAssistant: {
                type: "boolean",
                description: "Include assistant messages in search.",
              },
              includeCron: {
                type: "boolean",
                description: "Include cron sessions. Defaults to false.",
              },
              includeSubagents: {
                type: "boolean",
                description: "Include subagent sessions. Defaults to false.",
              },
              includeInternal: {
                type: "boolean",
                description: "Include tool/internal sessions. Defaults to false.",
              },
            },
          },
          async execute(_toolCallId, params) {
            const result = await sessionSearch(asRecord(params), cfg);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          },
        };
      },
      { name: "session_search" },
    );

    api.registerCommand({
      name: "resume",
      description: "List or resume named OpenClaw sessions",
      acceptsArgs: true,
      requireAuth: true,
      async handler(ctx) {
        const cfg = resolveConfig(api.pluginConfig);
        if (!cfg.enabled) {
          return { text: "Session resume is disabled." };
        }
        const result = await sessionResume(
          {
            label: typeof ctx.args === "string" ? ctx.args.trim() : "",
            agentId: "main",
            conversation: resolveCommandConversation(ctx),
            senderId: ctx.senderId,
          },
          cfg,
        );
        return { text: formatSessionResumeCommandReply(result) };
      },
    });

    api.registerCommand({
      name: "session-search",
      description: "Search user-visible OpenClaw session transcripts",
      acceptsArgs: true,
      requireAuth: true,
      async handler(ctx) {
        const query = typeof ctx.args === "string" ? ctx.args.trim() : "";
        if (!query) {
          return { text: "Usage: /session-search <keyword>" };
        }
        const cfg = resolveConfig(api.pluginConfig);
        if (!cfg.enabled) {
          return { text: "Session search is disabled." };
        }
        const result = await sessionSearch(
          {
            query,
            agentId: "main",
            sinceDays: cfg.sinceDays,
            limit: Math.min(cfg.defaultLimit, 5),
            maxChars: 240,
            includeAssistant: cfg.includeAssistantByDefault,
          },
          cfg,
        );
        return { text: formatSessionSearchCommandReply(result) };
      },
    });
  },
});
