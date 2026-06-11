# cmux-mcp

[한국어](./README.ko.md)

**MCP server that gives AI agents full control of your [cmux](https://github.com/manaflow-ai/cmux) terminal.**

Let Claude run commands, read output, manage tabs/panes/workspaces/windows, and send control characters in your cmux terminal -- all through the Model Context Protocol. Works in the background. No focus stealing.

## Quick Start

### Option A: Claude Code Plugin (Recommended)

```
/plugin marketplace add daegweon/cmux-mcp
/plugin install cmux-mcp@cmux-tools
```

That's it. The MCP server is configured automatically.

### Option B: npx (No build required)

Edit `~/.claude/settings.json`:

```jsonc
{
  "mcpServers": {
    "cmux-mcp": {
      "command": "npx",
      "args": ["-y", "cmux-mcp"]
    }
  }
}
```

Restart Claude Code.

### Option C: Clone and build

```bash
git clone https://github.com/daegweon/cmux-mcp.git
cd cmux-mcp
npm install && npm run build
```

Edit `~/.claude/settings.json`:

```jsonc
{
  "mcpServers": {
    "cmux-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/cmux-mcp/build/index.js"]
    }
  }
}
```

Restart Claude Code.

<details>
<summary>Claude Desktop setup</summary>

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```jsonc
{
  "mcpServers": {
    "cmux-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/cmux-mcp/build/index.js"]
    }
  }
}
```

Restart Claude Desktop after saving.

</details>

<details>
<summary>Any MCP client</summary>

cmux-mcp communicates over stdio. Point your MCP client to `node /path/to/cmux-mcp/build/index.js`.

</details>

### Requirements

- macOS
- [cmux.app](https://github.com/manaflow-ai/cmux) installed and running
- Node.js 18+
- cmux socket control mode set to **Automation** or **Open Access** (Settings > Automation > Socket Control Mode)

## Tools

cmux-mcp exposes the full cmux CLI as MCP tools. All terminal I/O tools support an optional `surface` parameter for targeting specific tabs.

Every tool carries standard [MCP tool annotations](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-annotations) (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `title`) so clients can distinguish three classes of tools and apply permission policies accordingly:

- **Read-only** (`readOnlyHint: true`) — listing, reading output, inspecting state (e.g. `list_surfaces`, `read_terminal_output`, `tree`). Safe to auto-approve.
- **Write** — UI changes that don't execute commands or destroy data (e.g. `focus_pane`, `rename_tab`, `set_status`).
- **Dangerous** (`destructiveHint: true`) — anything that executes commands, terminates processes, or irreversibly deletes data (e.g. `write_to_terminal`, `send_control_character`, `close_workspace`, `pipe_pane`, `set_hook`, `browser`). Clients should require confirmation.

### Terminal I/O

| Tool | Description |
|------|-------------|
| `write_to_terminal` | Send commands to the terminal. Enter is appended automatically. Returns new output line count. |
| `read_terminal_output` | Read the last N lines from the terminal buffer. |
| `send_control_character` | Send Ctrl+C, Ctrl+Z, Escape, or any control character. |

### Surface (Tab) Management

| Tool | Description |
|------|-------------|
| `list_surfaces` | List all tabs in a workspace with IDs and titles. |
| `new_surface` | Create a new terminal tab. |
| `close_surface` | Close a specific tab. |
| `focus_surface` | Focus (activate) a specific tab. |
| `move_surface` | Move a tab to a different pane, window, or position. |
| `reorder_surface` | Reorder a tab within its pane. |
| `rename_tab` | Rename a tab. |
| `new_split` | Split the current surface into a new pane. |
| `drag_surface_to_split` | Drag a surface to create a split. |
| `refresh_surfaces` | Refresh all surfaces. |
| `surface_health` | Check health of surfaces. |

### Pane Management

| Tool | Description |
|------|-------------|
| `list_panes` | List all panes in a workspace. |
| `new_pane` | Create a new pane (split) with direction. |
| `focus_pane` | Focus a specific pane. |
| `resize_pane` | Resize a pane in a given direction. |
| `swap_pane` | Swap two panes. |
| `break_pane` | Break a pane out into a new workspace. |
| `join_pane` | Join a pane into another pane. |
| `last_pane` | Switch to the last active pane. |
| `list_panels` | List all panels in a workspace. |
| `focus_panel` | Focus a specific panel. |

### Window Management

| Tool | Description |
|------|-------------|
| `list_windows` | List all windows. |
| `new_window` | Create a new window. |
| `close_window` | Close a specific window. |
| `focus_window` | Focus a specific window. |
| `current_window` | Show current window info. |
| `rename_window` | Rename the current window. |
| `next_window` / `previous_window` / `last_window` | Navigate between windows. |
| `move_workspace_to_window` | Move a workspace to a different window. |

### Workspace Management

| Tool | Description |
|------|-------------|
| `list_workspaces` | List all workspaces. |
| `new_workspace` | Create a new workspace with optional cwd/command. |
| `close_workspace` | Close a specific workspace. |
| `select_workspace` | Switch to a specific workspace. |
| `rename_workspace` | Rename a workspace. |
| `current_workspace` | Show current workspace info. |
| `reorder_workspace` | Reorder a workspace in the sidebar. |

### Search & Structure

| Tool | Description |
|------|-------------|
| `find_window` | Search for a window by content or title. |
| `tree` | Show the full tree structure (windows/workspaces/panes/surfaces). |
| `identify` | Show identity info for the current surface/workspace. |

### Notifications

| Tool | Description |
|------|-------------|
| `notify` | Send a notification with title, subtitle, and body. |
| `list_notifications` | List all notifications. |
| `clear_notifications` | Clear all notifications. |

### Sidebar Metadata

| Tool | Description |
|------|-------------|
| `set_status` / `clear_status` / `list_status` | Manage status entries in the sidebar. |
| `set_progress` / `clear_progress` | Manage a progress bar in the sidebar. |
| `sidebar_state` | Show the current sidebar state. |

### Log

| Tool | Description |
|------|-------------|
| `log` | Write a log entry to the workspace sidebar. |
| `clear_log` | Clear log entries. |
| `list_log` | List log entries. |

### Buffer

| Tool | Description |
|------|-------------|
| `set_buffer` | Set a named buffer with text content. |
| `list_buffers` | List all buffers. |
| `paste_buffer` | Paste a buffer into the terminal. |

### Terminal Control

| Tool | Description |
|------|-------------|
| `clear_history` | Clear terminal scrollback history. |
| `capture_pane` | Capture pane content (tmux-compatible). |
| `respawn_pane` | Respawn a pane (restart the shell). |
| `pipe_pane` | Pipe pane output to a shell command. |
| `display_message` | Display a message overlay. |
| `trigger_flash` | Trigger a visual flash on the terminal. |

### Hooks & Misc

| Tool | Description |
|------|-------------|
| `set_hook` | Set, list, or unset event hooks. |
| `wait_for` | Wait for or send a named signal. |
| `set_app_focus` | Set the app focus state. |
| `markdown_open` | Open a markdown file in a formatted viewer with live reload. |
| `version` | Show cmux version. |
| `ping` | Ping the cmux socket. |

### Browser

| Tool | Description |
|------|-------------|
| `browser` | Control the cmux built-in browser with subcommands: `open`, `navigate`, `snapshot`, `click`, `type`, `eval`, `screenshot`, and [many more](https://github.com/manaflow-ai/cmux). |

### Real-World Examples

**Run tests and analyze failures:**
> "Run the test suite and tell me which tests are failing"

Claude sends `npm test`, reads the output, and summarizes the failures.

**Multi-tab SSH sessions:**
> "Open two new tabs, SSH into server-a in one and server-b in the other, then compare their disk usage"

Claude creates tabs, sends SSH commands to each, reads output from both, and compares.

**Interactive REPL session:**
> "Open a Python REPL and check if pandas is installed"

Claude starts `python3`, types `import pandas`, reads the result, and reports back.

**Long-running process management:**
> "Start the dev server, wait for it to be ready, then run the health check"

Claude sends the start command, polls the output until "ready" appears, then runs the next command.

## Why cmux-mcp?

### Background operation

cmux-mcp uses cmux's native CLI (`cmux send`, `cmux read-screen`, `cmux send-key`) which communicates via Unix socket. This means:

- Works while cmux is in the background
- No window focus stealing
- No AppleScript activation delays
- Reliable even during app initialization

### CLI vs AppleScript

This project was forked from [ferrislucas/iterm-mcp](https://github.com/ferrislucas/iterm-mcp) and completely rewritten. Here's why:

| | AppleScript (iterm-mcp) | cmux CLI (cmux-mcp) |
|---|---|---|
| **Focus** | May steal focus, activate app | No focus change, Unix socket |
| **Buffer reading** | Ghostty `write_scrollback_file` (debug-only) | `cmux read-screen` (stable production API) |
| **Startup** | Fails if app not fully initialized | Socket-based, more resilient |
| **Targeting** | Always "front window" | `--surface` flag for precise pane targeting |
| **Key support** | ASCII codes only | Named keys: `ctrl+c`, `escape`, `enter`, arrows |
| **Stability** | Fragile to app state changes | Decoupled via socket IPC |

### Smart completion detection

cmux-mcp doesn't just blindly wait after sending a command. It monitors the TTY's CPU activity to know when a command actually finishes -- even for commands that produce output over time. As of v1.3.1, the polling interval was reduced from 350ms to 150ms and the idle threshold from 1000ms to 500ms, making `write_to_terminal` roughly 2x faster.

### Token efficient

Agents read only the lines they need. A `npm test` that produces 500 lines of output? The agent first gets told "500 lines were output", then reads just the last 20 lines to check for errors. No wasted context window.

## Handling Known cmux Issues

cmux-mcp's architecture avoids several known cmux edge cases:

| Issue | Problem | How cmux-mcp handles it |
|-------|---------|------------------------|
| [#152](https://github.com/manaflow-ai/cmux/issues/152) | `read-screen` was debug-only | Uses the now-stable production CLI |
| [#2042](https://github.com/manaflow-ai/cmux/issues/2042) | Invalid surface ID silently falls back to focused pane | Architecture supports `--surface` for explicit targeting |
| [#1715](https://github.com/manaflow-ai/cmux/issues/1715) | TabManager unavailable during startup breaks hooks | Socket-based CLI avoids initialization timing issues |
| [#2153](https://github.com/manaflow-ai/cmux/issues/2153) | `send-key` didn't support arrow keys | Uses the updated upstream API with full key support |
| [#2210](https://github.com/manaflow-ai/cmux/issues/2210) | Sidebar toggle corrupts prompt via SIGWINCH | Reads buffer after settling delay to avoid corrupted output |

## Architecture

```
MCP Client (Claude Code, Claude Desktop, etc.)
    |  stdio
cmux-mcp server
    |  child_process
cmux CLI (send / read-screen / send-key / ...)
    |  Unix socket
cmux.app (Ghostty-based terminal)
    |
macOS PTY
```

**Core modules:**

| Module | Role |
|--------|------|
| `cmux-path` | Resolves `cmux` binary path: `CMUX_PATH` env > `which cmux` > macOS default paths > fallback |
| `CommandExecutor` | Sends commands via `cmux send`, waits for completion. Caches TTY path for 60s. |
| `TtyOutputReader` | Reads terminal buffer via `cmux read-screen` |
| `SendControlCharacter` | Sends control keys via `cmux send-key` |
| `ProcessTracker` | Monitors TTY processes for completion detection |

## Development

```bash
npm run build          # Compile TypeScript
npm run watch          # Auto-rebuild on changes
npm test               # Run unit tests
npm run e2e            # Run E2E tests (requires running cmux)
npm run inspector      # Open MCP Inspector for interactive debugging
```

## Safety

- No built-in command restrictions. Commands run with your shell's permissions.
- All tools are tagged with MCP annotations (see [Tools](#tools)) — configure your MCP client to auto-approve only read-only tools and require confirmation for destructive ones.
- Tool arguments are passed to the `cmux` CLI via `execFile` argv arrays (never through a shell), and ref/enum arguments are validated, so tool inputs cannot inject extra shell commands or CLI flags.
- Monitor AI activity and interrupt if needed.
- Start with focused tasks until you're familiar with the model's behavior.

## Credits

- Forked from [ferrislucas/iterm-mcp](https://github.com/ferrislucas/iterm-mcp)
- Built for [cmux](https://github.com/manaflow-ai/cmux) by manaflow.ai

## Privacy

cmux-mcp does not collect or transmit any data. All processing is local. See [PRIVACY.md](./PRIVACY.md) for details.

## License

MIT
