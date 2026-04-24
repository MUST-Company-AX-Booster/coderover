import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validationSchema } from './validation.schema';
import { databaseConfig } from './database.config';
import { openaiConfig } from './openai.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validationSchema,
      load: [databaseConfig, openaiConfig],
    }),
  ],
})
export class AppConfigModule {}
