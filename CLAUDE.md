# Situation Room

Electron app for running many Claude Code and Pi sessions side by side. You are the **Builder**: you run inside Situation Room and improve it while the user uses it.

## Layout

| File | Role |
|---|---|
| `daemon.js` | Plain Node. Owns every pty, task state (`~/.situation-room/state.json`), worktrees, hook endpoint. Port 7777. |
| `main.js` | Electron main. Starts the daemon detached, opens the window, notifications, dock badge. |
| `usage.js` | Token and cost totals from Claude Code transcripts and Pi sessions. |
| `pi/` | Pi extensions: `situation-room.js` posts status and gates review tasks; `gateway.js` registers gateway models. |
| `ui/` | Renderer (vanilla JS + xterm): `app.js` tasks and drawers, `views.js` PRs, Jira, palette, keys, `ship.js`, `usage.js` breakdown, `spaces.js`, `md.js`. |

Config is `~/.situation-room/config.json` (see `config.example.json`); defaults live at the top of `daemon.js`.

## PR reviews

- The PRs tab (⌘P) lists open PRs for `prRepos`.
- Review opens a task in a detached worktree on `pull/N/head`. The agent writes a draft to `~/.situation-room/reviews/<task>.json`: `{summary, event, comments:[{path,line,side,body}]}`.
- The drawer (⌘E) edits the draft. Submit posts it through `gh api` as the user. Never mention Claude, AI or tooling in anything posted.
- PRs → Mine sends feedback on your own PR to the task whose checkout is on its branch (`fb`: `<task>.feedback.json` drafts and threads, the Feedback tab, the address prompt as its next message). Only with no such task, or a session ID, does it open an `address` task on the real branch. Dismissed entries stay untouched.

## Ship

- Drawer tabs: Changes (working-tree diff) and Ship. Ship drafts commits, branch and a draft PR via `claude -p`; the draft lives in `~/.situation-room/reviews/<task>.ship.json`.
- Ship only types the commands into the task's Shell. The user presses Enter. PRs are always `--draft`.

## PR watch

- The daemon polls PRs the user owns or reviews every 90s and counts new comments, reviews and commits from others since `state.prSeen[key]`.

## Jira

- Off unless `config.jira.base` is set. Credentials come from `.env` in this folder (`JIRA_USERNAME`, `JIRA_API_TOKEN`), gitignored.
- Start task assigns the ticket to the user and moves To Do to In Progress, asking first if someone else holds it.

## New tasks

- Default: fetch, then `git switch -c <branch> origin/main` in the repo's own checkout; a worktree beside it (`<repo>-<branch>`) when the checkout is dirty or busy, or when asked. Ignored local files (`.env*`, `*.pem`, …) are copied in.
- Repos missing under `roots` are cloned with `gh repo clone` from `org`.
- Remove task deletes the worktree made for it, unless another task shares it or it has uncommitted files (or unpushed commits while its PR is open). Every 15 min tasks whose PR is merged or closed are removed with their worktrees once idle and with nothing uncommitted; worktrees on no task's branch go too. Branches always stay.

## Harness and models

- Each task picks Claude Code or Pi, plus model and effort, when it starts. No switching harness mid-task.
- `models.json` lists the Claude models offered. With `config.gateway` set, the gateway's own list (`gateway.models`) replaces it and Pi gets those models as provider `gateway` through `pi/gateway.js`; prices come from the gateway's `/model/info`.
- Without a gateway Pi runs natively: its models are whatever `pi --list-models` reports for the user's Pi logins and API keys.
- Helper calls (`claude -p` for branch names, Ship, ticket drafts) run under the task's Claude config dir.

## Spaces

- `config.spaces` defines extra spaces, cycled with ⌘⇧. — each shows only its own tasks; PRs and Jira are work-only.
- A space with `claudeConfigDir` runs Claude Code with `CLAUDE_CONFIG_DIR` set and no `ANTHROPIC_*` variables (absent, not blank — blank breaks the login), so it uses that dir's own `/login`. No Pi there; gateway model ids map to Anthropic's via `base`.
- Usage counts those dirs as subscription usage: tokens, no cost.

Pty replay trims old output, so the daemon tracks input modes (bracketed paste, focus, mouse) and re-sends them on attach. Status comes from Claude Code hooks injected via `--settings`, or the Pi extension, which POST to `/hook/<task>/<event>`.

## Changing yourself safely

- `ui/*`: saving reloads the window automatically.
- `main.js`: the user quits and restarts the app. Sessions survive.
- `daemon.js`: **restarting it kills every session, including yours.** Sessions resume, but anything mid-flight is lost. Finish your reply, then ask the user to use View → Restart Daemon.
- Syntax-check before handing over: `node --check daemon.js main.js usage.js pi/*.js ui/*.js`.

## Rules

- Secrets live in `.env` here or in Claude/Pi's own credential stores, never in the repo.
- No build step, no framework, no TypeScript.
