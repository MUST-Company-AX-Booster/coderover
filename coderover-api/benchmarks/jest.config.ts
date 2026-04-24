/**
 * Phase 10 C5 — scoped jest config for benchmark harness utilities.
 *
 * Targeted so the benchmarks directory can be tested without touching
 * the main `src/` jest config (which lives inline in package.json).
 *
 *   npm run test:bench-harness
 */
import type { Config } from 'jest';

const config: Config = {
  rootDir: './',
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { isolatedModules: true }],
  },
  testEnvironment: 'node',
  maxWorkers: 1,
};

export default config;
