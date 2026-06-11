import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { CMUX_BIN } from './cmux-path.js';

const execFilePromise = promisify(execFile);

export default class TtyOutputReader {
  static async call(linesOfOutput?: number, surface?: string) {
    if (linesOfOutput) {
      const args = ['read-screen', '--lines', String(linesOfOutput)];
      if (surface) args.push('--surface', surface);
      const { stdout } = await execFilePromise(CMUX_BIN, args);
      return stdout.trimEnd();
    }
    return this.retrieveBuffer(surface);
  }

  static async retrieveBuffer(surface?: string): Promise<string> {
    try {
      const args = ['read-screen', '--scrollback'];
      if (surface) args.push('--surface', surface);
      const { stdout } = await execFilePromise(CMUX_BIN, args);
      return stdout.trimEnd();
    } catch (error: unknown) {
      throw new Error(`Failed to read terminal: ${(error as Error).message}`);
    }
  }
}
