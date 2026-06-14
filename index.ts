/**
 * Open $EDITOR in a tmux split, with pi prompt allowing
 * to see the context while editing.
 */
import { spawn } from "node:child_process";
import { appendFile, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAgentDir, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const INDICATOR_KEY = "split-editor";
const DEBUG_LOG = join(tmpdir(), "split-editor-input.log");

/** Common raw encodings of Ctrl+G across extended-keys modes. */
const DEFAULT_TRIGGER_SEQUENCES = ["\x07", "\x1b[103;5u", "\x1b[27;5;103~"];

const DEFAULT_CONFIG: SplitEditorConfig = {
  editor: "nvim",
  size: "50%",
  direction: "h",
  showIndicator: true,
  triggerSequences: DEFAULT_TRIGGER_SEQUENCES,
  debugInput: false,
};

type ProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
};

type SessionState = {
  active: boolean;
  editing: boolean;
  opening: boolean;
  showIndicator: boolean;
};

type SplitEditorConfig = {
  editor: string;
  size: string;
  direction: string;
  showIndicator: boolean;
  triggerSequences: string[];
  debugInput: boolean;
};

type RawConfig = Partial<SplitEditorConfig> & {
  splitEditor?: Partial<SplitEditorConfig>;
};

async function openSplitEditor(ui: ExtensionUIContext, cwd: string, state: SessionState): Promise<void> {
  if (!process.env.TMUX) return; // handler already guards; stay safe.
  if (state.editing || state.opening) {
    ui.notify("split editor is already open", "warning");
    return;
  }

  state.opening = true;
  const suffix = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const tempFile = join(tmpdir(), `split-editor-${suffix}.md`);
  const statusFile = join(tmpdir(), `split-editor-${suffix}.status`);
  const token = `split-editor-${suffix}`;

  try {
    const config = await loadConfig(cwd);
    state.showIndicator = config.showIndicator;
    state.editing = true;
    state.opening = false;
    if (state.showIndicator) {
      ui.setWidget(INDICATOR_KEY, [" SPLIT EDITOR OPEN "], { placement: "aboveEditor" });
    }
    // Public-API equivalent of the old CustomEditor.getExpandedText(): the
    // current prompt text. Round-tripped verbatim through the temp file.
    await writeFile(tempFile, ui.getEditorText(), "utf8");

    await openTmuxSplitAndWait({
      tempFile,
      statusFile,
      token,
      editorCommand: config.editor,
      splitSize: config.size,
      splitDirection: config.direction,
    });

    const status = await readOptional(statusFile);
    if (status === undefined) {
      ui.notify("split editor pane closed without reporting editor status; reading temp file anyway", "warning");
    } else {
      const code = Number.parseInt(status.trim(), 10);
      if (Number.isFinite(code) && code !== 0) {
        ui.notify(`split editor exited with status ${code}; reading temp file anyway`, "warning");
      }
    }

    const newText = (await readFile(tempFile, "utf8")).replace(/\n$/, "");
    if (state.active) {
      ui.setEditorText(newText);
    }
  } catch (error) {
    ui.notify(`split-editor: ${formatError(error)}`, "error");
  } finally {
    state.editing = false;
    state.opening = false;
    ui.setWidget(INDICATOR_KEY, undefined);
    await Promise.allSettled([unlink(tempFile), unlink(statusFile)]);
  }
}

async function openTmuxSplitAndWait(options: {
  tempFile: string;
  statusFile: string;
  token: string;
  editorCommand: string;
  splitSize: string;
  splitDirection: string;
}): Promise<void> {
  const wait = startProcess("tmux", ["wait-for", options.token]);
  const waitPromise = wait.promise.catch((error: unknown) => ({
    code: 1,
    signal: null,
    stderr: formatError(error),
  }));

  const paneCommand = buildPaneCommand(options.editorCommand, options.tempFile, options.statusFile, options.token);
  const splitArgs = ["split-window", splitFlag(options.splitDirection), "-l", options.splitSize, paneCommand];

  try {
    const splitResult = await runProcess("tmux", splitArgs);
    if (splitResult.code !== 0) {
      wait.child.kill();
      throw new Error(`tmux split-window failed${formatProcessDetails(splitResult)}`);
    }
  } catch (error) {
    wait.child.kill();
    await waitPromise.catch(() => undefined);
    throw error;
  }

  const waitResult = await waitPromise;
  if (waitResult.code !== 0) {
    throw new Error(`tmux wait-for failed${formatProcessDetails(waitResult)}`);
  }
}

