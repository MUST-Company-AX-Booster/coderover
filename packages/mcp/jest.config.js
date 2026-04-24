/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testRegex: '\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  collectCoverageFrom: ['src/**/*.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  // maxWorkers: 1 — tree-sitter's native binding has process-wide state and
  // its Parser class is not reentrant. Concurrent workers racing to load
  // the binding produce flaky failures. All tree-sitter-using specs share
  // test/helpers/tree-sitter-singleton.ts so they reuse one Parser.
  maxWorkers: 1,
};
