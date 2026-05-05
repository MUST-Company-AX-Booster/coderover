import { registerAs } from '@nestjs/config';
import 'reflect-metadata';
import 'dotenv/config';
import { join } from 'path';
import { DataSource } from 'typeorm';

export const databaseConfig = registerAs('database', () => ({
  host: process.env.DATABASE_HOST,
  port: parseInt(process.env.DATABASE_PORT || '5432', 10),
  name: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
}));

/**
 * DataSource used by the TypeORM CLI (`npm run migration:run`,
 * `migration:revert`). Phase 5: prefer the dedicated migrate user when
 * configured — the runtime `coderover_app` lacks DDL privileges and
 * `migration:run` would fail against it. Falls back to DATABASE_USER
 * for backwards compatibility (single-user dev setups).
 */
const appDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST,
  port: parseInt(process.env.DATABASE_PORT || '5432', 10),
  database: process.env.DATABASE_NAME,
  username: process.env.DATABASE_MIGRATE_USER || process.env.DATABASE_USER,
  password: process.env.DATABASE_MIGRATE_PASSWORD || process.env.DATABASE_PASSWORD,
  entities: [join(__dirname, '..', 'entities', '*.entity{.ts,.js}')],
  migrations: [join(__dirname, '..', 'database', 'migrations', '*{.ts,.js}')],
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
});

export default appDataSource;
