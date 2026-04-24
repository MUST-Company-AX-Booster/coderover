/**
 * Arg parser tests. Small, direct — each branch of the hand-rolled parser.
 */

import {
  parseArgs,
  ArgParseError,
  INSTALL_FLAGS,
  DOCTOR_FLAGS,
  GLOBAL_FLAGS,
} from '../../src/cli/args';

describe('parseArgs', () => {
  it('splits command and positionals', () => {
    const r = parseArgs(['install', 'claude-code', 'cursor'], INSTALL_FLAGS);
    expect(r.command).toBe('install');
    expect(r.positional).toEqual(['claude-code', 'cursor']);
  });

  it('accepts --key=value form', () => {
    const r = parseArgs(
      ['install', 'claude-code', '--api-url=https://x'],
      INSTALL_FLAGS,
    );
    expect(r.flags['api-url']).toBe('https://x');
  });

  it('accepts --key value form', () => {
    const r = parseArgs(
      ['install', 'claude-code', '--api-url', 'https://x'],
      INSTALL_FLAGS,
    );
    expect(r.flags['api-url']).toBe('https://x');
  });

  it('treats boolean flags as true', () => {
    const r = parseArgs(
      ['install', 'claude-code', '--dry-run'],
      INSTALL_FLAGS,
    );
    expect(r.flags['dry-run']).toBe(true);
  });

  it('rejects value passed to boolean flag', () => {
    expect(() =>
      parseArgs(['install', '--dry-run=yes'], INSTALL_FLAGS),
    ).toThrow(ArgParseError);
  });

  it('rejects unknown flags', () => {
    expect(() =>
      parseArgs(['install', '--nuke-everything'], INSTALL_FLAGS),
    ).toThrow(/unknown flag/);
  });

  it('parses short alias -h as help', () => {
    const r = parseArgs(['-h'], GLOBAL_FLAGS);
    expect(r.flags.help).toBe(true);
  });

  it('-- separator sends rest into positional', () => {
    const r = parseArgs(
      ['install', '--', 'claude-code', '--not-a-flag'],
      INSTALL_FLAGS,
    );
    expect(r.positional).toEqual(['claude-code', '--not-a-flag']);
  });

  it('doctor flags accept optional agent positional + --token', () => {
    const r = parseArgs(
      ['doctor', 'claude-code', '--token', 'abc'],
      DOCTOR_FLAGS,
    );
    expect(r.command).toBe('doctor');
    expect(r.positional).toEqual(['claude-code']);
    expect(r.flags.token).toBe('abc');
  });
});
