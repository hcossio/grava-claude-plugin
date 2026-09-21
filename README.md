# Grava Claude Plugin

A Claude Code plugin marketplace that adds automatic [Grava](https://github.com/hcossio/baseBack) time tracking to Claude Code **Projects**.

Cloud threads run in Anthropic sandboxes with none of your local machine's
config, so the timer hook can't come from `~/.claude` or `~/.grava`. This
marketplace delivers it as a plugin the threads pull at startup. The plugin
itself contains **no secrets** — the Grava API key lives in the project's cloud
environment, never here.

## Plugin: `grava-timer`

Starts a Grava timer when a thread begins work and stops it when the thread
finishes, one timer per thread (keyed by the session id). It reads which Grava
project/client to bill from the project's **cloud-environment variables**:

| Variable          | Required | Purpose                                                        |
| ----------------- | -------- | ------------------------------------------------------------- |
| `GRAVA_API_URL`   | yes      | Grava backend base URL, e.g. `https://baseback-production.up.railway.app` |
| `GRAVA_PROJECT_ID`| one of   | Grava project `_id` (project-level tracking)                 |
| `GRAVA_CLIENT_ID` | these    | Grava client `_id` (client-level tracking)                   |
| `GRAVA_NAME`      | no       | Display name used in the timer description                    |
| `GRAVA_API_KEY`   | no       | Only if you did **not** store the key as a cloud-environment API credential. Preferred: leave unset and add the key as an API credential for the `GRAVA_API_URL` host, so it never enters the sandbox. |

## Use it in a Claude Code Project

1. In the project's **Settings → Environment**, set the variables above and add
   the Grava API key as an **API credential** (host = your `GRAVA_API_URL` host,
   `Authorization: Bearer`).
2. Add this marketplace and enable the plugin:
   - `/plugin marketplace add hcossio/grava-claude-plugin`
   - `/plugin install grava-timer@grava`
   or enable it from **Project Settings → Plugins**.

Every new thread then tracks its time to the configured Grava target
automatically. A companion server-side idle sweeper in the Grava backend closes
any timer whose thread dies before its `Stop` hook fires.
