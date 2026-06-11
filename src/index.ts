#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import CommandExecutor from "./CommandExecutor.js";
import TtyOutputReader from "./TtyOutputReader.js";
import SendControlCharacter from "./SendControlCharacter.js";
import { CMUX_BIN } from "./cmux-path.js";

const execFileAsync = promisify(execFile);

// All cmux invocations go through execFile (no shell), so tool arguments can
// never be interpreted as shell syntax.
async function runCmux(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(CMUX_BIN, args);
  return stdout.trimEnd();
}

type ToolArgs = Record<string, unknown>;

// ─── Argument validation ───
// Refs (surface:1, workspace IDs, etc.) and other structured values are
// validated so they can't smuggle in extra CLI flags (argument injection).

const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_:.@/-]*$/;

function ref(value: unknown, label: string): string {
  const s = String(value);
  if (!REF_PATTERN.test(s)) {
    throw new Error(`Invalid ${label} ref: ${JSON.stringify(s)}`);
  }
  return s;
}

function intArg(value: unknown, label: string): string {
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new Error(`Invalid ${label}: expected an integer, got ${JSON.stringify(value)}`);
  }
  return String(n);
}

function numArg(value: unknown, label: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid ${label}: expected a number, got ${JSON.stringify(value)}`);
  }
  return String(n);
}

function oneOf(value: unknown, allowed: readonly string[], label: string): string {
  const s = String(value);
  if (!allowed.includes(s)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(s)} (expected one of ${allowed.join(', ')})`);
  }
  return s;
}

// Optional flag helpers: return [] when the arg is absent.
const optRef = (v: unknown, flag: string, label: string): string[] =>
  v === undefined || v === null || v === '' ? [] : [flag, ref(v, label)];
const optInt = (v: unknown, flag: string, label: string): string[] =>
  v === undefined || v === null ? [] : [flag, intArg(v, label)];
const optText = (v: unknown, flag: string): string[] =>
  v === undefined || v === null || v === '' ? [] : [flag, String(v)];

const server = new Server(
  { name: "cmux-mcp", version: "1.4.0" },
  { capabilities: { tools: {} } }
);

// ─── Annotation helpers ───
// Every tool is tagged with standard MCP tool annotations so clients can
// distinguish read-only, write, and dangerous/destructive tools:
//   readOnlyHint    — no side effects; safe to auto-approve
//   destructiveHint — dangerous: executes commands, kills processes, or
//                     irreversibly deletes data; warrants confirmation
//   idempotentHint  — repeating the same call has no additional effect
//   openWorldHint   — interacts with the outside world (e.g. the web)

interface Hints {
  read?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  openWorld?: boolean;
}

function annotate(title: string, hints: Hints = {}) {
  return {
    title,
    annotations: {
      title,
      readOnlyHint: hints.read ?? false,
      destructiveHint: hints.destructive ?? false,
      idempotentHint: hints.idempotent ?? false,
      openWorldHint: hints.openWorld ?? false,
    },
  };
}

const readOnly = (title: string) => annotate(title, { read: true, idempotent: true });
const write = (title: string, idempotent = true) => annotate(title, { idempotent });
const dangerous = (title: string, idempotent = false) => annotate(title, { destructive: true, idempotent });

