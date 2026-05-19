#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ID="session-search"
DEFAULT_PACKAGE_URL="https://haoxingjun-test.tos-cn-beijing.volces.com/openclaw-session-search/openclaw-session-search-0.1.0.tgz"
DEFAULT_REPO_SPEC="https://github.com/marchpure/openclaw-session-search.git#feat/session-search-ui-refresh"

if [ -n "${OPENCLAW_STATE_DIR:-}" ]; then
  OPENCLAW_STATE_DIR_RESOLVED="$OPENCLAW_STATE_DIR"
elif [ -n "${OPENCLAW_HOME:-}" ]; then
  OPENCLAW_STATE_DIR_RESOLVED="$OPENCLAW_HOME/.openclaw"
else
  OPENCLAW_STATE_DIR_RESOLVED="$HOME/.openclaw"
fi

PACKAGE_URL="${OPENCLAW_SESSION_SEARCH_PACKAGE_URL:-$DEFAULT_PACKAGE_URL}"
REPO_SPEC="${OPENCLAW_SESSION_SEARCH_REPO_SPEC:-$DEFAULT_REPO_SPEC}"
SKIP_GATEWAY_RESTART="${OPENCLAW_SESSION_SEARCH_SKIP_GATEWAY_RESTART:-0}"

log() {
  printf '[openclaw-session-search] %s\n' "$*"
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

patch_lark_conversation_bindings() {
  node <<'NODE'
const fs = require('fs');
const path = require('path');

const home = process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME || '/root', '.openclaw');
const candidates = [
  path.join(home, 'extensions', 'openclaw-lark'),
  path.join(home, 'extensions', 'feishu'),
  path.join(home, 'extensions', '@larksuite', 'openclaw-lark'),
  '/usr/lib/node_modules/@larksuite/openclaw-lark',
].filter((dir, index, all) => all.indexOf(dir) === index);

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function write(file, text) {
  fs.writeFileSync(file, text);
}

function backup(file, original) {
  const backupPath = `${file}.session-search-backup`;
  if (!fs.existsSync(backupPath)) {
    fs.writeFileSync(backupPath, original);
  }
}

function patchChannelPlugin(file) {
  const original = read(file);
  if (!original) return { touched: false, reason: 'missing' };
  if (original.includes('supportsCurrentConversationBinding')) {
    return { touched: false, reason: 'already-present' };
  }

  const marker = "    // -------------------------------------------------------------------------\n    // Agent prompt";
  const insertion =
    "    conversationBindings: {\n" +
    "        supportsCurrentConversationBinding: true,\n" +
    "    },\n" +
    marker;

  if (!original.includes(marker)) {
    return { touched: false, reason: 'marker-not-found' };
  }

  backup(file, original);
  write(file, original.replace(marker, insertion));
  return { touched: true, reason: 'patched' };
}

function patchSingleFileIndex(file) {
  const original = read(file);
  if (!original) return { touched: false, reason: 'missing' };
  if (original.includes('supportsCurrentConversationBinding')) {
    return { touched: false, reason: 'already-present' };
  }

  const marker = "    register(api) {";
  const insertion =
    "    conversationBindings: {\n" +
    "        supportsCurrentConversationBinding: true,\n" +
    "    },\n" +
    marker;

  if (!original.includes(marker)) {
    return { touched: false, reason: 'marker-not-found' };
  }

  backup(file, original);
  write(file, original.replace(marker, insertion));
  return { touched: true, reason: 'patched-index' };
}

let found = false;
const reports = [];
for (const dir of candidates) {
  if (!fs.existsSync(dir)) continue;
  found = true;
  const channelFile = path.join(dir, 'src', 'channel', 'plugin.js');
  const indexFile = path.join(dir, 'index.js');

  const channel = patchChannelPlugin(channelFile);
  reports.push(`${channelFile}: ${channel.reason}`);

  if (channel.reason === 'missing' || channel.reason === 'marker-not-found') {
    const index = patchSingleFileIndex(indexFile);
    reports.push(`${indexFile}: ${index.reason}`);
  }
}

if (!found) {
  console.log('openclaw-lark extension not found; skipped conversation binding patch');
  process.exit(0);
}

for (const report of reports) console.log(report);
NODE
}

