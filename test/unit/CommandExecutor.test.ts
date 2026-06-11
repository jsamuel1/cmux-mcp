// @ts-nocheck
const mockExecPromiseFn = jest.fn();

jest.mock('node:util', () => ({
  promisify: jest.fn().mockReturnValue(mockExecPromiseFn)
}));
jest.mock('node:child_process', () => ({
  exec: jest.fn(),
  execFile: jest.fn()
}));
jest.mock('../../src/TtyOutputReader.js', () => ({
  __esModule: true,
  default: {
    retrieveBuffer: jest.fn().mockResolvedValue('Mocked terminal output')
  }
}));
jest.mock('node:fs', () => ({
  openSync: jest.fn().mockReturnValue(1),
  closeSync: jest.fn(),
  existsSync: jest.fn().mockReturnValue(true)
}));

import { jest, describe, expect, test, beforeEach } from '@jest/globals';
import { CMUX_BIN } from '../../src/cmux-path.js';

// Use dynamic import for ESM compatibility and to ensure mocks are in place

describe('CommandExecutor', () => {
  let CommandExecutor;
  let commandExecutor;
  let TtyOutputReader;
  let mockExecFileFn;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Dynamically import after mocks
    CommandExecutor = (await import('../../src/CommandExecutor.js')).default;
    TtyOutputReader = (await import('../../src/TtyOutputReader.js')).default;
    jest.spyOn(TtyOutputReader, 'retrieveBuffer').mockResolvedValue('Mocked terminal output');

    // Module-level promisify'd functions (TTY discovery, ProcessTracker ps calls)
    mockExecPromiseFn.mockImplementation((commandOrFile) => {
      if (typeof commandOrFile === 'string' && commandOrFile.includes('lsof')) {
        return Promise.resolve({ stdout: '/dev/ttys000\n', stderr: '' });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    // Injected execFile used for the cmux send call
    mockExecFileFn = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
    commandExecutor = new CommandExecutor(mockExecFileFn);
  });

  test('executeCommand sends the command via cmux send with argv array', async () => {
    await commandExecutor.executeCommand('echo "Hello World"');

    expect(mockExecFileFn).toHaveBeenCalledWith(
      CMUX_BIN,
      ['send', '--', 'echo "Hello World"\n']
    );
  });

  test('executeCommand appends a newline so the command actually runs', async () => {
    await commandExecutor.executeCommand('ls');

    const [, args] = mockExecFileFn.mock.calls[0];
    expect(args[args.length - 1]).toBe('ls\n');
  });

  test('executeCommand targets a specific surface when provided', async () => {
    const surfaceExecutor = new CommandExecutor(mockExecFileFn, 'surface:3');
    await surfaceExecutor.executeCommand('pwd');

    expect(mockExecFileFn).toHaveBeenCalledWith(
      CMUX_BIN,
      ['send', '--surface', 'surface:3', '--', 'pwd\n']
    );
  });

  test('shell metacharacters are passed through verbatim as a single argv entry', async () => {
    const tricky = `echo 'a'; rm -rf / && $(whoami) | cat \`date\``;
    await commandExecutor.executeCommand(tricky);

    const [, args] = mockExecFileFn.mock.calls[0];
    // The full text is one argv element after '--', untouched by any escaping
    expect(args).toEqual(['send', '--', tricky + '\n']);
  });

  test('unicode characters are passed through unchanged', async () => {
    const unicodeCommand = 'echo 🚀 café 中文 🎯';
    await commandExecutor.executeCommand(unicodeCommand);

    const [, args] = mockExecFileFn.mock.calls[0];
    expect(args[args.length - 1]).toBe(unicodeCommand + '\n');
  });

  test('executeCommand returns the terminal buffer after completion', async () => {
    const result = await commandExecutor.executeCommand('ls');
    expect(result).toBe('Mocked terminal output');
  });

  test('executeCommand wraps failures with context', async () => {
    mockExecFileFn.mockRejectedValue(new Error('socket not found'));

    await expect(commandExecutor.executeCommand('ls')).rejects.toThrow(
      'Failed to execute command: socket not found'
    );
  });
});