// ─── Tool Definitions ───
const tools = [
  // === Terminal I/O ===
  {
    name: "write_to_terminal",
    ...dangerous("Write to Terminal"),
    description: "Writes text to the active cmux terminal - often used to run a command in the terminal. Executes arbitrary commands in the user's shell.",
    inputSchema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "The command to run or text to write to the terminal" },
        surface: { type: "string", description: "Optional surface ref (e.g. 'surface:1') to target a specific tab. If omitted, targets the active surface." },
      },
      required: ["command"]
    }
  },
  {
    name: "read_terminal_output",
    ...readOnly("Read Terminal Output"),
    description: "Reads the output from the active cmux terminal",
    inputSchema: {
      type: "object" as const,
      properties: {
        linesOfOutput: { type: "integer", description: "The number of lines of output to read." },
        surface: { type: "string", description: "Optional surface ref (e.g. 'surface:1') to read from a specific tab. If omitted, reads from the active surface." },
      },
      required: ["linesOfOutput"]
    }
  },
  {
    name: "send_control_character",
    ...dangerous("Send Control Character"),
    description: "Sends a control character to the active cmux terminal (e.g., Control-C, or special sequences like ']' for telnet escape). Can interrupt or terminate running processes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        letter: { type: "string", description: "The letter corresponding to the control character (e.g., 'C' for Control-C, ']' for telnet escape)" },
        surface: { type: "string", description: "Optional surface ref to target a specific tab." },
      },
      required: ["letter"]
    }
  },

  // === Surface (Tab) Management ===
  {
    name: "list_surfaces",
    ...readOnly("List Surfaces"),
    description: "Lists all surfaces (tabs) in the current workspace with their IDs and titles",
    inputSchema: { type: "object" as const, properties: { workspace: { type: "string", description: "Optional workspace ref." }, pane: { type: "string", description: "Optional pane ref." } } }
  },
  {
    name: "new_surface",
    ...write("New Surface", false),
    description: "Creates a new terminal tab in the current pane",
    inputSchema: { type: "object" as const, properties: { workspace: { type: "string", description: "Optional workspace ref." }, pane: { type: "string", description: "Optional pane ref." } } }
  },
  {
    name: "close_surface",
    ...dangerous("Close Surface", true),
    description: "Closes a specific surface (tab), terminating any process running in it",
    inputSchema: { type: "object" as const, properties: { surface: { type: "string", description: "Surface ref to close. Required." }, workspace: { type: "string", description: "Optional workspace ref." } }, required: ["surface"] }
  },
  {
    name: "focus_surface",
    ...write("Focus Surface"),
    description: "Focuses (activates) a specific surface (tab)",
    inputSchema: { type: "object" as const, properties: { surface: { type: "string", description: "Surface ref to focus. Required." }, workspace: { type: "string", description: "Optional workspace ref." } }, required: ["surface"] }
  },
  {
    name: "move_surface",
    ...write("Move Surface"),
    description: "Moves a surface to a different pane, window, or position",
    inputSchema: { type: "object" as const, properties: { surface: { type: "string", description: "Surface ref to move. Required." }, pane: { type: "string", description: "Target pane ref." }, workspace: { type: "string", description: "Target workspace ref." }, window: { type: "string", description: "Target window ref." }, before: { type: "string", description: "Place before this surface ref." }, after: { type: "string", description: "Place after this surface ref." }, index: { type: "integer", description: "Target index position." }, focus: { type: "boolean", description: "Focus after move. Default true." } }, required: ["surface"] }
  },
  {
    name: "reorder_surface",
    ...write("Reorder Surface"),
    description: "Reorders a surface within its pane",
    inputSchema: { type: "object" as const, properties: { surface: { type: "string", description: "Surface ref. Required." }, index: { type: "integer", description: "Target index." }, before: { type: "string", description: "Place before this ref." }, after: { type: "string", description: "Place after this ref." } }, required: ["surface"] }
  },
  {
    name: "rename_tab",
    ...write("Rename Tab"),
    description: "Renames a tab (surface)",
    inputSchema: { type: "object" as const, properties: { title: { type: "string", description: "New title. Required." }, surface: { type: "string", description: "Optional surface ref." }, workspace: { type: "string", description: "Optional workspace ref." } }, required: ["title"] }
  },
  {
    name: "new_split",
    ...write("New Split", false),
    description: "Splits the current surface into a new pane",
    inputSchema: { type: "object" as const, properties: { direction: { type: "string", enum: ["left", "right", "up", "down"], description: "Split direction. Required." }, workspace: { type: "string", description: "Optional workspace ref." }, surface: { type: "string", description: "Optional surface ref." }, panel: { type: "string", description: "Optional panel ref." } }, required: ["direction"] }
  },
  {
    name: "drag_surface_to_split",
    ...write("Drag Surface to Split", false),
    description: "Drags a surface to create a split in a direction",
    inputSchema: { type: "object" as const, properties: { surface: { type: "string", description: "Surface ref. Required." }, direction: { type: "string", enum: ["left", "right", "up", "down"], description: "Direction. Required." } }, required: ["surface", "direction"] }
  },
  {
    name: "refresh_surfaces",
    ...write("Refresh Surfaces"),
    description: "Refreshes all surfaces",
    inputSchema: { type: "object" as const, properties: {} }
  },
  {
    name: "surface_health",
    ...readOnly("Surface Health"),
    description: "Checks health of surfaces in a workspace",
    inputSchema: { type: "object" as const, properties: { workspace: { type: "string", description: "Optional workspace ref." } } }
  },

  // === Pane Management ===
  {
    name: "list_panes",
    ...readOnly("List Panes"),
    description: "Lists all panes in the current workspace",
    inputSchema: { type: "object" as const, properties: { workspace: { type: "string", description: "Optional workspace ref." } } }
  },
  {
    name: "new_pane",
    ...write("New Pane", false),
    description: "Creates a new pane (split) in the workspace",
    inputSchema: { type: "object" as const, properties: { direction: { type: "string", enum: ["left", "right", "up", "down"], description: "Split direction. Defaults to right." }, workspace: { type: "string", description: "Optional workspace ref." } } }
  },
  {
    name: "focus_pane",
    ...write("Focus Pane"),
    description: "Focuses a specific pane",
    inputSchema: { type: "object" as const, properties: { pane: { type: "string", description: "Pane ref. Required." }, workspace: { type: "string", description: "Optional workspace ref." } }, required: ["pane"] }
  },
  {
    name: "resize_pane",
    ...write("Resize Pane", false),
    description: "Resizes a pane in a given direction",
    inputSchema: { type: "object" as const, properties: { pane: { type: "string", description: "Pane ref. Required." }, direction: { type: "string", enum: ["L", "R", "U", "D"], description: "Resize direction (L=left, R=right, U=up, D=down). Required." }, amount: { type: "integer", description: "Amount to resize. Default 1." }, workspace: { type: "string", description: "Optional workspace ref." } }, required: ["pane", "direction"] }
  },
  {
    name: "swap_pane",
    ...write("Swap Panes", false),
    description: "Swaps two panes",
    inputSchema: { type: "object" as const, properties: { pane: { type: "string", description: "Source pane ref. Required." }, target_pane: { type: "string", description: "Target pane ref. Required." }, workspace: { type: "string", description: "Optional workspace ref." } }, required: ["pane", "target_pane"] }
  },
  {
    name: "break_pane",
    ...write("Break Pane", false),
    description: "Breaks a pane out into a new workspace",
    inputSchema: { type: "object" as const, properties: { pane: { type: "string", description: "Optional pane ref." }, workspace: { type: "string", description: "Optional workspace ref." }, surface: { type: "string", description: "Optional surface ref." } } }
  },
  {
    name: "join_pane",
    ...write("Join Pane", false),
    description: "Joins a pane into another pane",
    inputSchema: { type: "object" as const, properties: { target_pane: { type: "string", description: "Target pane to join into. Required." }, pane: { type: "string", description: "Optional source pane ref." }, workspace: { type: "string", description: "Optional workspace ref." }, surface: { type: "string", description: "Optional surface ref." } }, required: ["target_pane"] }
  },
  {
    name: "last_pane",
    ...write("Last Pane", false),
    description: "Switches to the last active pane",
    inputSchema: { type: "object" as const, properties: { workspace: { type: "string", description: "Optional workspace ref." } } }
  },
  {
    name: "list_panels",
    ...readOnly("List Panels"),
    description: "Lists all panels in a workspace",
    inputSchema: { type: "object" as const, properties: { workspace: { type: "string", description: "Optional workspace ref." } } }
  },
  {
    name: "focus_panel",
    ...write("Focus Panel"),
    description: "Focuses a specific panel",
    inputSchema: { type: "object" as const, properties: { panel: { type: "string", description: "Panel ref. Required." }, workspace: { type: "string", description: "Optional workspace ref." } }, required: ["panel"] }
  },

  // === Window Management ===
  { name: "list_windows", ...readOnly("List Windows"), description: "Lists all cmux windows", inputSchema: { type: "object" as const, properties: {} } },
  { name: "new_window", ...write("New Window", false), description: "Creates a new cmux window", inputSchema: { type: "object" as const, properties: {} } },
  { name: "close_window", ...dangerous("Close Window", true), description: "Closes a specific cmux window, terminating any processes running in it", inputSchema: { type: "object" as const, properties: { window: { type: "string", description: "Window ID. Required." } }, required: ["window"] } },
  { name: "focus_window", ...write("Focus Window"), description: "Focuses a specific cmux window", inputSchema: { type: "object" as const, properties: { window: { type: "string", description: "Window ID. Required." } }, required: ["window"] } },
  { name: "current_window", ...readOnly("Current Window"), description: "Shows the current window info", inputSchema: { type: "object" as const, properties: {} } },
  {
    name: "rename_window",
    ...write("Rename Window"),
    description: "Renames the current window",
    inputSchema: { type: "object" as const, properties: { title: { type: "string", description: "New title. Required." }, workspace: { type: "string", description: "Optional workspace ref." } }, required: ["title"] }
  },
  { name: "next_window", ...write("Next Window", false), description: "Switches to the next window", inputSchema: { type: "object" as const, properties: {} } },
  { name: "previous_window", ...write("Previous Window", false), description: "Switches to the previous window", inputSchema: { type: "object" as const, properties: {} } },
  { name: "last_window", ...write("Last Window", false), description: "Switches to the last active window", inputSchema: { type: "object" as const, properties: {} } },
  {
    name: "move_workspace_to_window",
    ...write("Move Workspace to Window"),
    description: "Moves a workspace to a different window",
    inputSchema: { type: "object" as const, properties: { workspace: { type: "string", description: "Workspace ref. Required." }, window: { type: "string", description: "Target window ref. Required." } }, required: ["workspace", "window"] }
  },

  // === Workspace Management ===
  { name: "list_workspaces", ...readOnly("List Workspaces"), description: "Lists all workspaces in the current window", inputSchema: { type: "object" as const, properties: {} } },
  {
    name: "new_workspace",
    ...dangerous("New Workspace"),
    description: "Creates a new workspace (shown in the left sidebar). If `command` is given, it is executed in the new workspace's shell.",
    inputSchema: { type: "object" as const, properties: { cwd: { type: "string", description: "Optional working directory." }, command: { type: "string", description: "Optional command to run." } } }
  },
  { name: "close_workspace", ...dangerous("Close Workspace", true), description: "Closes a specific workspace, terminating any processes running in it", inputSchema: { type: "object" as const, properties: { workspace: { type: "string", description: "Workspace ref. Required." } }, required: ["workspace"] } },
  { name: "select_workspace", ...write("Select Workspace"), description: "Selects (switches to) a specific workspace", inputSchema: { type: "object" as const, properties: { workspace: { type: "string", description: "Workspace ref. Required." } }, required: ["workspace"] } },
  {
    name: "rename_workspace",
    ...write("Rename Workspace"),
    description: "Renames a workspace",
    inputSchema: { type: "object" as const, properties: { title: { type: "string", description: "New title. Required." }, workspace: { type: "string", description: "Optional workspace ref." } }, required: ["title"] }
  },
  { name: "current_workspace", ...readOnly("Current Workspace"), description: "Shows the current workspace info", inputSchema: { type: "object" as const, properties: {} } },
  {
    name: "reorder_workspace",
    ...write("Reorder Workspace"),
    description: "Reorders a workspace within the sidebar",
    inputSchema: { type: "object" as const, properties: { workspace: { type: "string", description: "Workspace ref. Required." }, index: { type: "integer", description: "Target index." }, before: { type: "string", description: "Place before this ref." }, after: { type: "string", description: "Place after this ref." } }, required: ["workspace"] }
  },

  // === Search ===
  {
    name: "find_window",
    ...write("Find Window"),
    description: "Searches for a window by content or title. With `select`, also switches to the found window.",
    inputSchema: { type: "object" as const, properties: { query: { type: "string", description: "Search query. Required." }, content: { type: "boolean", description: "Search in terminal content." }, select: { type: "boolean", description: "Select the found window." } }, required: ["query"] }
  },

  // === Structure ===
  {
    name: "tree",
    ...readOnly("Show Tree"),
    description: "Shows the full tree structure of windows/workspaces/panes/surfaces",
    inputSchema: { type: "object" as const, properties: { all: { type: "boolean", description: "Show all windows." }, workspace: { type: "string", description: "Optional workspace ref." } } }
  },
  {
    name: "identify",
    ...readOnly("Identify"),
    description: "Shows identity info for the current surface/workspace",
    inputSchema: { type: "object" as const, properties: { workspace: { type: "string", description: "Optional workspace ref." }, surface: { type: "string", description: "Optional surface ref." } } }
  },

  // === Notifications ===
  {
    name: "notify",
    ...write("Send Notification", false),
    description: "Sends a notification",
    inputSchema: { type: "object" as const, properties: { title: { type: "string", description: "Notification title. Required." }, subtitle: { type: "string", description: "Optional subtitle." }, body: { type: "string", description: "Optional body text." }, workspace: { type: "string", description: "Optional workspace ref." }, surface: { type: "string", description: "Optional surface ref." } }, required: ["title"] }
  },
  { name: "list_notifications", ...readOnly("List Notifications"), description: "Lists all notifications", inputSchema: { type: "object" as const, properties: {} } },
  { name: "clear_notifications", ...dangerous("Clear Notifications", true), description: "Clears all notifications (cannot be undone)", inputSchema: { type: "object" as const, properties: {} } },

  // === Sidebar Metadata ===
  {
    name: "set_status",
    ...write("Set Status"),
    description: "Sets a status entry in the sidebar",
    inputSchema: { type: "object" as const, properties: { key: { type: "string", description: "Status key. Required." }, value: { type: "string", description: "Status value. Required." }, icon: { type: "string", description: "Optional icon name." }, color: { type: "string", description: "Optional hex color." }, workspace: { type: "string", description: "Optional workspace ref." } }, required: ["key", "value"] }
  },
  { name: "clear_status", ...write("Clear Status"), description: "Clears a status entry", inputSchema: { type: "object" as const, properties: { key: { type: "string", description: "Status key. Required." }, workspace: { type: "string", description: "Optional workspace ref." } }, required: ["key"] } },
  { name: "list_status", ...readOnly("List Status"), description: "Lists all status entries", inputSchema: { type: "object" as const, properties: { workspace: { type: "string", description: "Optional workspace ref." } } } },
  {
    name: "set_progress",
    ...write("Set Progress"),
    description: "Sets a progress bar in the sidebar (0.0 to 1.0)",
    inputSchema: { type: "object" as const, properties: { value: { type: "number", description: "Progress value 0.0-1.0. Required." }, label: { type: "string", description: "Optional label." }, workspace: { type: "string", description: "Optional workspace ref." } }, required: ["value"] }
  },
  { name: "clear_progress", ...write("Clear Progress"), description: "Clears the progress bar", inputSchema: { type: "object" as const, properties: { workspace: { type: "string", description: "Optional workspace ref." } } } },
  { name: "sidebar_state", ...readOnly("Sidebar State"), description: "Shows the current sidebar state", inputSchema: { type: "object" as const, properties: { workspace: { type: "string", description: "Optional workspace ref." } } } },

  // === Log ===
  {
    name: "log",
    ...write("Write Log Entry", false),
    description: "Writes a log entry to the workspace sidebar",
    inputSchema: { type: "object" as const, properties: { message: { type: "string", description: "Log message. Required." }, level: { type: "string", description: "Log level (info, warn, error)." }, source: { type: "string", description: "Optional source name." }, workspace: { type: "string", description: "Optional workspace ref." } }, required: ["message"] }
  },
  { name: "clear_log", ...dangerous("Clear Log", true), description: "Clears log entries (cannot be undone)", inputSchema: { type: "object" as const, properties: { workspace: { type: "string", description: "Optional workspace ref." } } } },
  { name: "list_log", ...readOnly("List Log"), description: "Lists log entries", inputSchema: { type: "object" as const, properties: { limit: { type: "integer", description: "Max entries to show." }, workspace: { type: "string", description: "Optional workspace ref." } } } },

  // === Buffer ===
  { name: "set_buffer", ...write("Set Buffer"), description: "Sets a named buffer with text content (overwrites any existing content)", inputSchema: { type: "object" as const, properties: { text: { type: "string", description: "Buffer content. Required." }, name: { type: "string", description: "Optional buffer name." } }, required: ["text"] } },
  { name: "list_buffers", ...readOnly("List Buffers"), description: "Lists all buffers", inputSchema: { type: "object" as const, properties: {} } },
  { name: "paste_buffer", ...dangerous("Paste Buffer"), description: "Pastes a buffer into the terminal. Buffer content containing newlines may execute as commands.", inputSchema: { type: "object" as const, properties: { name: { type: "string", description: "Optional buffer name." }, workspace: { type: "string", description: "Optional workspace ref." }, surface: { type: "string", description: "Optional surface ref." } } } },

  // === Terminal Control ===
  { name: "clear_history", ...dangerous("Clear History", true), description: "Clears terminal scrollback history (cannot be undone)", inputSchema: { type: "object" as const, properties: { workspace: { type: "string", description: "Optional workspace ref." }, surface: { type: "string", description: "Optional surface ref." } } } },
  { name: "respawn_pane", ...dangerous("Respawn Pane"), description: "Respawns a pane (kills and restarts the shell). If `command` is given, it is executed in the new shell.", inputSchema: { type: "object" as const, properties: { workspace: { type: "string", description: "Optional workspace ref." }, surface: { type: "string", description: "Optional surface ref." }, command: { type: "string", description: "Optional command to run." } } } },
  { name: "display_message", ...write("Display Message"), description: "Displays a message overlay", inputSchema: { type: "object" as const, properties: { text: { type: "string", description: "Message text. Required." }, print: { type: "boolean", description: "Print to stdout instead." } }, required: ["text"] } },
  { name: "trigger_flash", ...write("Trigger Flash"), description: "Triggers a visual flash on the terminal", inputSchema: { type: "object" as const, properties: { workspace: { type: "string", description: "Optional workspace ref." }, surface: { type: "string", description: "Optional surface ref." } } } },
  { name: "pipe_pane", ...dangerous("Pipe Pane"), description: "Pipes pane output to a shell command. Executes an arbitrary shell command.", inputSchema: { type: "object" as const, properties: { command: { type: "string", description: "Shell command. Required." }, workspace: { type: "string", description: "Optional workspace ref." }, surface: { type: "string", description: "Optional surface ref." } }, required: ["command"] } },
  { name: "capture_pane", ...readOnly("Capture Pane"), description: "Captures pane content (tmux-compatible)", inputSchema: { type: "object" as const, properties: { workspace: { type: "string", description: "Optional workspace ref." }, surface: { type: "string", description: "Optional surface ref." }, scrollback: { type: "boolean", description: "Include scrollback." }, lines: { type: "integer", description: "Number of lines." } } } },

  // === Hooks & Misc ===
  { name: "set_hook", ...dangerous("Set Hook", true), description: "Sets or lists event hooks. Setting a hook registers an arbitrary command to execute on future events.", inputSchema: { type: "object" as const, properties: { event: { type: "string", description: "Event name (for set/unset)." }, command: { type: "string", description: "Command to run on event." }, list: { type: "boolean", description: "List all hooks." }, unset: { type: "string", description: "Unset a hook by event name." } } } },
  { name: "wait_for", ...write("Wait For Signal", false), description: "Waits for a named signal", inputSchema: { type: "object" as const, properties: { name: { type: "string", description: "Signal name. Required." }, signal: { type: "boolean", description: "Send the signal instead of waiting." }, timeout: { type: "integer", description: "Timeout in seconds." } }, required: ["name"] } },
  { name: "set_app_focus", ...write("Set App Focus"), description: "Sets the app focus state", inputSchema: { type: "object" as const, properties: { state: { type: "string", enum: ["active", "inactive", "clear"], description: "Focus state. Required." } }, required: ["state"] } },
  { name: "markdown_open", ...write("Open Markdown"), description: "Opens a markdown file in a formatted viewer panel with live reload", inputSchema: { type: "object" as const, properties: { path: { type: "string", description: "Path to markdown file. Required." } }, required: ["path"] } },
  { name: "version", ...readOnly("cmux Version"), description: "Shows cmux version", inputSchema: { type: "object" as const, properties: {} } },
  { name: "ping", ...readOnly("Ping"), description: "Pings the cmux socket", inputSchema: { type: "object" as const, properties: {} } },

  // === Browser ===
  {
    name: "browser",
    ...annotate("Browser Control", { destructive: true, openWorld: true }),
    description: "Controls the cmux built-in browser. Subcommands: open, open-split, navigate/goto, back, forward, reload, url, snapshot, eval, wait, click, dblclick, hover, focus, check, uncheck, scroll-into-view, type, fill, press, keydown, keyup, select, scroll, screenshot, get, is, find, frame, dialog, download, cookies, storage, tab, console, errors, highlight, state, addinitscript, addscript, addstyle, identify",
    inputSchema: {
      type: "object" as const,
      properties: {
        subcommand: { type: "string", description: "Browser subcommand (e.g. 'open', 'navigate', 'snapshot', 'click'). Required." },
        args: {
          description: "Arguments for the subcommand (e.g. URL, CSS selector, script). Prefer an array of strings; a single string is split on whitespace.",
          anyOf: [
            { type: "array", items: { type: "string" } },
            { type: "string" },
          ],
        },
        surface: { type: "string", description: "Optional surface ref for browser surface." },
      },
      required: ["subcommand"]
    }
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

// ─── Tool Handlers ───

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

async function handleToolCall(name: string, args: ToolArgs) {
  switch (name) {
    // === Terminal I/O ===
    case "write_to_terminal": {
      const surface = args.surface ? ref(args.surface, 'surface') : undefined;
      const executor = new CommandExecutor(undefined, surface);
      const command = String(args.command);
      const beforeBuffer = await TtyOutputReader.retrieveBuffer(surface);
      const beforeLines = beforeBuffer.split("\n").length;
      await executor.executeCommand(command);
      const afterBuffer = await TtyOutputReader.retrieveBuffer(surface);
      const afterLines = afterBuffer.split("\n").length;
      const outputLines = afterLines - beforeLines;
      return textResult(`${outputLines} lines were output after sending the command to the terminal. Read the last ${outputLines} lines of terminal contents to orient yourself. Never assume that the command was executed or that it was successful.`);
    }
    case "read_terminal_output": {
      const linesOfOutput = Number(args.linesOfOutput) || 25;
      const surface = args.surface ? ref(args.surface, 'surface') : undefined;
      const output = await TtyOutputReader.call(linesOfOutput, surface);
      return textResult(output);
    }
    case "send_control_character": {
      const surface = args.surface ? ref(args.surface, 'surface') : undefined;
      const ctrl = new SendControlCharacter(surface);
      const letter = String(args.letter);
      await ctrl.send(letter);
      return textResult(`Sent control character: Control-${letter.toUpperCase()}`);
    }

    // === Surface ===
    case "list_surfaces":
      return textResult(await runCmux(['list-pane-surfaces', ...optRef(args.workspace, '--workspace', 'workspace'), ...optRef(args.pane, '--pane', 'pane')]));
    case "new_surface":
      return textResult(`New surface created. ${await runCmux(['new-surface', '--type', 'terminal', ...optRef(args.workspace, '--workspace', 'workspace'), ...optRef(args.pane, '--pane', 'pane')])}`);
    case "close_surface":
      return textResult(`Surface ${args.surface} closed. ${await runCmux(['close-surface', '--surface', ref(args.surface, 'surface'), ...optRef(args.workspace, '--workspace', 'workspace')])}`);
    case "focus_surface":
      return textResult(`Focused surface ${args.surface}. ${await runCmux(['move-surface', '--surface', ref(args.surface, 'surface'), '--focus', 'true', ...optRef(args.workspace, '--workspace', 'workspace')])}`);
    case "move_surface": {
      const cmd = ['move-surface', '--surface', ref(args.surface, 'surface'),
        ...optRef(args.pane, '--pane', 'pane'),
        ...optRef(args.workspace, '--workspace', 'workspace'),
        ...optRef(args.window, '--window', 'window'),
        ...optRef(args.before, '--before', 'before'),
        ...optRef(args.after, '--after', 'after'),
        ...optInt(args.index, '--index', 'index')];
      if (args.focus !== undefined) cmd.push('--focus', String(Boolean(args.focus)));
      return textResult(await runCmux(cmd));
    }
    case "reorder_surface":
      return textResult(await runCmux(['reorder-surface', '--surface', ref(args.surface, 'surface'),
        ...optInt(args.index, '--index', 'index'),
        ...optRef(args.before, '--before', 'before'),
        ...optRef(args.after, '--after', 'after')]));
    case "rename_tab":
      return textResult(await runCmux(['rename-tab',
        ...optRef(args.workspace, '--workspace', 'workspace'),
        ...optRef(args.surface, '--surface', 'surface'),
        String(args.title)]));
    case "new_split":
      return textResult(await runCmux(['new-split', oneOf(args.direction, ['left', 'right', 'up', 'down'], 'direction'),
        ...optRef(args.workspace, '--workspace', 'workspace'),
        ...optRef(args.surface, '--surface', 'surface'),
        ...optRef(args.panel, '--panel', 'panel')]));
    case "drag_surface_to_split":
      return textResult(await runCmux(['drag-surface-to-split', '--surface', ref(args.surface, 'surface'), oneOf(args.direction, ['left', 'right', 'up', 'down'], 'direction')]));
    case "refresh_surfaces":
      return textResult(await runCmux(['refresh-surfaces']));
    case "surface_health":
      return textResult(await runCmux(['surface-health', ...optRef(args.workspace, '--workspace', 'workspace')]));

    // === Pane ===
    case "list_panes":
      return textResult(await runCmux(['list-panes', ...optRef(args.workspace, '--workspace', 'workspace')]));
    case "new_pane":
      return textResult(`New pane created. ${await runCmux(['new-pane', '--type', 'terminal', '--direction', oneOf(args.direction ?? 'right', ['left', 'right', 'up', 'down'], 'direction'), ...optRef(args.workspace, '--workspace', 'workspace')])}`);
    case "focus_pane":
      return textResult(await runCmux(['focus-pane', '--pane', ref(args.pane, 'pane'), ...optRef(args.workspace, '--workspace', 'workspace')]));
    case "resize_pane":
      return textResult(await runCmux(['resize-pane', '--pane', ref(args.pane, 'pane'),
        `-${oneOf(args.direction, ['L', 'R', 'U', 'D'], 'direction')}`,
        ...optInt(args.amount, '--amount', 'amount'),
        ...optRef(args.workspace, '--workspace', 'workspace')]));
    case "swap_pane":
      return textResult(await runCmux(['swap-pane', '--pane', ref(args.pane, 'pane'), '--target-pane', ref(args.target_pane, 'target_pane'), ...optRef(args.workspace, '--workspace', 'workspace')]));
    case "break_pane":
      return textResult(await runCmux(['break-pane',
        ...optRef(args.pane, '--pane', 'pane'),
        ...optRef(args.workspace, '--workspace', 'workspace'),
        ...optRef(args.surface, '--surface', 'surface')]));
    case "join_pane":
      return textResult(await runCmux(['join-pane', '--target-pane', ref(args.target_pane, 'target_pane'),
        ...optRef(args.pane, '--pane', 'pane'),
        ...optRef(args.workspace, '--workspace', 'workspace'),
        ...optRef(args.surface, '--surface', 'surface')]));
    case "last_pane":
      return textResult(await runCmux(['last-pane', ...optRef(args.workspace, '--workspace', 'workspace')]));
    case "list_panels":
      return textResult(await runCmux(['list-panels', ...optRef(args.workspace, '--workspace', 'workspace')]));
    case "focus_panel":
      return textResult(await runCmux(['focus-panel', '--panel', ref(args.panel, 'panel'), ...optRef(args.workspace, '--workspace', 'workspace')]));

    // === Window ===
    case "list_windows": return textResult(await runCmux(['list-windows']));
    case "new_window": return textResult(`New window created. ${await runCmux(['new-window'])}`);
    case "close_window": return textResult(`Window closed. ${await runCmux(['close-window', '--window', ref(args.window, 'window')])}`);
    case "focus_window": return textResult(await runCmux(['focus-window', '--window', ref(args.window, 'window')]));
    case "current_window": return textResult(await runCmux(['current-window']));
    case "rename_window":
      return textResult(await runCmux(['rename-window', ...optRef(args.workspace, '--workspace', 'workspace'), String(args.title)]));
    case "next_window": return textResult(await runCmux(['next-window']));
    case "previous_window": return textResult(await runCmux(['previous-window']));
    case "last_window": return textResult(await runCmux(['last-window']));
    case "move_workspace_to_window":
      return textResult(await runCmux(['move-workspace-to-window', '--workspace', ref(args.workspace, 'workspace'), '--window', ref(args.window, 'window')]));

    // === Workspace ===
    case "list_workspaces": return textResult(await runCmux(['list-workspaces']));
    case "new_workspace":
      return textResult(`New workspace created. ${await runCmux(['new-workspace', ...optText(args.cwd, '--cwd'), ...optText(args.command, '--command')])}`);
    case "close_workspace": return textResult(await runCmux(['close-workspace', '--workspace', ref(args.workspace, 'workspace')]));
    case "select_workspace": return textResult(await runCmux(['select-workspace', '--workspace', ref(args.workspace, 'workspace')]));
    case "rename_workspace":
      return textResult(await runCmux(['rename-workspace', ...optRef(args.workspace, '--workspace', 'workspace'), String(args.title)]));
    case "current_workspace": return textResult(await runCmux(['current-workspace']));
    case "reorder_workspace":
      return textResult(await runCmux(['reorder-workspace', '--workspace', ref(args.workspace, 'workspace'),
        ...optInt(args.index, '--index', 'index'),
        ...optRef(args.before, '--before', 'before'),
        ...optRef(args.after, '--after', 'after')]));

    // === Search ===
    case "find_window": {
      const cmd = ['find-window'];
      if (args.content) cmd.push('--content');
      if (args.select) cmd.push('--select');
      cmd.push(String(args.query));
      return textResult(await runCmux(cmd));
    }

    // === Structure ===
    case "tree": {
      const cmd = ['tree'];
      if (args.all) cmd.push('--all');
      cmd.push(...optRef(args.workspace, '--workspace', 'workspace'));
      return textResult(await runCmux(cmd));
    }
    case "identify":
      return textResult(await runCmux(['identify', ...optRef(args.workspace, '--workspace', 'workspace'), ...optRef(args.surface, '--surface', 'surface')]));

    // === Notifications ===
    case "notify":
      return textResult(await runCmux(['notify', '--title', String(args.title),
        ...optText(args.subtitle, '--subtitle'),
        ...optText(args.body, '--body'),
        ...optRef(args.workspace, '--workspace', 'workspace'),
        ...optRef(args.surface, '--surface', 'surface')]));
    case "list_notifications": return textResult(await runCmux(['list-notifications']));
    case "clear_notifications": return textResult(await runCmux(['clear-notifications']));

    // === Sidebar ===
    case "set_status": {
      const cmd = ['set-status', String(args.key), String(args.value), ...optText(args.icon, '--icon')];
      if (args.color) {
        const color = String(args.color);
        if (!/^#?[0-9a-fA-F]{3,8}$/.test(color)) throw new Error(`Invalid color: ${JSON.stringify(color)}`);
        cmd.push('--color', color);
      }
      cmd.push(...optRef(args.workspace, '--workspace', 'workspace'));
      return textResult(await runCmux(cmd));
    }
    case "clear_status":
      return textResult(await runCmux(['clear-status', String(args.key), ...optRef(args.workspace, '--workspace', 'workspace')]));
    case "list_status":
      return textResult(await runCmux(['list-status', ...optRef(args.workspace, '--workspace', 'workspace')]));
    case "set_progress":
      return textResult(await runCmux(['set-progress', numArg(args.value, 'value'),
        ...optText(args.label, '--label'),
        ...optRef(args.workspace, '--workspace', 'workspace')]));
    case "clear_progress":
      return textResult(await runCmux(['clear-progress', ...optRef(args.workspace, '--workspace', 'workspace')]));
    case "sidebar_state":
      return textResult(await runCmux(['sidebar-state', ...optRef(args.workspace, '--workspace', 'workspace')]));

    // === Log ===
    case "log": {
      const cmd = ['log'];
      if (args.level) cmd.push('--level', oneOf(args.level, ['info', 'warn', 'error', 'debug'], 'level'));
      cmd.push(...optText(args.source, '--source'));
      cmd.push(...optRef(args.workspace, '--workspace', 'workspace'));
      cmd.push('--', String(args.message));
      return textResult(await runCmux(cmd));
    }
    case "clear_log":
      return textResult(await runCmux(['clear-log', ...optRef(args.workspace, '--workspace', 'workspace')]));
    case "list_log":
      return textResult(await runCmux(['list-log', ...optInt(args.limit, '--limit', 'limit'), ...optRef(args.workspace, '--workspace', 'workspace')]));

    // === Buffer ===
    case "set_buffer":
      return textResult(await runCmux(['set-buffer', ...optText(args.name, '--name'), String(args.text)]));
    case "list_buffers": return textResult(await runCmux(['list-buffers']));
    case "paste_buffer":
      return textResult(await runCmux(['paste-buffer',
        ...optText(args.name, '--name'),
        ...optRef(args.workspace, '--workspace', 'workspace'),
        ...optRef(args.surface, '--surface', 'surface')]));

    // === Terminal Control ===
    case "clear_history":
      return textResult(await runCmux(['clear-history', ...optRef(args.workspace, '--workspace', 'workspace'), ...optRef(args.surface, '--surface', 'surface')]));
    case "respawn_pane":
      return textResult(await runCmux(['respawn-pane',
        ...optRef(args.workspace, '--workspace', 'workspace'),
        ...optRef(args.surface, '--surface', 'surface'),
        ...optText(args.command, '--command')]));
    case "display_message": {
      const cmd = ['display-message'];
      if (args.print) cmd.push('-p');
      cmd.push(String(args.text));
      return textResult(await runCmux(cmd));
    }
    case "trigger_flash":
      return textResult(await runCmux(['trigger-flash', ...optRef(args.workspace, '--workspace', 'workspace'), ...optRef(args.surface, '--surface', 'surface')]));
    case "pipe_pane":
      return textResult(await runCmux(['pipe-pane', '--command', String(args.command),
        ...optRef(args.workspace, '--workspace', 'workspace'),
        ...optRef(args.surface, '--surface', 'surface')]));
    case "capture_pane": {
      const cmd = ['capture-pane',
        ...optRef(args.workspace, '--workspace', 'workspace'),
        ...optRef(args.surface, '--surface', 'surface')];
      if (args.scrollback) cmd.push('--scrollback');
      cmd.push(...optInt(args.lines, '--lines', 'lines'));
      return textResult(await runCmux(cmd));
    }

    // === Hooks & Misc ===
    case "set_hook": {
      if (args.list) return textResult(await runCmux(['set-hook', '--list']));
      if (args.unset) return textResult(await runCmux(['set-hook', '--unset', String(args.unset)]));
      return textResult(await runCmux(['set-hook', String(args.event), String(args.command)]));
    }
    case "wait_for": {
      const cmd = ['wait-for'];
      if (args.signal) cmd.push('-S');
      cmd.push(String(args.name));
      cmd.push(...optInt(args.timeout, '--timeout', 'timeout'));
      return textResult(await runCmux(cmd));
    }
    case "set_app_focus":
      return textResult(await runCmux(['set-app-focus', oneOf(args.state, ['active', 'inactive', 'clear'], 'state')]));
    case "markdown_open":
      return textResult(await runCmux(['markdown', 'open', String(args.path)]));
    case "version": return textResult(await runCmux(['version']));
    case "ping": return textResult(await runCmux(['ping']));

    // === Browser ===
    case "browser": {
      const subcommand = String(args.subcommand);
      if (!/^[a-z][a-z-]*$/i.test(subcommand)) {
        throw new Error(`Invalid browser subcommand: ${JSON.stringify(subcommand)}`);
      }
      const cmd = ['browser', ...optRef(args.surface, '--surface', 'surface'), subcommand];
      if (Array.isArray(args.args)) {
        cmd.push(...args.args.map(String));
      } else if (args.args !== undefined && args.args !== null && args.args !== '') {
        cmd.push(...String(args.args).split(/\s+/).filter(Boolean));
      }
      return textResult(await runCmux(cmd));
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args: ToolArgs = request.params.arguments || {};
  try {
    return await handleToolCall(request.params.name, args);
  } catch (error: unknown) {
    return {
      content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
