# zcode-worklog

**Standalone WorkLog for ZCode**: a local work journal with daily Git/document/session archiving, todos, daily/weekly/monthly/quarterly reports, and an interactive side panel.

- No `WorkLog.exe`, no `127.0.0.1:8377` service.
- The side panel is fully self-contained: its script and stylesheet are inlined into the HTML the plugin serves, so the host only displays it and loads no external app or subresources.
- Data lives in ZCode's plugin data directory (`ZCODE_PLUGIN_DATA`; the panel header shows the exact path), never in the install directory.
- Archiving automatically summarizes local AI tool sessions (Claude Code, Codex, DSH, WorkBuddy, ZCode, OpenCode, Gemini CLI, ...).
- The weekly archive layout matches the original WorkLog, so an existing `data\archive` can be imported as-is.

## Install (from GitHub)

Marketplace repository: <https://github.com/zxc1213/zcode-worklog>

**CLI**

```bash
zcode plugins marketplace add zxc1213/zcode-worklog
zcode plugins install zcode-worklog@zcode-worklog
```

**UI**

1. Open ZCode **Settings → Plugin Marketplace → Add → Add Plugin Marketplace** and paste:

   ```text
   zxc1213/zcode-worklog
   ```

2. Open **Personal → zcode-worklog → zcode-worklog → Install** (full plugin ID: `zcode-worklog@zcode-worklog`).
3. Start a new session (or restart ZCode).
4. Open **WorkLog** from the conversation side panel. If the entry is missing, confirm the plugin is enabled first.

> The repository root is both the plugin root (`.zcode-plugin/plugin.json`) and the marketplace catalog (`marketplace.json`), so one GitHub source adds the market and installs the plugin. The local dev catalog at `E:\AI_Project\research\marketplace.json` still works for local iteration.

### Opening the panel

- **From chat**: say "open the WorkLog panel"; the agent calls `worklog_open` and the panel opens in the right side pane.
- **Manual**: right side pane → **Add tab (+)** → **App plugins** → **View all plugins** → **WorkLog** → Open.
- Or **Settings → Plugins → Plugin Marketplace → Personal/Installed → App plugins** → WorkLog → Open.

> The right-side "App plugins" quick section only lists ZCode-recommended plugins. WorkLog is a community plugin, so use "View all plugins" or the App plugins section in the marketplace.

## Panel

Six tabs:

| Tab | Contents |
|---|---|
| Overview | Today's archive state, log/todo/project/backup/AI-session counts, today's AI sessions, recent runs, one-click archive |
| Logs | Read/edit/save a day's Markdown, search the archive, re-archive, generate a daily report |
| Todos | Add, inline edit, complete, reopen, delete, clear completed; subtask checklist and tags managed in the edit form; smart order (overdue > priority > due date), pri/tag filters, stats bar; AI smart-fill / batch parse / daily top-3 suggestion (needs AI config); `!high` / `#tag` / `@2026-10-30` / `repeat=daily` shortcuts |
| Reports | Daily, weekly, monthly, quarterly, performance material, project dossier; optional AI polish; view generated reports |
| Sessions | Scan local AI tool sessions by date; view source/title/turns/project and session sources; read-only, never writes the archive |
| Settings | Collapsible blocks: data & scanning, AI polish, backup/restore, import from old WorkLog; sticky save bar on top |

The panel talks to this plugin's own MCP server through the panel-only `worklog_api` tool. The plugin inlines the panel script and stylesheet into `ui://zcode-worklog/panel.html`, so the host loads no external program or subresources. If the panel stays on the loading screen, close and reopen it; if that fails, update the plugin and restart ZCode (`zcode plugins update zcode-worklog@zcode-worklog`).

## Reusing local AI configs

**Settings → AI polish → Scan local AI tools** reads these locations on this machine and lists reusable endpoints. Clicking **Use** writes the endpoint into the plugin config; API keys stay inside the local server process and are never shown in the panel.

