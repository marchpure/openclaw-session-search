import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const require = createRequire(import.meta.url);

const DEFAULTS = {
  backend: "rg",
  fallbackToNode: true,
  defaultLimit: 8,
  maxSessions: 1000,
  maxCharsPerMessage: 800,
  maxTranscriptBytes: 256 * 1024,
  maxFiles: 1000,
  sinceDays: 30,
  timeoutMs: 3000,
  rgBatchSize: 200,
  includeAssistantByDefault: true,
  excludePluginOutputs: true,
  includeCron: false,
  includeSubagents: false,
  includeInternal: false,
};

const SEARCHABLE_ROLES = new Set(["user", "assistant", "system"]);
const LOW_SIGNAL_HAN_TERMS = new Set([
  "的",
  "了",
  "在",
  "是",
  "到",
  "和",
  "或",
  "与",
  "及",
  "未",
]);

function createJiebaSegmenter() {
  try {
    const mod = require("@node-rs/jieba");
    if (typeof mod?.Jieba === "function") {
      return new mod.Jieba();
    }
  } catch {
    // Keep the plugin usable when optional native segmentation is unavailable.
  }
  return null;
}

const JIEBA_SEGMENTER = createJiebaSegmenter();

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
    backend: cfg.backend === "node" ? "node" : DEFAULTS.backend,
    fallbackToNode:
      typeof cfg.fallbackToNode === "boolean" ? cfg.fallbackToNode : DEFAULTS.fallbackToNode,
    defaultLimit: clampInt(cfg.defaultLimit, DEFAULTS.defaultLimit, 1, 50),
    maxSessions: clampInt(cfg.maxSessions, DEFAULTS.maxSessions, 1, 50000),
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
    maxFiles: clampInt(cfg.maxFiles, DEFAULTS.maxFiles, 1, 50000),
    sinceDays: clampInt(cfg.sinceDays, DEFAULTS.sinceDays, 0, 3650),
    timeoutMs: clampInt(cfg.timeoutMs, DEFAULTS.timeoutMs, 100, 60000),
    rgBatchSize: clampInt(cfg.rgBatchSize, DEFAULTS.rgBatchSize, 1, 500),
    includeAssistantByDefault:
      typeof cfg.includeAssistantByDefault === "boolean"
        ? cfg.includeAssistantByDefault
        : DEFAULTS.includeAssistantByDefault,
    excludePluginOutputs:
      typeof cfg.excludePluginOutputs === "boolean"
        ? cfg.excludePluginOutputs
        : DEFAULTS.excludePluginOutputs,
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