async function loadConfig(cwd: string): Promise<SplitEditorConfig> {
  const globalConfig = normalizeRawConfig(await readJsonFile(join(getAgentDir(), "extensions", "split-editor.json")));
  const projectConfig = normalizeRawConfig(await readJsonFile(join(cwd, ".pi", "split-editor.json")));
  const globalSettings = normalizeRawConfig(await readJsonFile(join(getAgentDir(), "settings.json")));
  const projectSettings = normalizeRawConfig(await readJsonFile(join(cwd, ".pi", "settings.json")));
  const envConfig = normalizeRawConfig({
    editor: process.env.SPLIT_EDITOR_EDITOR,
    size: process.env.SPLIT_EDITOR_SIZE,
    direction: process.env.SPLIT_EDITOR_DIRECTION,
    showIndicator: parseEnvBoolean(process.env.SPLIT_EDITOR_SHOW_INDICATOR),
    debugInput: parseEnvBoolean(process.env.SPLIT_EDITOR_DEBUG_INPUT),
  });

  return {
    ...DEFAULT_CONFIG,
    ...globalConfig,
    ...globalSettings,
    ...projectConfig,
    ...projectSettings,
    ...envConfig,
  };
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function normalizeRawConfig(raw: unknown): Partial<SplitEditorConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record = raw as RawConfig;
  const source = record.splitEditor && typeof record.splitEditor === "object" ? record.splitEditor : record;
  const config: Partial<SplitEditorConfig> = {};

  if (typeof source.editor === "string" && source.editor.trim()) config.editor = source.editor.trim();
  if (typeof source.size === "string" && source.size.trim()) config.size = source.size.trim();
  if (typeof source.direction === "string" && source.direction.trim()) config.direction = source.direction.trim();
  if (typeof source.showIndicator === "boolean") config.showIndicator = source.showIndicator;
  if (Array.isArray(source.triggerSequences) && source.triggerSequences.every((s) => typeof s === "string" && s.length > 0)) {
    config.triggerSequences = source.triggerSequences as string[];
  }
  if (typeof source.debugInput === "boolean") config.debugInput = source.debugInput;

  return config;
}

function parseEnvBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function buildPaneCommand(editorCommand: string, tempFile: string, statusFile: string, token: string): string {
  const signalCommand = `tmux wait-for -S ${shellQuote(token)}`;
  return [
    `trap ${shellQuote(signalCommand)} EXIT`,
    `${editorCommand} ${shellQuote(tempFile)}`,
    `printf '%s' "$?" > ${shellQuote(statusFile)}`,
  ].join("; ");
}

function splitFlag(direction: string): "-h" | "-v" {
  const normalized = direction.toLowerCase();
  return normalized === "v" || normalized === "vertical" ? "-v" : "-h";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function startProcess(command: string, args: string[]): { child: ReturnType<typeof spawn>; promise: Promise<ProcessResult> } {
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
  const promise = childResult(child);
  return { child, promise };
}

function runProcess(command: string, args: string[]): Promise<ProcessResult> {
  return startProcess(command, args).promise;
}

function childResult(child: ReturnType<typeof spawn>): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    let settled = false;

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk.toString("utf8"));
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal, stderr });
    });
  });
}

function appendLimited(current: string, next: string, maxLength = 8192): string {
  const combined = current + next;
  return combined.length > maxLength ? combined.slice(combined.length - maxLength) : combined;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function formatProcessDetails(result: ProcessResult): string {
  const parts: string[] = [];
  if (result.code !== null) parts.push(`exit ${result.code}`);
  if (result.signal) parts.push(`signal ${result.signal}`);
  const status = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  const stderr = result.stderr.trim();
  return stderr ? `${status}: ${stderr}` : status;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
  const state: SessionState = {
    active: false,
    editing: false,
    opening: false,
    showIndicator: DEFAULT_CONFIG.showIndicator,
  };
  let unsubscribe: (() => void) | undefined;
  let triggers = DEFAULT_TRIGGER_SEQUENCES;
  let debug = DEFAULT_CONFIG.debugInput;

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    state.active = true;
    const ui = ctx.ui;
    const cwd = ctx.cwd;

    // Load trigger/debug/indicator settings once per session. The open path
    // re-reads config so live edits to editor/size/direction are still honored.
    void loadConfig(cwd).then((config) => {
      triggers = config.triggerSequences.length > 0 ? config.triggerSequences : DEFAULT_TRIGGER_SEQUENCES;
      debug = config.debugInput;
      state.showIndicator = config.showIndicator;
    });

    unsubscribe?.();
    unsubscribe = ui.onTerminalInput((data) => {
      if (debug) void appendFile(DEBUG_LOG, `${JSON.stringify(data)}\n`).catch(() => undefined);

      // While the split owns the editable copy, lock the prompt so it can't
      // be mutated in two places at once.
      if (state.editing || state.opening) {
        return { consume: true };
      }

      if (triggers.includes(data)) {
        if (!process.env.TMUX) {
          ui.notify("tmux not detected; falling back to pi's external editor. Start tmux for split editing.", "warning");
          return undefined; // don't consume -> pi's built-in (blocking) external editor handles it
        }
        void openSplitEditor(ui, cwd, state);
        return { consume: true };
      }

      return undefined;
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    state.active = false;
    state.editing = false;
    state.opening = false;
    unsubscribe?.();
    unsubscribe = undefined;
    if (ctx.hasUI) ctx.ui.setWidget(INDICATOR_KEY, undefined);
  });
}
