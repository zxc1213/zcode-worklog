# zcode-worklog

**Standalone WorkLog for ZCode**: a local work journal with daily Git/document archiving, todos, daily/weekly/monthly/quarterly reports, and an interactive side panel.

- No `WorkLog.exe`, no `127.0.0.1:8377` service.
- Data lives in ZCode's plugin data directory (`ZCODE_PLUGIN_DATA`; the panel header shows the exact path), never in the install directory.
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

Five tabs:

| Tab | Contents |
|---|---|
| Overview | Today's archive state, log/todo/project/backup counts, recent runs, one-click archive |
| Logs | Read/edit/save a day's Markdown, search the archive, re-archive, generate a daily report |
| Todos | Add, complete, reopen, delete, clear completed; `!high` / `@2026-10-30` shortcuts |
| Reports | Daily, weekly, monthly, quarterly, performance material, project dossier; optional AI polish; view generated reports |
| Settings | Data directory, Git/document roots, Git author, auto-archive time, AI endpoint, backup/restore, import from old WorkLog |

The panel talks to this plugin's own MCP server through the panel-only `worklog_api` tool.

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
    backups/                  # JSON backups
```

Weeks run Monday–Sunday and belong to the month containing Thursday. Copy an old WorkLog `data\archive` in directly, or use **Settings → Import from old WorkLog**.

## Daily archive

`worklog_archive` (or the panel's **Archive today**) will:

1. Find Git repositories up to 3 levels below `scanRoots` and collect today's commits (filtered by `gitAuthor`, falling back to each repo's `git config user.name`).
2. Scan `docRoots` up to 6 levels for `.md/.docx/.xlsx/.pptx/.pdf/...` modified today.
3. Write a Markdown file with Overview / Project progress / Document changes / Notes.

When no roots are configured, the current workspace (`ZCODE_PROJECT_DIR`) is scanned. An existing day is not overwritten unless `force: true` is passed (this replaces hand-written notes).

Auto-archive: when enabled, the MCP server process checks every minute and archives once per day after `taskTime` (default 18:30). **Nothing runs while ZCode is closed.**

## Agent tools

`worklog_status`, `worklog_day`, `worklog_search`, `worklog_todos`, `worklog_archive`, `worklog_report`, `worklog_ask`, `worklog_projects`, `worklog_usage`, `worklog_backup`, `worklog_config`, `worklog_open`.

Session tool names are usually prefixed with `mcp__plugin_zcode-worklog_worklog__`.

## Slash commands

The command palette usually shows `/zcode-worklog:status`; on clients that use a slash separator it is `/zcode-worklog/status`.

```text
/zcode-worklog:status
/zcode-worklog:today [YYYY-MM-DD]
/zcode-worklog:search <keyword>
/zcode-worklog:todo list | add <title> [!high] [@YYYY-MM-DD] | done <id> | reopen <id> | del <id> | clear
/zcode-worklog:archive run | backfill <dates...> | status
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

Implemented: Git/document archiving, log editing/search, todos, deterministic reports, optional AI polish/Q&A, backups, old archive import, auto-archive, side panel.

Not implemented: AI session scanning, Word/Excel export, performance template restoration, Feishu timesheets, business flow diagrams.

## Development

```bash
npm install        # build/test only (esbuild + MCP SDK + ext-apps + jsdom)
npm run build      # writes dist/: server.mjs, session-start.mjs, panel.js, panel.html, panel.css
npm test           # store / archive / reports / MCP API
npm run test:panel # jsdom MCP App host simulation: handshake, bootstrap, all five tabs
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
