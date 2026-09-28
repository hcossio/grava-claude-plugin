# Grava Claude Plugin

A Claude Code plugin marketplace that adds automatic [Grava](https://github.com/hcossio/baseBack) time tracking to Claude Code **Projects**.

Cloud threads run in Anthropic sandboxes with none of your local machine's
config, so the timer hook is delivered here as a plugin the threads pull at
startup. The plugin holds **no secrets** — the Grava API key lives in the
project's cloud environment, never in this repo.

## Plugin: `grava-timer`

A **thin forwarder**. On each Claude Code hook event it POSTs the raw signals to
the Grava backend's `/api/time-entries/claude-event`, and the backend owns all
the logic: a stable one-timer-per-thread model, per-client → project matching,
Haiku task naming, and idle auto-stop. Because the smarts live server-side,
changing mappings or naming is a backend deploy — you rarely need to update or
re-sync this plugin.

It reads the binding from the project's **cloud-environment variables**:

| Variable          | Required | Purpose                                                                 |
| ----------------- | -------- | ----------------------------------------------------------------------- |
| `GRAVA_API_URL`   | yes      | Grava backend base URL, e.g. `https://baseback-production.up.railway.app` |
| `GRAVA_CLIENT_ID` | yes      | Grava client `_id` — the explicit, never-guessed billing anchor         |
| `GRAVA_PROJECT_ID`| no       | Pin every thread to one Grava project (else the backend picks per thread) |
| `GRAVA_API_KEY`   | no       | Only if the key isn't stored as a cloud **API credential** (preferred — then the agent proxy injects it, key never enters the sandbox) |

The backend decides which of the client's Grava projects to bill from the
thread's repo/cwd/prompt (rules in `baseBack/src/config/claudeProjectRules.js`),
always cross-checked to belong to `GRAVA_CLIENT_ID`; no match → bills the client.

## Use it in a Claude Code Project

1. **Project Settings → Environment**: set `GRAVA_API_URL` and `GRAVA_CLIENT_ID`,
   and add the Grava API key as an **API credential** (host = your `GRAVA_API_URL`
   host, `Authorization: Bearer`).
2. Add this marketplace and enable the plugin:
   - `/plugin marketplace add hcossio/grava-claude-plugin`
   - `/plugin install grava-timer@grava`

Every new thread then tracks its time to the right Grava client (and project)
automatically.
