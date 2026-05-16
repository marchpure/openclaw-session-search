# Session Search And Resume End-To-End

This document describes the user-facing flow from `/session-search` to `/resume` to `/resume <target>`, then explains the technical implementation and validation results.

## User Guide

### Find A Previous Conversation

Use `/session-search <keyword>` in Feishu or another OpenClaw chat channel:

```text
/session-search 你好
```

The command searches recent user-visible OpenClaw session transcripts and returns deterministic text directly from the plugin. It does not call a model.

Typical result:

```text
历史会话搜索：你好

结果 5 条 | 可见会话 7 个 | 过滤 1 个 | 12ms (rg)

--- 1/5 ---
会话：resume-test-alpha
恢复ID：agent:main:resume-test-alpha
命中时间：2026/5/15 20:34:14
最近交流：2026/5/15 20:36:28
角色：用户
片段：你好，你以后回复我都带“哦”结尾
```

Field meanings:

- `会话`: the human-readable session name. If the session has no label, this falls back to the session key.
- `恢复ID`: the stable session key. This can always be copied into `/resume <恢复ID>`.
- `命中时间`: the exact transcript message time where the keyword matched.
- `最近交流`: the latest user/assistant/system message time in that session.
- `角色`: the matched transcript message role.
- `片段`: a cleaned, compact text snippet around the match.

### List Resumable Conversations

Use `/resume` without arguments:

```text
/resume
```

Typical result:

```text
可恢复会话：7 个
范围：可见会话 7 个

--- 1/7 ---
会话：agent:main:main
创建：2026/5/15 19:33:42
最近交流：2026/5/15 19:57:48
最近：助手：当前没有运行中的可见会话哦。如果需要创建新的子会话来执行任务，可以随时告诉我需求~

--- 2/7 ---
会话：resume-test-alpha
恢复ID：agent:main:resume-test-alpha
创建：2026/5/15 20:08:31
最近交流：2026/5/15 20:36:28
最近：助手：我以后给你回复都会带“哦”结尾哦。

使用：/resume <会话或恢复ID>
```

The list is meant for direct use in chat:

- If `会话` is already a stable key, use it directly.
- If `恢复ID` is shown, copy `恢复ID`.
- Prefer `恢复ID` when there is any ambiguity.

### Resume A Conversation

Resume by label:

```text
/resume resume-test-alpha
```

Resume by stable session key:

```text
/resume agent:main:main
```

Successful result:

```text
已恢复会话：agent:main:main

恢复ID：agent:main:main
绑定：generic:feishu␟default␟␟user:ou_b68d71bae6ab31447520bf65d4533015
后续消息会继续进入这个会话。
```

After this succeeds, normal follow-up messages in the same Feishu conversation are routed to the resumed OpenClaw session.

### Recommended Workflow

1. Use `/session-search <keyword>` to find relevant history.
2. Copy `恢复ID` from the search result.
3. Run `/resume <恢复ID>`.
4. Send a normal message to continue that session.

For example:

```text
/session-search ACP编码代理调用失败
/resume agent:main:resume-test-alpha
继续刚才的问题
```

## Technical Design

### Plugin Surfaces

The plugin exposes:

- Slash command: `/session-search <keyword>`
- Slash command: `/resume [session-label-or-key]`
- Gateway RPC: `session-search.search`
- Gateway RPC: `session-search.resume`
- Tool: `session_search`

The slash commands bypass model invocation. They execute deterministic plugin code and return formatted text.

### Session Source

The plugin reads OpenClaw session metadata from:

```text
~/.openclaw/agents/<agentId>/sessions/sessions.json
```

For each eligible session it resolves the transcript file from `sessionFile`, or falls back to:

```text
~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl
```

Transcript paths are checked to stay inside the agent sessions directory before search.

### Visibility And Filtering

By default, both `/session-search` and `/resume` only operate on user-visible sessions.

Filtered by default:

- subagent sessions
- cron sessions and cron run aliases
- tool sessions
- internal sessions without user-facing channel metadata
- unsafe transcript paths outside the session directory

This keeps search and resume aligned: if a session is intentionally hidden from normal user workflows, it is not shown as a default resume target.

### Search Backend

Search uses `rg` as the fast path:

```text
rg --json --fixed-strings --ignore-case --line-number --with-filename
```

If `rg` fails and fallback is enabled, the plugin uses a deterministic Node.js scanner.

The search path does not call a model. Ranking is simple and deterministic:

1. higher term match score
2. newer matching message time
3. newer session activity time

Search results include:

- session key
- label
- session id
- transcript creation time
- latest transcript message time
- hit message time
- role
- line number
- cleaned snippet

### Snippet Cleaning

OpenClaw channel transcripts may contain untrusted runtime metadata in user messages. The plugin cleans snippets before returning them from both Gateway RPC and slash commands.