| Source | What is read |
|---|---|
| ZCode | Providers in `~/.zcode/v2/config.json` (baseURL, apiKey, kind, model), with the currently selected provider first |
| DeepSeek Harness | `llm-pi-ai` providers in the active profile (`~/.dsh/profiles/web/cordis.patch.yml` or `cordis.yml`), falling back to `settings.yaml` / `settings-legacy.yaml`; keys resolved from `.credentials.yaml` `refs`, including `DEEPSEEK_API_KEY` |
| Claude Code | `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_DEFAULT_*_MODEL` from `~/.claude/settings.json` |
| Codex CLI | `~/.codex/config.toml` and `auth.json` (only when an API key exists; OAuth-only logins cannot be reused) |
| Gemini CLI | `GEMINI_API_KEY` from the environment or `~/.gemini/.env`, via its OpenAI-compatible endpoint |
| Environment | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `ANTHROPIC_API_KEY`, and related variables |

Both **OpenAI-compatible** (`/chat/completions`) and **Anthropic-compatible** (`/v1/messages`) endpoints are supported; the BigModel / Z.ai coding plans commonly used with ZCode use the latter. Manual entry still works as before.

Since 0.2.4: local configs render as one dropdown (with the model count instead of a long list). After filling Base URL / key, **Load models** queries `/models` (`/v1/models` for Anthropic-compatible endpoints) and the model field becomes a dropdown you can also type into; endpoints without a model list fall back to models known from local configs.

## Data layout

```text
<plugin-data>/
  config.json                  # settings (optional AI key in plain text, local only)
  data/
    archive/
      2026-10/
        第5周(10.26-11.01)/
          2026-10-29.md       # one Markdown file per day
      reports/                # generated reports
    todos.json
    state.json                # last runs, run history, AI usage
    session-cache.json        # AI session parse cache (incremental by file mtime+size)
    backups/                  # JSON backups
```

Weeks run Monday–Sunday and belong to the month containing Thursday. Copy an old WorkLog `data\archive` in directly, or use **Settings → Import from old WorkLog**.

## Daily archive

`worklog_archive` (or the panel's **Archive today**) will:

1. Find Git repositories up to 3 levels below `scanRoots` and collect today's commits (filtered by `gitAuthor`, falling back to each repo's `git config user.name`).
2. Scan `docRoots` up to 6 levels for `.md/.docx/.xlsx/.pptx/.pdf/...` modified today.
3. Scan local AI tool sessions for the day and collect sessions with real user prompts (source, title, turns, time, project).
4. Write a Markdown file with Overview / Project progress / Document changes / AI sessions / Notes.

When no roots are configured, the current workspace (`ZCODE_PROJECT_DIR`) is scanned. An existing day is not overwritten unless `force: true` is passed (this replaces hand-written notes).

Auto-archive: when enabled, the MCP server process checks every minute and archives once per day after `taskTime` (default 18:30). **Nothing runs while ZCode is closed.**

## AI session digest

Archiving read-only scans the day's real user prompts in local AI tool records and writes an "## AI sessions" section into the day file:

