/**
 * Phase 10 A5 — integration test runner.
 *
 * Integration tests live under `src/scenarios/*.spec.ts` and drive a
 * test-mode coderover-api backend over the real @coderover/mcp transport.
 *
 * Runs serially (maxWorkers: 1) because each scenario boots its own Nest
 * HTTP app on a random port and shares module-level in-memory state.
 */
import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testRegex: 'src/scenarios/.*\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  maxWorkers: 1,
  // Integration suites can legitimately take a while when the Nest
  // container is warming up. 30s keeps flake caused by cold-start noise
  // inside the test itself rather than a global Jest timeout.
  testTimeout: 30_000,
};

export default config;
