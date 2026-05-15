# openclaw-session-search

Independent OpenClaw plugin for low-frequency session transcript search.

The plugin exposes:

- Gateway RPC: `session-search.search`
- Tool: `session_search`
- Slash command: `/session-search <keyword>`

It searches recent user-visible session transcripts with `rg` when available, with a deterministic Node.js fallback. It does not call a model and does not depend on the configured memory slot.

## Behavior

By default, the plugin only searches sessions that look user-visible in `sessions.json`, similar to the surface expected from `sessions.list`.

Filtered by default:

- Subagent sessions
- Cron sessions and cron run aliases
- Tool sessions
- Internal sessions without user-facing channel metadata
- Transcript paths outside the agent `sessions` directory

Optional flags can include hidden classes for operator diagnostics:

- `includeSubagents`
- `includeCron`
- `includeInternal`

## Example

```bash
openclaw gateway call session-search.search \
  --params '{"query":"resume task","agentId":"main","sinceDays":2,"limit":8}' \
  --json
```

From a chat channel that supports OpenClaw plugin commands, including Feishu/Lark:

```text
/session-search resume task
```

The command returns deterministic text directly from the plugin. It does not call a model.

## Configuration

```json
{
  "enabled": true,
  "backend": "rg",
  "fallbackToNode": true,
  "defaultLimit": 8,
  "maxSessions": 200,
  "maxCharsPerMessage": 800,
  "maxTranscriptBytes": 262144,
  "maxFiles": 1000,
  "sinceDays": 2,
  "timeoutMs": 3000,
  "rgBatchSize": 200,
  "includeAssistantByDefault": true,
  "includeCron": false,
  "includeSubagents": false,
  "includeInternal": false
}
```

## Validation

Validated against a live OpenClaw gateway:

- Functional search over recent Feishu/webchat sessions
- Zero-hit query behavior
- `maxSessions`, `maxFiles`, and timeout parameter handling
- Default filtering of subagent, cron, tool, and internal sessions
- Path traversal guard for transcript paths outside the agent session directory
- `rg` search over 5800 sessions and about 24 MB of transcript data
