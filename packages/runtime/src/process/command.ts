// Runs a local command from the profile, such as a cache flush or a log reader.
// Commands are argument lists and never go through a shell, so nothing in
// them is expanded or interpreted (design §11, ADR-0009).

import { execFile } from 'node:child_process';

export interface CommandOptions {
  readonly timeoutMs: number;
  /** Relative program paths and arguments resolve against this directory. */
  readonly cwd?: string | undefined;
  readonly maxOutputBytes?: number;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export type CommandErrorKind = 'not-found' | 'timeout' | 'too-large' | 'failed';

export class CommandError extends Error {
  override readonly name = 'CommandError';
  readonly kind: CommandErrorKind;

  constructor(kind: CommandErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

interface ExecError extends Error {
  code?: string | number | null;
  killed?: boolean;
}

function describe(argv: readonly string[]): string {
  return argv.map((part) => (/^[\w./:=@-]+$/u.test(part) ? part : JSON.stringify(part))).join(' ');
}

/** Runs the command and returns its output; a non-zero exit code is returned, not thrown. */
export function runCommand(
  argv: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const [program, ...args] = argv;
  if (program === undefined) return Promise.reject(new CommandError('failed', 'empty command'));
  const started = performance.now();
  return new Promise((resolve, reject) => {
    execFile(
      program,
      args,
      {
        shell: false,
        timeout: options.timeoutMs,
        maxBuffer: options.maxOutputBytes ?? 16 * 1024 * 1024,
        windowsHide: true,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      },
      (error: ExecError | null, stdout: string, stderr: string) => {
        const durationMs = performance.now() - started;
        if (error === null) {
          resolve({ exitCode: 0, stdout, stderr, durationMs });
          return;
        }
        if (error.code === 'ENOENT') {
          reject(new CommandError('not-found', `command not found: ${program}`));
        } else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reject(new CommandError('too-large', `output of "${describe(argv)}" exceeds the limit`));
        } else if (error.killed === true) {
          reject(
            new CommandError(
              'timeout',
              `"${describe(argv)}" did not finish within ${String(options.timeoutMs)} ms`,
            ),
          );
        } else if (typeof error.code === 'number') {
          resolve({ exitCode: error.code, stdout, stderr, durationMs });
        } else {
          reject(new CommandError('failed', `"${describe(argv)}" failed: ${error.message}`));
        }
      },
    );
  });
}

/** Runs the command and fails unless it exits with 0. */
export async function runCommandOrFail(
  argv: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const result = await runCommand(argv, options);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().split('\n').slice(-3).join(' | ');
    throw new CommandError(
      'failed',
      `"${describe(argv)}" exited with ${String(result.exitCode)}${detail === '' ? '' : `: ${detail}`}`,
    );
  }
  return result;
}
