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
- Contribute (`POST /review/:id/contribute`, `t.contribute`) moves the worktree onto the PR's own branch tracking origin and relaunches the agent with edit rights, which are fixed at launch. It adds Changes and Ship; Ship rebases onto and pushes to that branch, never renames it or opens a PR. Fork PRs are refused.
- The drawer (⌘E) edits the draft. Submit posts it through `gh api` as the user. Never mention Claude, AI or tooling in anything posted.
- PRs → Mine sends feedback on your own PR to the task whose checkout is on its branch (`fb`: `<task>.feedback.json` drafts and threads, the Feedback tab, the address prompt as its next message). Only with no such task, or a session ID, does it open an `address` task on the real branch. Dismissed entries stay untouched.

## Ship

- Drawer tabs: Changes (working-tree diff) and Ship. Ship drafts commits, branch and a draft PR via `claude -p`; the draft lives in `~/.situation-room/reviews/<task>.ship.json`.
- Every task launches with `prompts/task.md` appended to its system prompt (both harnesses): Situation Room ships, so the agent never runs or hands over ship commands. It writes a ship note to `~/.situation-room/notes/<task>.md`, and the planner uses it when it's newer than HEAD.
- Ship only types the commands into the task's Shell. The user presses Enter. PRs are always `--draft`. They're `--assignee @me`, and the plan picks one label from the repo's kind labels (`KPI:*`, `bug`, `enhancement`, …, read with `gh label list`, cached an hour); an unknown label is rejected before the command is built.

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

## Debug tasks

- New task → Debug (or + on the Debug group) creates a `kind: 'debug'` task for one incident on any repo: always a fresh worktree and branch off `origin/main` (`createTask` with `debug` and `report`); the report is its first message. `config.debug` entries are optional extras (namespace, notes, index), matched to the repo by `debugSettings`.
- At launch the guide (`prompts/debug.md`, plus the project's `notes` file and namespace) is written to `~/.situation-room/prompts/<task>.md` and passed with `--append-system-prompt` (both harnesses).
- `tools/` goes on the agent's PATH; `sr-logs` queries Elasticsearch through Kibana's `/api/console/proxy` and filters errors by the `level` field. `SR_LOGS_*` come from `.env`; `config.logs.url` supplies the URL.
- Sidebar groups collapse on click (`collapsed` in localStorage); a filter shows matches in collapsed groups. The Debug group always shows when projects exist.
- The cleanup sweep never removes an unowned worktree younger than an hour.

## Spaces

- `config.spaces` defines extra spaces, cycled with ⌘⇧. — each shows only its own tasks; PRs and Jira are work-only.
- A space with `claudeConfigDir` runs Claude Code with `CLAUDE_CONFIG_DIR` set and no `ANTHROPIC_*` variables (absent, not blank — blank breaks the login), so it uses that dir's own `/login`. No Pi there; gateway model ids map to Anthropic's via `base`.
- Usage counts those dirs as subscription usage: tokens, no cost.
- `builderSpace` names the space the Builder lives in (default: work). With `allowMain` there it ships straight to main.
- `allowMain` on a space allows `onMain` tasks: the repo's own checkout on the default branch (must be clean and free), and a Ship command of commit, `pull --rebase`, `push origin HEAD:<base>` with no PR. `createTask` and `shipState` both check the space, so a work task can't get it even with an edited state file.

Pty replay trims old output, so the daemon tracks input modes (bracketed paste, focus, mouse) and re-sends them on attach. Status comes from Claude Code hooks injected via `--settings`, or the Pi extension, which POST to `/hook/<task>/<event>`.

## Changing yourself safely

- `ui/*`: saving reloads the window automatically.
- `main.js`: the user quits and restarts the app. Sessions survive.
- `daemon.js`: **restarting it kills every session, including yours.** Sessions resume, but anything mid-flight is lost. Finish your reply, then ask the user to use View → Restart Daemon.
- Syntax-check before handing over: `node --check daemon.js main.js usage.js pi/*.js ui/*.js`.
- Test daemon changes on a throwaway daemon, never the user's: `SR_PORT=7791 SR_HOME=/tmp/x node daemon.js`, a temp repo with a bare origin at a `…/github.com/<owner>/<repo>.git` path (that is how the slug is read), and stub `gh`/`claude` on PATH. The pty runs a login shell, which resets PATH, so the real `claude` can still start: check `ps` and kill it.
- The window is reachable on Chrome DevTools port 9333 (`--remote-debugging-port`) to check UI state with `Runtime.evaluate`. Select the task you test, then put the user's selection back.
- Never `checkout --force`, `reset --hard` or `clean` a task's checkout: it may be someone's real worktree with uncommitted work.
- Change tasks through the daemon's API, not `state.json`: the daemon holds state in memory and overwrites hand edits.

## Rules

- Secrets live in `.env` here or in Claude/Pi's own credential stores, never in the repo.
- No build step, no framework, no TypeScript.