remove_legacy_config_enabled() {
  OPENCLAW_STATE_DIR="$OPENCLAW_STATE_DIR_RESOLVED" node <<'NODE'
const fs = require('fs');
const path = require('path');

const home = process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME || '/root', '.openclaw');
const configPath = path.join(home, 'openclaw.json');

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch {
  process.exit(0);
}

const entry = config.plugins?.entries?.['session-search'];
if (!entry?.config || !Object.prototype.hasOwnProperty.call(entry.config, 'enabled')) {
  process.exit(0);
}

delete entry.config.enabled;
if (Object.keys(entry.config).length === 0) {
  delete entry.config;
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
console.log('removed legacy plugins.entries.session-search.config.enabled');
NODE
}

install_plugin() {
  local tmpdir package_file
  tmpdir="$(mktemp -d)"
  package_file="$tmpdir/openclaw-session-search.tgz"

  if command -v curl >/dev/null 2>&1; then
    log "downloading plugin package: $PACKAGE_URL"
    if curl -fsSL "$PACKAGE_URL" -o "$package_file"; then
      openclaw plugins install --force --dangerously-force-unsafe-install "$package_file"
      return
    fi
    log "package download failed; falling back to git install: $REPO_SPEC"
  fi

  openclaw plugins install --force --dangerously-force-unsafe-install "$REPO_SPEC"
}

configure_plugin() {
  openclaw plugins enable "$PLUGIN_ID" || true
  remove_legacy_config_enabled
}

restart_gateway() {
  if [ "$SKIP_GATEWAY_RESTART" = "1" ]; then
    log "gateway restart skipped by OPENCLAW_SESSION_SEARCH_SKIP_GATEWAY_RESTART=1"
    return
  fi

  if openclaw gateway restart >/tmp/openclaw-session-search-gateway-restart.log 2>&1; then
    log "gateway restarted"
    return
  fi

  log "gateway restart command failed; restart output follows"
  sed -n '1,120p' /tmp/openclaw-session-search-gateway-restart.log >&2
  exit 1
}

verify_install() {
  if [ ! -f "$OPENCLAW_STATE_DIR_RESOLVED/extensions/session-search/index.js" ]; then
    log "installed plugin entrypoint not found at $OPENCLAW_STATE_DIR_RESOLVED/extensions/session-search/index.js"
    exit 1
  fi

  node --check "$OPENCLAW_STATE_DIR_RESOLVED/extensions/session-search/index.js" >/tmp/openclaw-session-search-node-check.log 2>&1 || {
    log "installed plugin entrypoint failed node --check"
    sed -n '1,120p' /tmp/openclaw-session-search-node-check.log >&2
    exit 1
  }

  timeout 20s openclaw plugins inspect "$PLUGIN_ID" >/tmp/openclaw-session-search-inspect.log 2>&1 || {
    log "plugin inspect did not complete successfully"
    sed -n '1,160p' /tmp/openclaw-session-search-inspect.log >&2
    exit 1
  }

  log "plugin static verification succeeded"

  if [ "$SKIP_GATEWAY_RESTART" = "1" ]; then
    log "gateway probe skipped because gateway restart was skipped"
    return
  fi

  if timeout 20s openclaw gateway call session-search.search \
      --params '{"query":"__openclaw_session_search_install_probe__","agentId":"main","limit":1,"sinceDays":2}' \
      --json >/tmp/openclaw-session-search-probe.json 2>/tmp/openclaw-session-search-probe.err; then
    log "session-search gateway probe succeeded"
  else
    log "session-search gateway probe failed"
    sed -n '1,120p' /tmp/openclaw-session-search-probe.err >&2
    exit 1
  fi
}

main() {
  need_cmd openclaw
  need_cmd node

  log "OPENCLAW_STATE_DIR=$OPENCLAW_STATE_DIR_RESOLVED"
  remove_legacy_config_enabled
  install_plugin
  configure_plugin

  log "patching openclaw-lark conversation binding support"
  OPENCLAW_STATE_DIR="$OPENCLAW_STATE_DIR_RESOLVED" patch_lark_conversation_bindings

  restart_gateway
  verify_install

  log "done"
  log "Feishu commands now available: /session-search <keyword>"
}

main "$@"
