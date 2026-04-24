#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');

function parseArgs(argv) {
  const command = argv[2] || 'help';
  const flags = {};
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      flags[key] = value;
    }
  }
  return { command, flags };
}

function detectFramework(projectPath) {
  const checks = [
    {
      framework: 'nextjs',
      match: () =>
        fs.existsSync(path.join(projectPath, 'next.config.js')) ||
        fs.existsSync(path.join(projectPath, 'next.config.mjs')) ||
        fs.existsSync(path.join(projectPath, 'next.config.ts')),
    },
    {
      framework: 'nestjs',
      match: () =>
        fs.existsSync(path.join(projectPath, 'nest-cli.json')) ||
        fs.existsSync(path.join(projectPath, 'src', 'main.ts')),
    },
    {
      framework: 'vite-react',
      match: () =>
        fs.existsSync(path.join(projectPath, 'vite.config.ts')) &&
        (fs.existsSync(path.join(projectPath, 'src', 'App.tsx')) ||
          fs.existsSync(path.join(projectPath, 'src', 'main.tsx'))),
    },
    {
      framework: 'vite-vue',
      match: () =>
        fs.existsSync(path.join(projectPath, 'vite.config.ts')) &&
        (fs.existsSync(path.join(projectPath, 'src', 'App.vue')) ||
          fs.existsSync(path.join(projectPath, 'src', 'main.js'))),
    },
    {
      framework: 'django',
      match: () =>
        fs.existsSync(path.join(projectPath, 'manage.py')) &&
        fs.existsSync(path.join(projectPath, 'requirements.txt')),
    },
    {
      framework: 'fastapi',
      match: () =>
        fs.existsSync(path.join(projectPath, 'main.py')) ||
        fs.existsSync(path.join(projectPath, 'app', 'main.py')),
    },
  ];

  const found = checks.find((item) => item.match());
  return found ? found.framework : 'unknown';
}

function inferDefaultRepoFromGit(projectPath) {
  const gitConfigPath = path.join(projectPath, '.git', 'config');
  if (!fs.existsSync(gitConfigPath)) return 'demo/codebase';

  const content = fs.readFileSync(gitConfigPath, 'utf8');
  const match = content.match(/url\s*=\s*.+github\.com[:/](.+?)\.git/);
  return match?.[1] || 'demo/codebase';
}

function toEnvContent(values) {
  return [
    `PORT=${values.port}`,
    'NODE_ENV=development',
    '',
    `DATABASE_HOST=${values.dbHost}`,
    `DATABASE_PORT=${values.dbPort}`,
    `DATABASE_NAME=${values.dbName}`,
    `DATABASE_USER=${values.dbUser}`,
    `DATABASE_PASSWORD=${values.dbPassword}`,
    '',
    `REDIS_HOST=${values.redisHost}`,
    `REDIS_PORT=${values.redisPort}`,
    '',
    `OPENAI_API_KEY=${values.openAiApiKey}`,
    `OPENAI_BASE_URL=${values.openAiBaseUrl}`,
    `OPENAI_CHAT_MODEL=${values.chatModel}`,
    `OPENAI_EMBEDDING_MODEL=${values.embeddingModel}`,
    `OPENAI_EMBEDDING_DIMENSIONS=${values.embeddingDimensions}`,
    `LLM_PROVIDER=${values.llmProvider}`,
    '',
    `GITHUB_TOKEN=${values.githubToken}`,
    `JWT_SECRET=${values.jwtSecret}`,
    'JWT_EXPIRES_IN=7d',
    '',
    `FILE_WATCH_ENABLED=${values.fileWatchEnabled}`,
    '',
    `DETECTED_FRAMEWORK=${values.detectedFramework}`,
    '',
  ].join('\n');
}