The cleaning removes blocks such as:

- `Conversation info (untrusted metadata)`
- `Sender (untrusted metadata)`
- fenced JSON metadata
- leading runtime `System: [...]` channel envelope

This prevents Feishu output from showing raw sender metadata and keeps search results readable.

### Resume Resolution

`/resume <target>` resolves in this order:

1. exact session label
2. exact session key
3. case-insensitive label
4. case-insensitive session key

This supports both friendly names like:

```text
resume-test-alpha
```

and stable keys like:

```text
agent:main:main
```

If no target is provided, `/resume` lists resumable sessions instead of binding.

### Conversation Binding

When a target is resolved, the plugin dynamically imports OpenClaw's runtime session binding service from the installed OpenClaw dist directory.

It then calls the binding service with:

```json
{
  "targetSessionKey": "agent:main:main",
  "targetKind": "session",
  "placement": "current",
  "conversation": {
    "channel": "feishu",
    "accountId": "default",
    "conversationId": "user:..."
  }
}
```

The current implementation is intentionally plugin-first. It avoids changing OpenClaw core for the user-facing command while still using OpenClaw's real session binding service for routing.

### Ownership Guard

If an existing binding has `metadata.boundBy`, and a different sender tries to resume the same conversation, the plugin rejects the operation. This preserves the ownership behavior from the core `/resume` implementation.

### Relationship To OpenClaw Core `/resume`

The plugin registers `/resume` as a plugin command. OpenClaw executes plugin commands before built-in command handling, so this plugin implementation handles `/resume` in Feishu even when a native command with the same name is listed by command discovery.

## Validation Results

### Static And Deployment Checks

Verified:

- `node --check index.js`
- `node --check scripts/validate-e2e.mjs`
- `node --check scripts/validate-live-openclaw.mjs`
- gateway restart succeeds
- gateway service state is `active/running`
- `/resume` plugin command is registered
- `/session-search` plugin command is registered

### Local Matrix

Command:

```bash
node scripts/validate-e2e.mjs
```

This matrix creates a temporary OpenClaw state directory and exercises plugin Gateway methods and slash command handlers through a stubbed plugin SDK. It is useful for high-volume deterministic regression checks.

Latest result:

```json
{
  "ok": true,
  "cases": 300,
  "resumeList": {
    "count": 3003,
    "filteredCron": 120,
    "filteredSubagent": 120
  },
  "performance": {
    "searchNeedleMs": 131,
    "totalMs": 9740
  }
}
```

Coverage includes:

- functionality
- filtering
- display consistency
- usability
- large-data behavior
- performance
- reliability
- experience

### Live OpenClaw Matrix

Command:

```bash
node scripts/validate-live-openclaw.mjs
```

This matrix uses the running `openclaw gateway call` binary only. It uses the current real OpenClaw state and real session transcripts. It also performs real resume bindings against the current Feishu conversation, then restores:

```text
~/.openclaw/bindings/current-conversations.json
```

Latest result:

```json
{
  "ok": true,
  "cases": 3001,
  "requestedCases": 3000,
  "liveOnly": true,
  "liveData": {
    "sessions": 7,
    "helloResults": 6,
    "searchBackend": "rg",
    "searchedFiles": 7,
    "filteredSubagent": 1,
    "filteredCron": 0
  },
  "performance": {
    "resumeListMs": 1591,
    "searchHelloMs": 1565,
    "totalMs": 48260
  }
}
```

The live matrix validates the deployed plugin against real data. Its data volume depends on the current OpenClaw installation. In the latest run, the real environment had 7 resumable visible sessions and 6 search hits for `你好`.

### Real Issue Found During Live Validation

The live 3000-case matrix found that one raw Gateway search snippet still exposed Feishu sender metadata from a real transcript message. The plugin was already cleaning slash output, but RPC results still contained the raw snippet.

Fix applied:

- moved transcript snippet cleaning into the search result generation layer
- both Gateway RPC and slash command output now receive cleaned snippets

Confirmed after fix:

```text
你好~ 有什么需要我帮忙处理的吗？不管是工作任务、信息查询还是日常需求都可以告诉我哦。
你好
你好呀~ 有什么我可以帮你的吗？无论是处理文件、查询信息、安排日程还是其他需求，都可以随时告诉我。
```

No raw `Sender (untrusted metadata)` or `Conversation info (untrusted metadata)` text remains in search snippets.

### Current Limitations

- Live large-data validation can only be as large as the current real OpenClaw state.
- The local large-data matrix covers thousands of generated sessions; the live matrix covers the actual deployed state.
- The plugin dynamically imports OpenClaw internal session binding chunks, so compatibility should be revalidated after OpenClaw upgrades.
