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

const appDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST,
  port: parseInt(process.env.DATABASE_PORT || '5432', 10),
  database: process.env.DATABASE_NAME,
  username: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  entities: [join(__dirname, '..', 'entities', '*.entity{.ts,.js}')],
  migrations: [join(__dirname, '..', 'database', 'migrations', '*{.ts,.js}')],
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
});

export default appDataSource;
