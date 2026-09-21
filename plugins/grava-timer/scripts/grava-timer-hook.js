#!/usr/bin/env node
// Grava timer hook — Claude Code -> Grava time entries, for CLOUD project threads.
//
// Shipped as a plugin so it loads into every thread of a Claude Code Project
// (local machine config never reaches a cloud sandbox). Registered for
// UserPromptSubmit (start), Stop / SessionEnd (stop), Notification (pause),
// and PreToolUse (resume + heartbeat). One timer per thread, keyed by
// externalRef = the session id, so parallel threads track independently.
//
// Where the Grava binding comes from — resolved in this order:
//   1. Environment variables set on the project's cloud environment:
//        GRAVA_API_URL     e.g. https://baseback-production.up.railway.app
//        GRAVA_PROJECT_ID  Grava project _id   (project-level tracking), or
//        GRAVA_CLIENT_ID   Grava client _id    (client-level tracking)
//        GRAVA_NAME        display name used in the timer description
//        GRAVA_API_KEY     optional: only if you did NOT store the key as a
//                          cloud-environment API credential. When omitted, the
//                          request goes out with no Authorization header and
//                          Anthropic's agent proxy injects the stored credential
//                          for the GRAVA_API_URL host.
//   2. Falls back to ~/.grava/config.json (folder map) when running locally,
//      so the same script is harmless if ever run outside the cloud.
//
// This script must NEVER block or break Claude: it always exits 0 silently.

// Node's global fetch (undici) ignores HTTP(S)_PROXY by default. In a cloud
// sandbox that means it bypasses Anthropic's agent proxy — the one that injects
// the stored Grava API credential — and hits the backend unauthenticated (403).
// Opt fetch into the environment proxy so the credential is attached. The hook
// command also sets this before `node` starts (hooks.json), which is the
// reliable path; this line is a backstop for any invocation that doesn't.
process.env.NODE_USE_ENV_PROXY = process.env.NODE_USE_ENV_PROXY || '1';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const IS_CLOUD = process.env.CLAUDE_CODE_REMOTE === 'true';

const NAMING_INSTRUCTION =
  'You name time-tracking entries for a developer. Given a task request, output ONLY a short task name: 3 to 8 words, max 60 characters, Title Case, same language as the request. Name the task, never answer it. Style examples: "Invoices CSV Export : Init", "Modify Character Name in Field", "Fix Login Redirect Loop". No quotes, no trailing punctuation, one line.';

const SWITCH_INSTRUCTION = (currentTask) =>
  `You maintain time-tracking task names during a developer's work session. The current task is: "${currentTask}". You will receive the developer's next message. Decide: does it CONTINUE the current task (follow-ups, fixes, tweaks, questions, refinements of it), or does it START a clearly different task (a distinct feature, bug, or deliverable). If it continues, output exactly: SAME. If it starts a different task, output ONLY the new task name: 3 to 8 words, max 60 characters, Title Case, same language as the message. No quotes, no trailing punctuation, one line.`;

const CONFIG_PATH = path.join(os.homedir(), '.grava', 'config.json');
const LOG_PATH = path.join(os.homedir(), '.grava', 'hook.log');
const SESSION_NAMES_PATH = path.join(os.homedir(), '.grava', 'session-names.json');
const SESSION_NAME_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const TIMER_STATE_PATH = path.join(os.homedir(), '.grava', 'timer-state.json');
const TIMER_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function loadTimerState() {
  try {
    return JSON.parse(fs.readFileSync(TIMER_STATE_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

function saveTimerState(sessionId, state, description) {
  try {
    const all = loadTimerState();
    const now = Date.now();
    for (const [k, v] of Object.entries(all)) {
      if (!v || !v.ts || now - v.ts > TIMER_STATE_TTL_MS) delete all[k];
    }
    all[sessionId] = { state, description: description || (all[sessionId] || {}).description, ts: now };
    fs.mkdirSync(path.dirname(TIMER_STATE_PATH), { recursive: true });
    fs.writeFileSync(TIMER_STATE_PATH, JSON.stringify(all));
  } catch (_) {}
}

function log(config, msg) {
  if (!config || !config.debug) return;
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
  } catch (_) {}
}

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.on('data', chunk => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 2000).unref();
  });
}

