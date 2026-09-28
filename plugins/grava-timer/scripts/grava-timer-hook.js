#!/usr/bin/env node
// Grava timer — thin forwarder.
//
// Sends each Claude Code hook event to the Grava backend, which owns everything
// that used to live here: id stability, project matching, Haiku naming, and the
// one-timer-per-thread model. That means mapping/naming changes ship as a
// backend deploy — this script stays frozen, so you rarely (if ever) re-sync
// the plugin again.
//
// It reads the Grava binding from the project's cloud-environment variables:
//   GRAVA_API_URL    Grava backend base URL (required)
//   GRAVA_CLIENT_ID  Grava client _id — the explicit, never-guessed anchor
//   GRAVA_PROJECT_ID optional: pin every thread to one Grava project
//   GRAVA_API_KEY    optional: only if the key isn't stored as a cloud
//                    API credential (preferred — then the agent proxy injects it)
//
// Never blocks or breaks Claude: always exits 0 silently.

// Node's global fetch (undici) ignores HTTP(S)_PROXY by default; in a cloud
// sandbox that bypasses the agent proxy that injects the Grava credential. The
// hook command also sets this before node starts (hooks.json) — belt and braces.
process.env.NODE_USE_ENV_PROXY = process.env.NODE_USE_ENV_PROXY || '1';

const { execFileSync } = require('child_process');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 2000).unref();
  });
}

// origin remote of the thread's working repo (best-effort) — a strong signal for
// which of a client's projects the thread is on. Only called on start events.
function getGitRemote(cwd) {
  try {
    return String(
      execFileSync('git', ['config', '--get', 'remote.origin.url'], {
        cwd: cwd || process.cwd(),
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore']
      })
    ).trim();
  } catch (_) {
    return '';
  }
}

async function main() {
  if (process.env.GRAVA_HOOK_SKIP) return;

  const apiUrl = process.env.GRAVA_API_URL;
  if (!apiUrl) return; // no endpoint -> integration disabled

  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch (_) {
    return;
  }

  const event = input.hook_event_name;
  const sessionId = input.session_id || null;
  const remoteSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID || null;
  if (!event || (!sessionId && !remoteSessionId)) return;

  const isStart = event === 'UserPromptSubmit' || event === 'SessionStart';

  const body = {
    event,
    sessionId,
    remoteSessionId,
    isCloud: process.env.CLAUDE_CODE_REMOTE === 'true',
    clientId: process.env.GRAVA_CLIENT_ID || null,
    projectId: process.env.GRAVA_PROJECT_ID || null,
    cwd: input.cwd || null,
    // repo lookup + prompt only matter when starting a timer
    gitRemote: isStart ? getGitRemote(input.cwd) : undefined,
    prompt: isStart ? input.prompt : undefined,
    eventTime: new Date().toISOString()
  };

  const headers = { 'Content-Type': 'application/json' };
  // With no local key (the recommended setup) the request goes out unauthenticated
  // and the agent proxy attaches the stored API credential for the Grava host.
  if (process.env.GRAVA_API_KEY) headers.Authorization = `Bearer ${process.env.GRAVA_API_KEY}`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(`${apiUrl.replace(/\/+$/, '')}/api/time-entries/claude-event`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (_) {
    // best-effort; never surface errors to Claude
  } finally {
    clearTimeout(t);
  }
}

main().catch(() => {}).finally(() => process.exit(0));
