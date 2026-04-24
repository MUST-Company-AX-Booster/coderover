import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from 'src/app.module';

describe('AppController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
    process.env.DATABASE_HOST = process.env.DATABASE_HOST ?? 'localhost';
    process.env.DATABASE_PORT = process.env.DATABASE_PORT ?? '5433';
    process.env.DATABASE_NAME = process.env.DATABASE_NAME ?? 'coderover';
    process.env.DATABASE_USER = process.env.DATABASE_USER ?? 'postgres';
    process.env.DATABASE_PASSWORD = process.env.DATABASE_PASSWORD ?? 'postgres';
    process.env.REDIS_HOST = process.env.REDIS_HOST ?? 'localhost';
    process.env.REDIS_PORT = process.env.REDIS_PORT ?? '6379';
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'test';
    process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? 'test';
    process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'x'.repeat(32);
    process.env.TYPEORM_MIGRATIONS_RUN = process.env.TYPEORM_MIGRATIONS_RUN ?? 'true';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('should be defined', () => {
    expect(app).toBeDefined();
  });

  it('GET /ingest/stats returns stats', async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'e2e@example.com' })
      .expect(201);

    const token = loginRes.body.accessToken as string;
    expect(typeof token).toBe('string');

    const statsRes = await request(app.getHttpServer())
      .get('/ingest/stats')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(typeof statsRes.body.totalChunks).toBe('number');
    expect(typeof statsRes.body.totalFiles).toBe('number');
  });
});
