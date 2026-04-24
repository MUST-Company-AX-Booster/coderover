/**
 * Seed script for CodeRover.
 * Registers a sample public repository and triggers ingestion.
 *
 * Usage: npx ts-node src/database/seed.ts
 *
 * Requires: Backend running on PORT (default 3001) with all services up.
 */

const API_URL = process.env.API_URL || 'http://localhost:3001';

async function request(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

let authHeaders: Record<string, string> = {};

async function seed() {
  console.log('=== CodeRover Seed Script ===\n');

  // 1. Login to get a JWT
  console.log('1. Logging in...');
  const loginResult = await request('POST', '/auth/login', {
    email: 'seed@coderover.dev',
    password: 'seed',
  });
  const token = loginResult.accessToken || loginResult.access_token;
  if (!token) throw new Error('Login failed — no token returned');
  authHeaders = { Authorization: `Bearer ${token}` };
  console.log('   Logged in as seed@coderover.dev\n');

  // 2. Check existing repos
  console.log('2. Checking existing repositories...');
  const repos = await request('GET', '/repos');
  const sampleRepo = 'https://github.com/expressjs/express';
  const existing = repos.find((r: any) => r.fullName === 'expressjs/express');

  let repoId: string;
  if (existing) {
    console.log(`   Repository already exists (${existing.id})\n`);
    repoId = existing.id;
  } else {
    // 3. Register sample repo
    console.log('3. Registering sample repository (expressjs/express)...');
    const newRepo = await request('POST', '/repos', {
      repoUrl: sampleRepo,
      label: 'Express.js',
      branch: 'master',
    });
    repoId = newRepo.id;
    console.log(`   Created repo ${repoId}\n`);
  }

  // 4. Trigger ingestion
  console.log('4. Triggering ingestion (this may take 1-3 minutes)...');
  try {
    await request('POST', `/repos/${repoId}/ingest`);
    console.log('   Ingestion job queued.\n');
  } catch (err: any) {
    console.log(`   Ingestion trigger: ${err.message}\n`);
  }

  // 5. Check health
  console.log('5. Checking system health...');
  const health = await fetch(`${API_URL}/health`).then((r) => r.json());
  console.log(`   Status: ${health.status}`);
  console.log(`   Database: ${health.components?.database?.status}`);
  console.log(`   Queue: ${health.components?.queue?.status}\n`);

  console.log('=== Seed complete! ===');
  console.log(`\nOpen http://localhost:5173 and login with seed@coderover.dev`);
  console.log(`The Express.js repository will be available once ingestion completes.`);
  console.log(`Check progress: GET /repos/${repoId}/status`);
}

seed().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
