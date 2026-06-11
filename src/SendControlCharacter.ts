import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { CMUX_BIN } from './cmux-path.js';

const execFilePromise = promisify(execFile);

class SendControlCharacter {
  private _surface?: string;

  constructor(surface?: string) {
    this._surface = surface;
  }

  protected async executeCommand(file: string, args: string[]): Promise<void> {
    await execFilePromise(file, args);
  }

  async send(letter: string): Promise<void> {
    let keyName: string;
    const surfaceArgs = this._surface ? ['--surface', this._surface] : [];

    // Handle special cases
    if (letter.toUpperCase() === ']') {
      // Telnet escape (GS, ASCII 29) has no named key — send the raw byte
      await this.executeCommand(CMUX_BIN, ['send', ...surfaceArgs, '--', '\x1d']);
      return;
    }
    else if (letter.toUpperCase() === 'ESCAPE' || letter.toUpperCase() === 'ESC') {
      keyName = 'escape';
    }
    else {
      letter = letter.toUpperCase();
      if (!/^[A-Z]$/.test(letter)) {
        throw new Error('Invalid control character letter');
      }
      keyName = `ctrl+${letter.toLowerCase()}`;
    }

    try {
      await this.executeCommand(CMUX_BIN, ['send-key', ...surfaceArgs, keyName]);
    } catch (error: unknown) {
      throw new Error(`Failed to send control character: ${(error as Error).message}`);
    }
  }
}

export default SendControlCharacter;