function configuredAgentIds() {
  const configPath = path.join(stateRoot(), "openclaw.json");
  const config = safeReadJson(configPath);
  const agents = Array.isArray(config.agents?.list) ? config.agents.list : [];
  const ids = agents
    .map((agent) => normalizeAgentId(agent?.id))
    .filter((agentId) => fs.existsSync(sessionsDirForAgent(agentId)));
  return Array.from(new Set(ids.length > 0 ? ids : ["main"]));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function safeReadJson(filePath) {
  try {
    return readJson(filePath);
  } catch {
    return {};
  }
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

function isPluginCommandSession(entry) {
  const label = stringFromEntry(entry, "label");
  return /^\/session-search(?:\s|$)/i.test(label);
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
  if (isPluginCommandSession(entry)) {
    return "tool";
  }
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
  if (!fs.existsSync(storePath) && !fs.existsSync(dir)) return { sessions: [], stats };
  const cutoff =
    opts.sinceDays > 0 ? nowMs() - opts.sinceDays * 24 * 60 * 60 * 1000 : Number.NEGATIVE_INFINITY;
  const store = fs.existsSync(storePath) ? safeReadJson(storePath) : {};
  const indexed = Object.entries(asRecord(store));
  const indexedSessionIds = new Set(
    indexed
      .map(([, entry]) => asRecord(entry).sessionId)
      .filter((sessionId) => typeof sessionId === "string" && sessionId),
  );
  const legacy = listLegacyTranscriptEntries(dir, indexedSessionIds);
  const sessions = [...indexed, ...legacy]
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

function isIgnoredTranscriptFile(filePath) {
  const name = path.basename(String(filePath ?? "")).toLowerCase();
  return /(^|[._-])(reset|delete|deleted)([._-]|$)/.test(name);
}

function listLegacyTranscriptEntries(dir, indexedSessionIds) {
  if (!fs.existsSync(dir)) return [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => !isIgnoredTranscriptFile(name))
    .filter((name) => name.endsWith(".jsonl"))
    .filter((name) => !indexedSessionIds.has(path.basename(name, ".jsonl")))
    .map((name) => {
      const sessionId = path.basename(name, ".jsonl");
      const sessionFile = path.join(dir, name);
      let updatedAt = 0;
      try {
        updatedAt = fs.statSync(sessionFile).mtimeMs;
      } catch {
        updatedAt = 0;
      }
      return [
        `agent:main:legacy:${sessionId}`,
        {
          sessionId,
          sessionFile,
          updatedAt,
          label: sessionId,
          chatType: "direct",
          lastChannel: "legacy",
          origin: { provider: "legacy", surface: "sessions" },
          deliveryContext: { channel: "legacy" },
        },
      ];
    });
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
      timestamp: toTimestampMs(timestamp),
    };
  } catch {
    return null;
  }
}

function toTimestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readTranscriptSummary(sessionFile, maxChars = 96) {
  const empty = {
    createdAt: undefined,
    lastMessageAt: undefined,
    lastMessagePreview: "",
  };
  if (!sessionFile || !fs.existsSync(sessionFile)) return empty;
  try {
    const stat = fs.statSync(sessionFile);
    const readBytes = Math.min(stat.size, 64 * 1024);
    const fd = fs.openSync(sessionFile, "r");
    const buffer = Buffer.alloc(readBytes);
    fs.readSync(fd, buffer, 0, readBytes, Math.max(0, stat.size - readBytes));
    fs.closeSync(fd);
    const text = buffer.toString("utf8").trim();
    const lines = text ? text.split(/\r?\n/) : [];
    let createdAt;
    if (stat.size <= readBytes && lines[0]) {
      try {
        const first = JSON.parse(lines[0]);
        createdAt = toTimestampMs(first.timestamp ?? first.createdAt ?? first.ts);
      } catch {
        createdAt = undefined;
      }
    }
    for (const line of [...lines].reverse()) {
      const msg = parseTranscriptLine(line);
      if (!msg || !SEARCHABLE_ROLES.has(msg.role)) continue;
      return {
        createdAt,
        lastMessageAt: msg.timestamp,
        lastMessagePreview: `${roleLabel(msg.role)}：${singleLine(msg.text, maxChars)}`,
      };
    }
  } catch {
    return empty;
  }
  return empty;
}

function splitScriptRuns(text) {
  return String(text ?? "")
    .match(/[\p{Script=Han}]+|[\p{Script=Latin}\p{N}_-]+|[^\s\p{L}\p{N}]+/gu) ?? [];
}

function separatorVariants(tokens) {
  const variants = [];
  for (const token of tokens) {
    if (token.includes("_")) variants.push(token.replaceAll("_", "-"));
    if (token.includes("-")) variants.push(token.replaceAll("-", "_"));
  }
  return variants;
}

function normalizeTimeLikeTokens(text) {
  const source = String(text ?? "");
  const tokens = [];
  const dateTime = source.match(
    /(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/,
  );
  if (dateTime) {
    const [, year, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw] = dateTime;
    const month = monthRaw.padStart(2, "0");
    const day = dayRaw.padStart(2, "0");
    const hour = hourRaw?.padStart(2, "0");
    const minute = minuteRaw?.padStart(2, "0");
    const second = secondRaw?.padStart(2, "0");
    tokens.push(`${year}-${month}-${day}`, `${year}/${Number(month)}/${Number(day)}`, `${year}${month}${day}`);
    if (hour && minute) {
      tokens.push(`${hour}:${minute}`, `${Number(hour)}:${minute}`);
      if (second) tokens.push(`${hour}:${minute}:${second}`, `${Number(hour)}:${minute}:${second}`);
    }
  }
  for (const compact of source.match(/\d{6,14}/g) ?? []) {
    tokens.push(compact);
    if (compact.length >= 6) {
      tokens.push(`${compact.slice(0, 4)}-${compact.slice(4, 6)}`);
      tokens.push(`${compact.slice(0, 4)}/${Number(compact.slice(4, 6))}`);
    }
    if (compact.length >= 8) {
      tokens.push(`${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`);
      tokens.push(`${compact.slice(0, 4)}/${Number(compact.slice(4, 6))}/${Number(compact.slice(6, 8))}`);
    }
  }
  return tokens;
}

function normalizeTerm(value) {
  return String(value ?? "").toLowerCase().trim();
}

function uniqueTerms(items) {
  return Array.from(new Set(items.map(normalizeTerm).filter(Boolean)));
}

function isHanOnly(value) {
  return /^[\p{Script=Han}]+$/u.test(value);
}

function hasHan(value) {
  return /[\p{Script=Han}]/u.test(value);
}

function isLatinOnly(value) {
  return /^[a-z]+$/i.test(value);
}

function isMeaningfulTerm(term, raw = "") {
  if (!term) return false;
  if (/^\s+$/.test(term)) return false;
  if (/^[^\p{L}\p{N}_-]+$/u.test(term)) return false;
  if (isHanOnly(term) && (term.length <= 1 || LOW_SIGNAL_HAN_TERMS.has(term))) return false;
  if (isLatinOnly(term) && term.length <= 2 && !String(raw).includes(term.toUpperCase())) return false;
  return term.length >= 2 || !isHanOnly(term);
}

function segmentWithJieba(text) {
  if (!JIEBA_SEGMENTER) return [];
  try {
    return JIEBA_SEGMENTER.cutForSearch(String(text ?? ""), true)
      .map(normalizeTerm)
      .filter((term) => isMeaningfulTerm(term, text));
  } catch {
    return [];
  }
}

function fallbackSegmentTerms(text) {
  const terms = [];
  for (const run of splitScriptRuns(text)) {
    if (isHanOnly(run) && run.length > 2) {
      for (let index = 0; index < run.length - 1; index += 1) {
        terms.push(run.slice(index, index + 2));
      }
    } else {
      terms.push(run);
    }
  }
  return terms;
}

function tokenize(text) {
  return buildQueryPlan(text).terms;
}

function minRequiredTermMatches(termCount) {
  if (termCount <= 1) return termCount;
  if (termCount === 2) return 2;
  return Math.max(2, Math.ceil(termCount * 0.7));
}

function buildQueryPlan(text) {
  const raw = String(text ?? "").trim();
  const rawLower = raw.toLowerCase();
  const tokens = raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
  const scriptTokens = splitScriptRuns(raw)
    .map((item) => item.toLowerCase().trim())
    .filter((item) => item.length >= 2);
  const segmentedTokens = segmentWithJieba(raw);
  const fallbackTokens = fallbackSegmentTerms(raw)
    .map(normalizeTerm)
    .filter((term) => isMeaningfulTerm(term, raw));
  const semanticTokens = segmentedTokens.length > 0 ? segmentedTokens : fallbackTokens;
  const timeTokens = normalizeTimeLikeTokens(raw).map((item) => item.toLowerCase());
  const symbolTokens = (raw.match(/[^\s\p{L}\p{N}]{2,}|[\w.-]+[()[\]{}:/\\.=+\-*_#@]+[\w()[\]{}:/\\.=+\-*_#@]*/gu) ?? [])
    .map((item) => item.toLowerCase().trim())
    .filter((item) => item.length >= 2);
  const baseTokens = [rawLower, ...tokens, ...scriptTokens, ...semanticTokens, ...timeTokens, ...symbolTokens];
  const terms = uniqueTerms([...baseTokens, ...separatorVariants(baseTokens)]);
  const meaningfulTerms = uniqueTerms(semanticTokens.filter((term) => isMeaningfulTerm(term, raw)));
  const requiredTermMatches = minRequiredTermMatches(meaningfulTerms.length);
  return {
    raw,
    rawLower,
    hasHan: hasHan(raw),
    terms,
    rgTerms: terms,
    meaningfulTerms,
    requiredTermMatches,
    allowRawPhrase: meaningfulTerms.length > 0,
    requireTermCoverage: true,
  };
}

function acceptMatch(lowerText, plan, match) {
  if (!match || match.score <= 0) return false;
  if (!plan?.requireTermCoverage) return true;
  if (plan.allowRawPhrase && plan.rawLower && lowerText.includes(plan.rawLower)) return true;

  const meaningfulTerms = plan.meaningfulTerms ?? [];
  if (meaningfulTerms.length === 0) return false;
  const matchedMeaningfulTerms = meaningfulTerms.filter((term) => lowerText.includes(term));
  return matchedMeaningfulTerms.length >= plan.requiredTermMatches;
}

function matchText(text, planOrTerms) {
  const plan = Array.isArray(planOrTerms) ? { terms: planOrTerms } : planOrTerms;
  const terms = Array.isArray(planOrTerms) ? planOrTerms : planOrTerms?.terms ?? [];
  const lower = text.toLowerCase();
  let score = 0;
  let matchedTerms = 0;
  for (const term of terms) {
    if (!term) continue;
    let index = lower.indexOf(term);
    let matched = false;
    while (index !== -1) {
      score += term.length >= 4 ? 3 : 1;
      matched = true;
      index = lower.indexOf(term, index + term.length);
    }
    if (matched) matchedTerms += 1;
  }
  const result = { score: score + Math.max(0, matchedTerms - 1) * 5, matchedTerms };
  if (!acceptMatch(lower, plan, result)) return { score: 0, matchedTerms };
  return result;
}

function isPluginGeneratedTranscriptText(text) {
  const normalized = cleanTranscriptText(text);
  if (!normalized) return false;
  if (/^历史会话搜索：/.test(normalized)) return true;
  if (/^Session search is disabled\./.test(normalized)) return true;
  if (/结果 \d+ 个会话 \| 命中 \d+ 次 \| 可见会话 \d+ 个 \| 过滤 \d+ 个 \| \d+ms \((?:rg|node)\)/.test(normalized)) return true;
  if (normalized.includes("未找到匹配的用户可见会话。")) return true;
  return false;
}

function snippet(text, terms, maxChars) {
  const cleaned = cleanTranscriptText(text);
  text = cleaned || text;
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

function cleanTranscriptText(value) {
  let text = String(value ?? "");
  const metadataMarkers = [
    "\n\n你好",
    "\n\n/session-search",
    "\n\n/status",
  ];
  if (/Conversation info \(untrusted metadata\):|Sender \(untrusted metadata\):/.test(text)) {
    const hit = metadataMarkers
      .map((marker) => text.lastIndexOf(marker))
      .filter((index) => index >= 0)
      .sort((a, b) => b - a)[0];
    if (hit !== undefined) {
      text = text.slice(hit + 2);
    }
  }
  return text
    .replace(/^System: \[[^\n]+\][\s\S]*?\n\n(?=\S)/, "")
    .replace(/Conversation info \(untrusted metadata\):[\s\S]*?```\s*/g, "")
    .replace(/Sender \(untrusted metadata\):[\s\S]*?```\s*/g, "")
    .replace(/```(?:json)?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function searchableSessions(sessions, opts) {
  const accepted = [];
  let skippedMissing = 0;
  let skippedLarge = 0;
  let skippedUnsafePath = 0;
  let skippedIgnoredTranscript = 0;
  for (const session of sessions) {
    if (!session.sessionFile || !fs.existsSync(session.sessionFile)) {
      skippedMissing += 1;
      continue;
    }
    if (isIgnoredTranscriptFile(session.sessionFile)) {
      skippedIgnoredTranscript += 1;
      continue;
    }
    if (opts.sessionsDir && !isPathInside(opts.sessionsDir, session.sessionFile)) {
      skippedUnsafePath += 1;
      continue;
    }
    const size = fs.statSync(session.sessionFile).size;
    accepted.push({ ...session, size, tailOnly: size > opts.maxTranscriptBytes });
    if (accepted.length >= opts.maxFiles) break;
  }
  return { sessions: accepted, skippedMissing, skippedLarge, skippedUnsafePath, skippedIgnoredTranscript };
}

function isPathInside(parentDir, childPath) {
  const parent = path.resolve(parentDir);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function searchTranscriptNode(session, queryPlan, opts) {
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
    if (opts.excludePluginOutputs && msg.role === "assistant" && isPluginGeneratedTranscriptText(msg.text)) continue;
    const match = matchText(buildSearchText(session, msg), queryPlan);
    const score = match.score;
    if (score <= 0) continue;
    hits.push({
      score,
      matchedTerms: match.matchedTerms,
      key: session.key,
      label: session.label,
      sessionId: session.sessionId,
      updatedAt: session.updatedAt,
      createdAt: session.createdAt,
      lastMessageAt: session.lastMessageAt,
      role: msg.role,
      line: i + 1,
      timestamp: msg.timestamp,
      snippet: snippet(msg.text, queryPlan.terms, opts.maxChars),
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

function parseRgMatches(stdout, sessionByFile, queryPlan, opts) {
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
    if (opts.excludePluginOutputs && msg.role === "assistant" && isPluginGeneratedTranscriptText(msg.text)) continue;
    const match = matchText(buildSearchText(session, msg), queryPlan);
    const score = match.score;
    if (score <= 0) continue;
    hits.push({
      score,
      matchedTerms: match.matchedTerms,
      key: session.key,
      label: session.label,
      sessionId: session.sessionId,
      updatedAt: session.updatedAt,
      createdAt: session.createdAt,
      lastMessageAt: session.lastMessageAt,
      role: msg.role,
      line: Number(event.data?.line_number || 0),
      timestamp: msg.timestamp,
      snippet: snippet(msg.text, queryPlan.terms, opts.maxChars),
    });
  }
  return hits;
}

async function searchWithRg(sessions, queryPlan, opts) {
  const rgCommand = findRgCommand();
  const rgSessions = sessions.filter((session) => !session.tailOnly);
  const tailSessions = sessions.filter((session) => session.tailOnly);
  const sessionByFile = new Map(
    rgSessions.map((session) => [path.resolve(session.sessionFile), session]),
  );
  const files = rgSessions.map((session) => session.sessionFile);
  const hits = [];
  let timedOut = false;
  let failed = false;
  let stderr = "";
  for (const batch of chunkArray(files, opts.rgBatchSize)) {
    const result = await runRgBatch({
      rgCommand,
      terms: queryPlan.rgTerms,
      files: batch,
      timeoutMs: opts.timeoutMs,
    });
    if (result.timedOut) timedOut = true;
    if (!result.ok) failed = true;
    if (result.stderr) stderr = result.stderr.slice(0, 1000);
    hits.push(...parseRgMatches(result.stdout, sessionByFile, queryPlan, opts));
    if (hits.length >= opts.limit * 8 || timedOut || failed) break;
  }
  if (!timedOut && !failed && hits.length < opts.limit * 8 && tailSessions.length > 0) {
    hits.push(...searchWithNode(tailSessions, queryPlan, opts).hits);
  }
  return {
    hits,
    meta: {
      backend: "rg",
      rgCommand,
      timedOut,
      failed,
      stderr,
      tailScannedLargeFiles: tailSessions.length,
    },
  };
}

function attachTranscriptSummaries(sessions) {
  return sessions.map((session) => ({
    ...session,
    label: normalizeSessionLabel(session.label),
    displayName: sessionDisplayName(session),
    ...readTranscriptSummary(session.sessionFile),
  }));
}

function buildSearchText(session, msg) {
  const parts = [
    msg.text,
    session.key,
    session.label,
    session.sessionId,
    formatSearchTimestamp(msg.timestamp),
    formatSearchTimestamp(session.createdAt),
    formatSearchTimestamp(session.lastMessageAt),
    formatSearchTimestamp(session.updatedAt),
  ];
  return parts.filter(Boolean).join("\n");
}

function buildSessionMetadataSearchText(session) {
  return [
    session.key,
    session.label,
    session.displayName,
    session.sessionId,
    formatSearchTimestamp(session.createdAt),
    formatSearchTimestamp(session.lastMessageAt),
    formatSearchTimestamp(session.updatedAt),
  ]
    .filter(Boolean)
    .join("\n");
}

function searchSessionMetadata(session, queryPlan, opts) {
  const match = matchText(buildSessionMetadataSearchText(session), queryPlan);
  if (match.score <= 0) return null;
  return {
    score: match.score,
    matchedTerms: match.matchedTerms,
    key: session.key,
    label: session.label,
    sessionId: session.sessionId,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    lastMessageAt: session.lastMessageAt,
    role: "system",
    line: 0,
    timestamp: session.lastMessageAt || session.updatedAt || session.createdAt,
    snippet: snippet(buildSessionMetadataSearchText(session), queryPlan.terms, opts.maxChars),
  };
}

function formatSearchTimestamp(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  const date = new Date(n);
  const local = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const year = local.getFullYear();
  const month = String(local.getMonth() + 1).padStart(2, "0");
  const day = String(local.getDate()).padStart(2, "0");
  const hour = String(local.getHours()).padStart(2, "0");
  const minute = String(local.getMinutes()).padStart(2, "0");
  const second = String(local.getSeconds()).padStart(2, "0");
  return [
    `${year}-${month}-${day} ${hour}:${minute}:${second}`,
    `${year}/${Number(month)}/${Number(day)} ${Number(hour)}:${minute}:${second}`,
    `${year}${month}${day}`,
  ].join(" ");
}

function normalizeSessionLabel(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sessionDisplayName(session) {
  return normalizeSessionLabel(session.label) || session.key || session.sessionId || "session";
}

function hitSortTime(hit) {
  return Number(hit?.timestamp || hit?.lastMessageAt || hit?.updatedAt || 0);
}

function scoreSessionHits(hits) {
  const sorted = [...hits].sort(
    (a, b) =>
      Number(b.matchedTerms || 0) - Number(a.matchedTerms || 0) ||
      Number(b.score || 0) - Number(a.score || 0) ||
      hitSortTime(b) - hitSortTime(a),
  );
  const bestHit = sorted[0];
  const topHitScore = sorted
    .slice(1, 4)
    .reduce((sum, hit) => sum + Number(hit.score || 0) * 0.25, 0);
  return {
    bestHit,
    bestMatchedTerms: Number(bestHit?.matchedTerms || 0),
    sessionScore:
      Number(bestHit?.score || 0) + topHitScore + Math.log1p(sorted.length) * 2,
    lastHitAt: sorted.reduce((latest, hit) => Math.max(latest, hitSortTime(hit)), 0),
    hits: sorted,
  };
}

function compareSessionGroups(a, b) {
  return (
    Number(b.bestMatchedTerms || 0) - Number(a.bestMatchedTerms || 0) ||
    Number(b.sessionScore || 0) - Number(a.sessionScore || 0) ||
    Number(b.lastHitAt || 0) - Number(a.lastHitAt || 0) ||
    Number(b.updatedAt || 0) - Number(a.updatedAt || 0)
  );
}

function groupHitsBySession(hits, maxHitsPerSession = 2) {
  const groups = [];
  const byKey = new Map();
  for (const hit of hits) {
    const key = hit.key || hit.sessionId || "unknown";
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        label: hit.label,
        sessionId: hit.sessionId,
        updatedAt: hit.updatedAt,
        createdAt: hit.createdAt,
        lastMessageAt: hit.lastMessageAt,
        hitCount: 0,
        allHits: [],
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.hitCount += 1;
    group.allHits.push(hit);
  }
  return groups.map((group) => {
    const scored = scoreSessionHits(group.allHits);
    return {
      ...group,
      bestHit: scored.bestHit,
      bestMatchedTerms: scored.bestMatchedTerms,
      sessionScore: scored.sessionScore,
      lastHitAt: scored.lastHitAt,
      hits: scored.hits.slice(0, maxHitsPerSession),
      allHits: undefined,
    };
  });
}

function searchWithNode(sessions, queryPlan, opts) {
  return {
    hits: sessions.flatMap((session) =>
      searchTranscriptNode(session, queryPlan, {
        includeAssistant: opts.includeAssistant,
        excludePluginOutputs: opts.excludePluginOutputs,
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

function cleanDisplaySnippet(value, query) {
  let text = cleanTranscriptText(value);
  const queryText = String(query ?? "").trim();
  if (queryText) {
    const hit = text.toLowerCase().lastIndexOf(queryText.toLowerCase());
    if (hit > 0 && /[{}":]/.test(text.slice(0, hit))) {
      text = text.slice(hit).trim();
    }
  }
  return singleLine(text, 96);
}

function parseSessionSearchCommandArgs(args) {
  const tokens = String(args ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let agentId = "";
  const queryParts = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--agent" || token === "--agent-id" || token === "--agentId") {
      agentId = tokens[index + 1] || "";
      index += 1;
      continue;
    }
    const match = token.match(/^agentId=(.+)$/i) || token.match(/^agent=(.+)$/i);
    if (match) {
      agentId = match[1];
      continue;
    }
    queryParts.push(token);
  }
  return {
    query: queryParts.join(" ").trim(),
    agentId: agentId.trim(),
  };
}

function formatSessionSearchCommandReply(result) {
  const filtered =
    result.filteredSubagent + result.filteredCron + result.filteredTool + result.filteredInternal;
  const sessions = Array.isArray(result.results) ? result.results : [];
  const hitCount = Number(result.hitCount ?? 0);
  const agentCount = Array.isArray(result.agentsSearched) ? result.agentsSearched.length : 1;
  const lines = [
    `历史会话搜索：${result.query}`,
    "",
    `结果 ${sessions.length} 个会话 | 命中 ${hitCount} 次 | agent ${agentCount} 个 | 可见会话 ${result.searchedFiles} 个 | 过滤 ${filtered} 个 | ${result.tookMs}ms (${result.backend})`,
  ];
  if (!sessions.length) {
    lines.push("", "未找到匹配的用户可见会话。");
    return lines.join("\n");
  }
  lines.push("");
  sessions.forEach((item, index) => {
    const lastTime = formatTime(item.lastMessageAt || item.updatedAt);
    const displayName = item.displayName || item.label || item.key || item.sessionId || "session";
    const recentHits = Array.isArray(item.hits) ? item.hits.slice(0, 2) : [];
    lines.push(`--- ${index + 1}/${sessions.length} ---`);
    if (item.agentId) lines.push(`Agent：${singleLine(item.agentId, 48)}`);
    lines.push(`会话：${singleLine(displayName, 56)}`);
    lines.push(`命中次数：${item.hitCount || recentHits.length}`);
    if (item.key && item.key !== displayName) lines.push(`会话ID：${singleLine(item.key, 96)}`);
    if (lastTime) lines.push(`最近交流：${lastTime}`);
    if (recentHits.length > 0) {
      lines.push("最近命中：");
      recentHits.forEach((hit, hitIndex) => {
        const hitTime = formatTime(hit.timestamp);
        const hitParts = [
          hitTime || "未知时间",
          roleLabel(hit.role),
          cleanDisplaySnippet(hit.snippet, result.query),
        ].filter(Boolean);
        lines.push(`  ${hitIndex + 1}. ${hitParts.join(" | ")}`);
      });
    }
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
  const maxSessions = clampInt(params.maxSessions, cfg.maxSessions, 1, 50000);
  const maxChars = clampInt(params.maxChars, cfg.maxCharsPerMessage, 80, 4000);
  const maxTranscriptBytes = clampInt(
    params.maxTranscriptBytes,
    cfg.maxTranscriptBytes,
    4096,
    2 * 1024 * 1024,
  );
  const maxFiles = clampInt(params.maxFiles, cfg.maxFiles, 1, 50000);
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
  const queryPlan = buildQueryPlan(query);
  if (queryPlan.terms.length === 0) throw new Error("query has no searchable terms");
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
  const selectedSessions = attachTranscriptSummaries(selected.sessions);
  const searchOpts = {
    limit,
    includeAssistant,
    maxChars,
    maxTranscriptBytes,
    timeoutMs,
    rgBatchSize,
    excludePluginOutputs: cfg.excludePluginOutputs,
  };
  let search =
    cfg.backend === "rg"
      ? await searchWithRg(selectedSessions, queryPlan, searchOpts)
      : searchWithNode(selectedSessions, queryPlan, searchOpts);
  if (search.meta.failed && cfg.fallbackToNode) {
    search = searchWithNode(selectedSessions, queryPlan, searchOpts);
    search.meta.fallbackFrom = "rg";
  }
  const metadataHits = selectedSessions
    .map((session) => searchSessionMetadata(session, queryPlan, searchOpts))
    .filter(Boolean);
  const sortedHits = search.hits
    .concat(metadataHits)
    .sort(
      (a, b) =>
        Number(b.matchedTerms || 0) - Number(a.matchedTerms || 0) ||
        b.score - a.score ||
        Number(b.timestamp || b.lastMessageAt || b.updatedAt || 0) -
          Number(a.timestamp || a.lastMessageAt || a.updatedAt || 0),
    );
  const sessionGroups = groupHitsBySession(sortedHits).sort(compareSessionGroups).slice(0, limit);
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
    skippedIgnoredTranscript: selected.skippedIgnoredTranscript,
    filteredSubagent: listed.stats.filteredSubagent,
    filteredCron: listed.stats.filteredCron,
    filteredTool: listed.stats.filteredTool,
    filteredInternal: listed.stats.filteredInternal,
    sinceDays,
    maxTranscriptBytes,
    tookMs: Date.now() - startedAt,
    count: sessionGroups.length,
    hitCount: sortedHits.length,
    results: sessionGroups.map((group) => ({
      key: group.key,
      label: group.label,
      agentId,
      displayName: group.label || group.key || group.sessionId || "session",
      sessionId: group.sessionId,
      updatedAt: group.updatedAt,
      createdAt: group.createdAt,
      lastMessageAt: group.lastMessageAt,
      hitCount: group.hitCount,
      hits: group.hits,
    })),
    sessionGroupCount: sessionGroups.length,
    sessionGroups,
    debug: {
      ...search.meta,
      stderr: search.meta.stderr || undefined,
    },
  };
}

async function sessionSearchAllAgents(params, cfg) {
  const startedAt = Date.now();
  const query = typeof params.query === "string" ? params.query.trim() : "";
  if (!query) throw new Error("query is required");
  const limit = clampInt(params.limit, cfg.defaultLimit, 1, 50);
  const agentIds = configuredAgentIds();
  const perAgentLimit = Math.max(limit, 5);
  const results = await Promise.all(
    agentIds.map((agentId) =>
      sessionSearch(
        {
          ...params,
          agentId,
          limit: perAgentLimit,
        },
        cfg,
      ),
    ),
  );
  const mergedGroups = results
    .flatMap((result) =>
      (Array.isArray(result.sessionGroups) ? result.sessionGroups : []).map((group) => ({
        ...group,
        agentId: result.agentId,
        displayName: group.displayName || group.label || group.key || group.sessionId || "session",
        hits: Array.isArray(group.hits)
          ? group.hits.map((hit) => ({ ...hit, agentId: result.agentId }))
          : [],
      })),
    )
    .sort(
      (a, b) =>
        compareSessionGroups(a, b),
    )
    .slice(0, limit);
  const backends = Array.from(new Set(results.map((result) => result.backend).filter(Boolean)));
  return {
    query,
    agentId: "all",
    agentsSearched: agentIds,
    backend: backends.join("+") || cfg.backend,
    candidateSessions: results.reduce((sum, result) => sum + Number(result.candidateSessions || 0), 0),
    visibleSessions: results.reduce((sum, result) => sum + Number(result.visibleSessions || 0), 0),
    searchedSessions: results.reduce((sum, result) => sum + Number(result.searchedSessions || 0), 0),
    searchedFiles: results.reduce((sum, result) => sum + Number(result.searchedFiles || 0), 0),
    skippedMissing: results.reduce((sum, result) => sum + Number(result.skippedMissing || 0), 0),
    skippedLarge: results.reduce((sum, result) => sum + Number(result.skippedLarge || 0), 0),
    skippedUnsafePath: results.reduce((sum, result) => sum + Number(result.skippedUnsafePath || 0), 0),
    skippedIgnoredTranscript: results.reduce(
      (sum, result) => sum + Number(result.skippedIgnoredTranscript || 0),
      0,
    ),
    filteredSubagent: results.reduce((sum, result) => sum + Number(result.filteredSubagent || 0), 0),
    filteredCron: results.reduce((sum, result) => sum + Number(result.filteredCron || 0), 0),
    filteredTool: results.reduce((sum, result) => sum + Number(result.filteredTool || 0), 0),
    filteredInternal: results.reduce((sum, result) => sum + Number(result.filteredInternal || 0), 0),
    sinceDays: clampInt(params.sinceDays, cfg.sinceDays, 0, 3650),
    maxTranscriptBytes: clampInt(
      params.maxTranscriptBytes,
      cfg.maxTranscriptBytes,
      4096,
      2 * 1024 * 1024,
    ),
    tookMs: Date.now() - startedAt,
    count: mergedGroups.length,
    hitCount: results.reduce((sum, result) => sum + Number(result.hitCount || 0), 0),
    results: mergedGroups.map((group) => ({
      key: group.key,
      label: group.label,
      agentId: group.agentId,
      displayName: group.displayName,
      sessionId: group.sessionId,
      updatedAt: group.updatedAt,
      createdAt: group.createdAt,
      lastMessageAt: group.lastMessageAt,
      hitCount: group.hitCount,
      hits: group.hits,
    })),
    sessionGroupCount: mergedGroups.length,
    sessionGroups: mergedGroups,
    debug: {
      agents: results.map((result) => ({
        agentId: result.agentId,
        searchedFiles: result.searchedFiles,
        hitCount: result.hitCount,
        backend: result.backend,
      })),
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
        try {
          const input = asRecord(params);
          const result =
            typeof input.agentId === "string" && input.agentId.trim()
              ? await sessionSearch(input, cfg)
              : await sessionSearchAllAgents(input, cfg);
          respond(true, result);
        } catch (error) {
          respond(false, undefined, {
            code: "session_search_failed",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
      { scope: "operator.read" },
    );

  api.registerTool(
      () => {
        const cfg = resolveConfig(api.pluginConfig);
        return {
          name: "session_search",
          label: "Session Search",
          description:
            "Search prior OpenClaw session transcripts across all active agents by default. Use for low-frequency recall of previous conversations, tasks, decisions, or blocked work. This is independent from memory_recall and does not use the memory slot.",
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["query"],
            properties: {
              query: { type: "string", description: "Search query." },
              agentId: {
                type: "string",
                description: "Optional agent id to search. If omitted, searches all active agents.",
              },
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
            },
          },
          async execute(_toolCallId, params) {
            const input = asRecord(params);
            const result =
              typeof input.agentId === "string" && input.agentId.trim()
                ? await sessionSearch(input, cfg)
                : await sessionSearchAllAgents(input, cfg);
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
      name: "session-search",
      description: "Search user-visible OpenClaw session transcripts",
      acceptsArgs: true,
      requireAuth: true,
      async handler(ctx) {
        const { query, agentId } = parseSessionSearchCommandArgs(ctx.args);
        if (!query) {
          return { text: "Usage: /session-search [--agent <agentId>] <keyword>" };
        }
        const cfg = resolveConfig(api.pluginConfig);
        const input = {
          query,
          sinceDays: cfg.sinceDays,
          limit: Math.min(cfg.defaultLimit, 5),
          maxChars: 240,
          includeAssistant: cfg.includeAssistantByDefault,
        };
        const result = agentId
          ? await sessionSearch({ ...input, agentId }, cfg)
          : await sessionSearchAllAgents(input, cfg);
        return { text: formatSessionSearchCommandReply(result) };
      },
    });
  },
});
