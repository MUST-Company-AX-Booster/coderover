/**
 * TTY prompts.
 *
 * Uses `readline` directly so we skip the inquirer/prompts/enquirer dep
 * zoo. Every prompt must have a non-TTY fallback — CI runs with stdin
 * piped, and silently hanging on a prompt is a top CLI pet-peeve.
 */

import * as readline from 'readline';

export interface PromptIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  isTTY: boolean;
}

export function stdPromptIo(): PromptIo {
  const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
  const stderr = process.stderr as NodeJS.WriteStream & { isTTY?: boolean };
  return {
    input: stdin,
    output: stderr, // prompts go to stderr so piped stdout stays clean
    isTTY: Boolean(stdin.isTTY && stderr.isTTY),
  };
}

/**
 * Ask a free-form question. Returns the trimmed answer. If NOT a TTY, throws
 * — callers must check `io.isTTY` first OR supply a default via a flag.
 */
export async function askLine(io: PromptIo, question: string): Promise<string> {
  if (!io.isTTY) {
    throw new Error(`cannot prompt ("${question}") in non-interactive mode`);
  }
  const rl = readline.createInterface({
    input: io.input,
    output: io.output as NodeJS.WritableStream,
    terminal: false,
  });
  try {
    const answer: string = await new Promise((resolve) => {
      io.output.write(question);
      rl.once('line', (line: string) => resolve(line));
    });
    return answer.trim();
  } finally {
    rl.close();
  }
}

/**
 * Yes/no prompt. Defaults to `defaultYes` when the user just hits Enter.
 * Non-TTY → returns the default without printing.
 */
export async function askYesNo(
  io: PromptIo,
  question: string,
  defaultYes: boolean,
): Promise<boolean> {
  if (!io.isTTY) return defaultYes;
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const raw = (await askLine(io, question + suffix)).toLowerCase();
  if (raw === '') return defaultYes;
  return raw === 'y' || raw === 'yes';
}