// Project threads don't deliver a clean prompt — the coordinator wraps it in a
// system envelope like <wake reason="mention" current-time="...">real task</wake>
// (and other <...> reminders). Strip XML-ish tags so the timer name reflects the
// task, not the envelope; if nothing readable remains, callers fall back to a
// clean default ("Claude Code — <project name>").
function cleanPromptText(raw) {
  return String(raw || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarizePrompt(prompt) {
  if (!prompt) return null;
  let text = cleanPromptText(prompt);
  if (!text || text.startsWith('/')) return null;

  const sentenceEnd = text.search(/[.!?]\s/);
  if (sentenceEnd > 15 && sentenceEnd < 70) {
    text = text.slice(0, sentenceEnd);
  }

  const MAX = 60;
  if (text.length > MAX) {
    let cut = text.slice(0, MAX);
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > 30) cut = cut.slice(0, lastSpace);
    text = cut + '…';
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function cleanName(raw) {
  const text = String(raw || '')
    .trim()
    .split('\n')[0]
    .replace(/^["'`]+|["'`.]+$/g, '')
    .trim();
  if (!text || text.length > 80) return null;
  return text;
}

// Local-only fallback namer via the `claude` CLI. Skipped in the cloud, where
// spawning another Claude process is unnecessary and unreliable.
function cliTaskName(config, prompt, instruction = NAMING_INSTRUCTION) {
  if (IS_CLOUD) return Promise.resolve(null);
  const model = config.namingModel || 'claude-haiku-4-5';
  const fullPrompt = `${instruction}\n\nDeveloper message: ${String(prompt).slice(0, 1500)}`;
  const candidates = [
    process.env.GRAVA_CLAUDE_BIN,
    'claude',
    path.join(os.homedir(), '.nvm/versions/node/v22.20.0/bin/claude')
  ].filter(Boolean);

  const tryBin = (bin) =>
    new Promise((resolve) => {
      execFile(
        bin,
        ['-p', '--model', model, fullPrompt],
        { cwd: os.tmpdir(), timeout: 30000, env: { ...process.env, GRAVA_HOOK_SKIP: '1' } },
        (err, stdout) => {
          if (err) return resolve({ err });
          resolve({ name: cleanName(stdout) });
        }
      );
    });

  return (async () => {
    for (const bin of candidates) {
      const { err, name } = await tryBin(bin);
      if (name) return name;
      if (err && err.code !== 'ENOENT') return null;
    }
    return null;
  })();
}

// Ask an LLM (direct Anthropic API) for a short task name. Needs an API key in
// GRAVA_ANTHROPIC_KEY / ANTHROPIC_API_KEY / config; returns null without one so
// callers fall back to the summarizePrompt() heuristic.
async function llmTaskName(config, prompt, instruction = NAMING_INSTRUCTION) {
  const apiKey = process.env.GRAVA_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY || config.anthropicApiKey;
  if (!apiKey) return null;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: config.namingModel || 'claude-haiku-4-5',
        max_tokens: 50,
        system: instruction,
        messages: [{ role: 'user', content: String(prompt).slice(0, 1500) }]
      }),
      signal: controller.signal
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.stop_reason === 'refusal') return null;
    return cleanName(data.content && data.content[0] && data.content[0].text);
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function saveSessionName(state, sessionId, name) {
  const now = Date.now();
  for (const [id, entry] of Object.entries(state)) {
    if (!entry.ts || now - entry.ts > SESSION_NAME_TTL_MS) delete state[id];
  }
  state[sessionId] = { name, ts: now };
  try {
    fs.writeFileSync(SESSION_NAMES_PATH, JSON.stringify(state, null, 2));
  } catch (_) {}
}

function looksLikeContinuation(text) {
  return text.split(/\s+/).length < 4 || text.length < 20;
}

async function getSessionName(config, sessionId, prompt) {
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(SESSION_NAMES_PATH, 'utf8'));
  } catch (_) {}

  const current = state[sessionId] && state[sessionId].name ? state[sessionId].name : null;
  const text = cleanPromptText(prompt);

  if (current) {
    if (!text || text.startsWith('/') || looksLikeContinuation(text)) return current;
    const instruction = SWITCH_INSTRUCTION(current);
    const verdict = (await llmTaskName(config, text, instruction)) || (await cliTaskName(config, text, instruction));
    if (!verdict || verdict.toUpperCase() === 'SAME') return current;
    saveSessionName(state, sessionId, verdict);
    return verdict;
  }

  const fallback = summarizePrompt(prompt);
  if (!fallback) return null;
  const name = (await llmTaskName(config, text)) || (await cliTaskName(config, text)) || fallback;
  saveSessionName(state, sessionId, name);
  return name;
}

// Local folder-map resolution (config.json). Cloud uses env vars instead.
function resolveProjectFromConfig(config, cwd) {
  if (!config.projects || !cwd) return null;
  const normalized = cwd.replace(/\/+$/, '');
  let bestKey = null;
  for (const key of Object.keys(config.projects)) {
    const k = key.replace(/\/+$/, '');
    if (normalized === k || normalized.startsWith(k + '/')) {
      if (!bestKey || k.length > bestKey.length) bestKey = k;
    }
  }
  return bestKey ? { key: bestKey, ...config.projects[bestKey] } : null;
}

// Cloud resolution: the Grava target comes from the project's environment.
function resolveTargetFromEnv() {
  const projectId = process.env.GRAVA_PROJECT_ID || null;
  const clientId = process.env.GRAVA_CLIENT_ID || null;
  const name = process.env.GRAVA_NAME || '';
  if (!projectId && !clientId) return null;
  return { key: 'env', projectId, clientId, name };
}

// Build the effective config from env (cloud) or the local file (fallback).
function loadConfig() {
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_) {}

  const apiUrl = process.env.GRAVA_API_URL || fileConfig.apiUrl;
  const apiKey = process.env.GRAVA_API_KEY || fileConfig.apiKey || null; // may be null in cloud (proxy-injected)
  return {
    ...fileConfig,
    apiUrl,
    apiKey,
    debug: fileConfig.debug || process.env.GRAVA_DEBUG === '1'
  };
}