| Source | Where it is read |
|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` (real user prompts only; title from `ai-title`) |
| Codex | `~/.codex/sessions/**/*.jsonl` (`session_meta.cwd`, `user_message`) |
| DeepSeek Harness | `$DSH_HOME/sessions/**/session*.jsonl[.zstd]` (zstd frames decompressed) |
| WorkBuddy | `~/.workbuddy/projects/**/*.jsonl` (`<user_query>` extraction) |
| ZCode | `~/.zcode/cli/db/db.sqlite` session/message/part (user messages only; model-only runtime injections filtered) |
| OpenCode | `~/.local/share/opencode/storage/{session,message,part}` |
| Gemini CLI | `~/.gemini|.qwen|.iflow/tmp/*/chats/*.json` |
| Custom | The settings' extra AI session roots; generic user-message parsing for jsonl/json |

Only sessions with real user prompts are counted; `<system-reminder>` / `<environment_context>` and model-only runtime injections are filtered. At most 3 prompt excerpts per session per day stay in the local cache; the day file only records source/time/turns/title plus the project directory. Parsed results are cached by file `mtime + size` in `data/session-cache.json`, so only changed files are re-parsed; `worklog_sessions refresh` forces a rescan. The panel's Sessions tab scans by date; Settings can disable "summarize AI sessions when archiving" or add extra session roots. Session content is read and written locally only and is never uploaded automatically; material goes to the configured AI endpoint only when you explicitly check AI polish.

Day-file format:

```markdown
## AI sessions

- [Claude Code] 09:12–09:40 · 3 turns · session title
  - Project: `E:\AI_Project\research`
- [ZCode] 10:57–11:00 · 2 turns · another session title
  - Project: `E:\AI_Project\research\zcode-worklog`
```

## Agent tools

`worklog_status`, `worklog_day`, `worklog_search`, `worklog_todos`, `worklog_archive`, `worklog_sessions`, `worklog_report`, `worklog_ask`, `worklog_projects`, `worklog_usage`, `worklog_backup`, `worklog_config`, `worklog_open`, `worklog_collect` (collection scheduler & diagnostics), `worklog_wizard` (AI tool config wizard).

Session tool names are usually prefixed with `mcp__plugin_zcode-worklog_worklog__`.

## Slash commands

The command palette usually shows `/zcode-worklog:status`; on clients that use a slash separator it is `/zcode-worklog/status`.

```text
/zcode-worklog:status
/zcode-worklog:today [YYYY-MM-DD]
/zcode-worklog:search <keyword>
/zcode-worklog:todo list | add <title> [!high] [#tag] [@YYYY-MM-DD] | edit <id> | done <id> | reopen <id> | del <id> | clear | stats | carry | parse <text> | plan
/zcode-worklog:archive run | backfill <dates...> | status
/zcode-worklog:sessions [YYYY-MM-DD] | sources | refresh [YYYY-MM-DD]
/zcode-worklog:report daily|weekly|month|quarter|perf|project [args]
/zcode-worklog:ask <question>
/zcode-worklog:backup list|create|restore <name>|delete <name>|import <old WorkLog dir>
/zcode-worklog:config
/zcode-worklog:open
```

## Session hook

A `SessionStart` hook injects one status line (today archived or not, open/overdue todos, last archive) and runs the due auto-archive at most once per day. Hook failures never block the session; diagnostics go to stderr.

## Migration

Use the panel's **Settings → Import from old WorkLog** with the old install directory (for example `E:\WorkLog`). Only `data\archive` is copied; the source is left untouched. Old `settings.json`, todos and performance templates are not migrated.

## Scope

Implemented: Git/document archiving, log editing/search, todos (subtasks/tags/AI assistant), deterministic reports, optional AI polish/Q&A, AI session digest, backups, old archive import, auto-archive, side panel, compensating collection scheduler, AI tool config wizard, watched-dir fingerprint scanning (local/cloud/git).

Not implemented: Cursor/Trae/Windsurf VS Code database session scanning, Word/Excel export, performance template restoration, Feishu timesheets, business flow diagrams.

## Development

```bash
npm install        # build/test only (esbuild + MCP SDK + ext-apps + jsdom)
npm run build      # writes dist/: server.mjs, session-start.mjs, panel.js, panel.html, panel.css
npm test           # store / archive / reports / MCP API
npm run test:panel # jsdom MCP App host simulation: handshake, bootstrap, all six tabs
npm run smoke      # end-to-end in a temp directory
node test/smoke-mcp.mjs   # real stdio JSON-RPC: initialize / tools/list / tools/call / resources/read
```

`dist/` is committed, so an install does not need Node dependencies; `node_modules` is only for rebuilding.

## Security

- Data stays in the local plugin data directory.
- The optional AI API key is stored in plain text in `config.json`; without an endpoint configured, no external request is made.
- Restoring a backup overwrites same-named day logs and todos; deleting a backup is irreversible.
- No destructive endpoints such as deleting the archive root or resetting all data.

## License

MIT
