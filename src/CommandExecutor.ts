import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openSync, closeSync } from 'node:fs';
import ProcessTracker from './ProcessTracker.js';
import TtyOutputReader from './TtyOutputReader.js';
import { CMUX_BIN } from './cmux-path.js';

const execPromise = promisify(exec);
const execFilePromise = promisify(execFile);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type ExecFileFn = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

// TTY path cache — path rarely changes during a session
let cachedTtyPath: string | null = null;
let ttyPathCacheTime = 0;
const TTY_CACHE_TTL_MS = 60_000; // 1 minute

class CommandExecutor {
  private _execFile: ExecFileFn;
  private _surface?: string;

  constructor(execFileOverride?: ExecFileFn, surface?: string) {
    this._execFile = execFileOverride || execFilePromise;
    this._surface = surface;
  }

  async executeCommand(command: string): Promise<string> {
    try {
      const textToSend = command + '\n';
      const args = ['send'];
      if (this._surface) args.push('--surface', this._surface);
      args.push('--', textToSend);
      // execFile: the text is passed as a single argv entry, never through a shell
      await this._execFile(CMUX_BIN, args);

      const ttyPath = await this.retrieveTtyPath();
      await this.waitForCommandCompletion(ttyPath);

      const afterCommandBuffer = await TtyOutputReader.retrieveBuffer(this._surface);
      return afterCommandBuffer;
    } catch (error: unknown) {
      throw new Error(`Failed to execute command: ${(error as Error).message}`);
    }
  }

  /**
   * Wait until the command finishes by polling CPU usage.
   * Uses shorter intervals and lower threshold for faster response.
   */
  private async waitForCommandCompletion(ttyPath: string): Promise<void> {
    let fd;
    try {
      fd = openSync(ttyPath, 'r');
      const tracker = new ProcessTracker();
      let belowThresholdTime = 0;
      const POLL_INTERVAL_MS = 150;
      const IDLE_THRESHOLD_MS = 500;

      while (true) {
        try {
          const activeProcess = await tracker.getActiveProcess(ttyPath);

          if (!activeProcess) return;

          if (activeProcess.metrics.totalCPUPercent < 1) {
            belowThresholdTime += POLL_INTERVAL_MS;
            if (belowThresholdTime >= IDLE_THRESHOLD_MS) return;
          } else {
            belowThresholdTime = 0;
          }
        } catch {
          return;
        }

        await sleep(POLL_INTERVAL_MS);
      }
    } catch {
      return;
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
      }
    }
  }

  private async retrieveTtyPath(): Promise<string> {
    // Return cached path if still fresh
    if (cachedTtyPath && (Date.now() - ttyPathCacheTime) < TTY_CACHE_TTL_MS) {
      return cachedTtyPath;
    }

    try {
      // Fixed pipeline, no user input — safe to run through a shell
      const { stdout } = await execPromise(
        `lsof -c cmux 2>/dev/null | grep /dev/ttys | awk '{print $9}' | sort -u | head -1 || lsof -p $(pgrep -f 'cmux.app/Contents/MacOS/cmux' | head -1) 2>/dev/null | grep /dev/ttys | awk '{print $9}' | sort -u | head -1`
      );
      const tty = stdout.trim();
      if (!tty) {
        const { stdout: psTty } = await execPromise(
          `ps -eo tty,lstart,comm | grep -E '(bash|zsh|sh|fish)$' | grep -v grep | sort -k2 | tail -1 | awk '{print "/dev/" $1}'`
        );
        const fallbackTty = psTty.trim();
        if (!fallbackTty || fallbackTty === '/dev/') {
          throw new Error('Could not find TTY for cmux terminal');
        }
        cachedTtyPath = fallbackTty;
        ttyPathCacheTime = Date.now();
        return fallbackTty;
      }
      cachedTtyPath = tty;
      ttyPathCacheTime = Date.now();
      return tty;
    } catch (error: unknown) {
      throw new Error(`Failed to retrieve TTY path: ${(error as Error).message}`);
    }
  }
}

export default CommandExecutor;