async function api(config, method, endpoint, body) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 4000);
  try {
    const headers = { 'Content-Type': 'application/json' };
    // With no local key (cloud), send no Authorization header — the agent proxy
    // attaches the stored API credential for the GRAVA_API_URL host.
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const res = await fetch(`${config.apiUrl.replace(/\/+$/, '')}${endpoint}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

// Best-effort heartbeat so the server-side idle sweeper knows this thread is
// still alive; if the thread's sandbox dies and Stop never fires, the sweeper
// closes the timer at the last heartbeat instead of billing forever.
async function heartbeat(config, externalRef) {
  try {
    await api(config, 'POST', '/api/time-entries/heartbeat', { externalRef });
  } catch (_) {}
}

async function main() {
  if (process.env.GRAVA_HOOK_SKIP) return;

  const eventTime = new Date().toISOString();
  const config = loadConfig();
  if (!config.apiUrl) return; // no endpoint -> integration disabled

  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch (_) {
    return;
  }

  const event = input.hook_event_name;
  const sessionId = input.session_id || process.env.CLAUDE_CODE_REMOTE_SESSION_ID;
  const cwd = input.cwd || process.cwd();
  if (!event || !sessionId) return;

  // Fast path: PreToolUse only matters to resume a paused timer or to heartbeat.
  const priorState = (loadTimerState()[sessionId] || {}).state;
  if (event === 'PreToolUse' && priorState !== 'paused') {
    // Still send a heartbeat so a long autonomous turn keeps the timer alive.
    if (priorState === 'running') await heartbeat(config, sessionId);
    return;
  }

  // Resolve the Grava target: env (cloud) wins, else the local folder map.
  const project = resolveTargetFromEnv() || resolveProjectFromConfig(config, cwd);
  const clientId =
    project && project.clientId && typeof project.clientId === 'object'
      ? project.clientId._id
      : project && project.clientId;
  if (!project || (!project.projectId && !clientId)) {
    log(config, `${event} ${sessionId} skipped: no Grava target (env GRAVA_PROJECT_ID/GRAVA_CLIENT_ID or folder map)`);
    return;
  }

  if (event === 'UserPromptSubmit' || event === 'SessionStart') {
    const sessionName = await getSessionName(config, sessionId, input.prompt);
    const description =
      sessionName || project.description || `Claude Code — ${project.name || 'work'}`;

    const body = { description, source: 'claude-code', externalRef: sessionId, startTime: eventTime };
    if (project.projectId) body.projectId = project.projectId;
    else body.clientId = clientId;

    const res = await api(config, 'POST', '/api/time-entries', body);
    saveTimerState(sessionId, 'running', description);
    await heartbeat(config, sessionId);
    log(config, `${event} ${sessionId} start "${description}" -> ${res.status}`);
  } else if (event === 'Stop' || event === 'SessionEnd') {
    const res = await api(config, 'POST', '/api/time-entries/stop-by-ref', {
      externalRef: sessionId,
      endTime: eventTime
    });
    saveTimerState(sessionId, 'stopped');
    log(config, `${event} ${sessionId} stop -> ${res.status}`);
  } else if (event === 'Notification') {
    if (priorState === 'running') {
      const res = await api(config, 'POST', '/api/time-entries/stop-by-ref', {
        externalRef: sessionId,
        endTime: eventTime
      });
      saveTimerState(sessionId, 'paused');
      log(config, `${event} ${sessionId} pause -> ${res.status}`);
    }
  } else if (event === 'PreToolUse') {
    // Reached only when paused: work resumed, restart the clock.
    const saved = (loadTimerState()[sessionId] || {}).description;
    const body = {
      description: saved || `Claude Code — ${project.name || 'work'}`,
      source: 'claude-code',
      externalRef: sessionId,
      startTime: eventTime
    };
    if (project.projectId) body.projectId = project.projectId;
    else body.clientId = clientId;
    const res = await api(config, 'POST', '/api/time-entries', body);
    saveTimerState(sessionId, 'running');
    await heartbeat(config, sessionId);
    log(config, `${event} ${sessionId} resume "${body.description}" -> ${res.status}`);
  }
}

main().catch(() => {}).finally(() => process.exit(0));
