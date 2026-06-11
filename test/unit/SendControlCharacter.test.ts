// @ts-nocheck
import { jest, describe, expect, test, beforeEach } from '@jest/globals';
import SendControlCharacter from '../../src/SendControlCharacter.js';
import { CMUX_BIN } from '../../src/cmux-path.js';

// Create a mock subclass that overrides the executeCommand method
class MockSendControlCharacter extends SendControlCharacter {
  mockExecuteCommand = jest.fn();

  protected async executeCommand(file: string, args: string[]): Promise<void> {
    this.mockExecuteCommand(file, args);
    return Promise.resolve();
  }
}

describe('SendControlCharacter', () => {
  let sendControlCharacter: MockSendControlCharacter;

  beforeEach(() => {
    sendControlCharacter = new MockSendControlCharacter();
    sendControlCharacter.mockExecuteCommand.mockClear();
  });

  test('should send standard control character (Ctrl+C)', async () => {
    await sendControlCharacter.send('C');

    expect(sendControlCharacter.mockExecuteCommand).toHaveBeenCalledWith(
      CMUX_BIN, ['send-key', 'ctrl+c']
    );
  });

  test('should handle lowercase letters correctly', async () => {
    await sendControlCharacter.send('c');

    expect(sendControlCharacter.mockExecuteCommand).toHaveBeenCalledWith(
      CMUX_BIN, ['send-key', 'ctrl+c']
    );
  });

  test('should handle telnet escape character (Ctrl+]) as a raw GS byte', async () => {
    await sendControlCharacter.send(']');

    // Group Separator (GS) is ASCII 29 / 0x1d, sent as a literal byte
    expect(sendControlCharacter.mockExecuteCommand).toHaveBeenCalledWith(
      CMUX_BIN, ['send', '--', '\x1d']
    );
  });

  test('should handle escape key', async () => {
    await sendControlCharacter.send('ESC');
    expect(sendControlCharacter.mockExecuteCommand).toHaveBeenCalledWith(
      CMUX_BIN, ['send-key', 'escape']
    );

    await sendControlCharacter.send('escape');
    expect(sendControlCharacter.mockExecuteCommand).toHaveBeenCalledWith(
      CMUX_BIN, ['send-key', 'escape']
    );
  });

  test('should target a specific surface when provided', async () => {
    const surfaceSender = new MockSendControlCharacter('surface:2');
    await surfaceSender.send('C');

    expect(surfaceSender.mockExecuteCommand).toHaveBeenCalledWith(
      CMUX_BIN, ['send-key', '--surface', 'surface:2', 'ctrl+c']
    );
  });

  test('should throw an error for invalid control characters', async () => {
    await expect(sendControlCharacter.send('123')).rejects.toThrow(
      'Invalid control character letter'
    );
  });

  test('should throw an error when execution fails', async () => {
    sendControlCharacter.mockExecuteCommand.mockImplementation(() => {
      throw new Error('Command execution failed');
    });

    await expect(sendControlCharacter.send('C')).rejects.toThrow(
      'Failed to send control character: Command execution failed'
    );
  });
});