function getPromptDefaults(projectPath) {
  return {
    port: '3001',
    dbHost: 'localhost',
    dbPort: '5434',
    dbName: 'coderover',
    dbUser: 'postgres',
    dbPassword: 'postgres',
    redisHost: 'localhost',
    redisPort: '6380',
    openAiApiKey: 'local-testing',
    openAiBaseUrl: '',
    llmProvider: 'local',
    chatModel: '',
    embeddingModel: 'text-embedding-3-large',
    embeddingDimensions: '1536',
    githubToken: '',
    jwtSecret: crypto.randomBytes(24).toString('hex'),
    defaultRepo: inferDefaultRepoFromGit(projectPath),
    fileWatchEnabled: 'true',
    detectedFramework: detectFramework(projectPath),
  };
}

async function promptForEnv(projectPath) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const defaults = getPromptDefaults(projectPath);
  const ask = async (label, key) => {
    const answer = await rl.question(`${label} [${defaults[key]}]: `);
    return answer.trim() || defaults[key];
  };

  const values = {
    port: await ask('Port', 'port'),
    dbHost: await ask('Database host', 'dbHost'),
    dbPort: await ask('Database port', 'dbPort'),
    dbName: await ask('Database name', 'dbName'),
    dbUser: await ask('Database user', 'dbUser'),
    dbPassword: await ask('Database password', 'dbPassword'),
    redisHost: await ask('Redis host', 'redisHost'),
    redisPort: await ask('Redis port', 'redisPort'),
    llmProvider: await ask('LLM provider (auto/openai/openrouter/local)', 'llmProvider'),
    openAiApiKey: await ask('OpenAI API key', 'openAiApiKey'),
    openAiBaseUrl: await ask('OpenAI base URL', 'openAiBaseUrl'),
    chatModel: await ask('OpenAI chat model', 'chatModel'),
    embeddingModel: await ask('OpenAI embedding model', 'embeddingModel'),
    embeddingDimensions: await ask('Embedding dimensions', 'embeddingDimensions'),
    githubToken: await ask('GitHub token', 'githubToken'),
    jwtSecret: await ask('JWT secret', 'jwtSecret'),
    repo: await ask('Default repo (owner/name)', 'defaultRepo'),
    fileWatchEnabled: await ask('Enable local file watch (true/false)', 'fileWatchEnabled'),
    detectedFramework: defaults.detectedFramework,
  };

  rl.close();
  return values;
}

function writeEnvFile(projectPath, values) {
  const envPath = path.join(projectPath, '.env');
  const content = toEnvContent(values);
  fs.writeFileSync(envPath, content, 'utf8');
  return envPath;
}

function writeConfigFile(projectPath, repo) {
  const configPath = path.join(projectPath, 'coderover.config.json');
  const content = JSON.stringify({ repo, branch: 'main' }, null, 2);
  fs.writeFileSync(configPath, content, 'utf8');
  return configPath;
}

function printHelp() {
  stdout.write(
    [
      'coderover CLI',
      '',
      'Commands:',
      '  init            Interactive setup wizard, .env and config generation',
      '  generate-env    Interactive .env generator',
      '',
      'Options:',
      '  --path <dir>    Project path (default: current directory)',
      '',
    ].join('\n'),
  );
}

async function run() {
  const { command, flags } = parseArgs(process.argv);
  const projectPath = path.resolve(flags.path || process.cwd());

  if (!fs.existsSync(projectPath)) {
    stdout.write(`Path does not exist: ${projectPath}\n`);
    process.exit(1);
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command !== 'init' && command !== 'generate-env') {
    stdout.write(`Unknown command: ${command}\n\n`);
    printHelp();
    process.exit(1);
  }

  const values = await promptForEnv(projectPath);
  const envPath = writeEnvFile(projectPath, values);
  const configPath = writeConfigFile(projectPath, values.repo);

  stdout.write(`\nDetected framework: ${values.detectedFramework}\n`);
  stdout.write(`Generated ${envPath}\n`);
  stdout.write(`Generated ${configPath}\n`);
  stdout.write('Next step: docker-compose up -d && npm run migration:run && npm run start:dev\n');
}

run().catch((error) => {
  stdout.write(`CLI failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
