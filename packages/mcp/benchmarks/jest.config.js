/**
 * Phase 11 Wave 3 L15 — scoped jest config for benchmark harness utilities.
 *
 * Plain JS so jest doesn't need ts-node to read the config file. Only picks
 * up `*.spec.ts` — the `*.bench.ts` files are runnable scripts, not tests.
 */
/** @type {import('jest').Config} */
module.exports = {
  rootDir: './',
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { isolatedModules: true }],
  },
  testEnvironment: 'node',
  maxWorkers: 1,
};
