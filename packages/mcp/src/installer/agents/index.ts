/**
 * Agent adapter registry.
 *
 * Central place the CLI reaches for when resolving an `<agent>` argument.
 * Keeps ordering stable so `--help` / `doctor` printouts match the order the
 * installer was shipped with.
 */

import type { AgentAdapter, AgentId } from '../types';
import { ClaudeCodeAdapter } from './claude-code';
import { CursorAdapter } from './cursor';
import { AiderAdapter } from './aider';
import { CodexAdapter } from './codex';
import { GeminiCliAdapter } from './gemini-cli';

export const AGENT_IDS: AgentId[] = [
  'claude-code',
  'cursor',
  'aider',
  'codex',
  'gemini-cli',
];

export function makeAdapter(id: AgentId, homeDir?: string): AgentAdapter {
  switch (id) {
    case 'claude-code':
      return new ClaudeCodeAdapter(homeDir);
    case 'cursor':
      return new CursorAdapter(homeDir);
    case 'aider':
      return new AiderAdapter(homeDir);
    case 'codex':
      return new CodexAdapter(homeDir);
    case 'gemini-cli':
      return new GeminiCliAdapter(homeDir);
  }
}

export function isAgentId(s: string): s is AgentId {
  return (AGENT_IDS as string[]).includes(s);
}

export {
  ClaudeCodeAdapter,
  CursorAdapter,
  AiderAdapter,
  CodexAdapter,
  GeminiCliAdapter,
};
