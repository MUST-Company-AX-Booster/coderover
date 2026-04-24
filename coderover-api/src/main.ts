// Phase 9 / Workstream F: initialize OpenTelemetry BEFORE any other imports
// so auto-instrumentations can patch http/express/pg/etc at require-time.
import { startTracing } from './observability/tracer';
startTracing();

import { timingSafeEqual } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bodyParser from 'body-parser';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const rawBodySaver = (req: any, _res: any, buf: Buffer) => {
    if (buf?.length) {
      req.rawBody = Buffer.from(buf);
    }
  };

  app.use(bodyParser.json({ limit: '10mb', verify: rawBodySaver }));
  app.use(bodyParser.urlencoded({ extended: true, verify: rawBodySaver }));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());

  // Phase 9 / Workstream C: attach orgId from req.user to AsyncLocalStorage
  const { OrgScopeInterceptor } = await import('./organizations/org-scope.interceptor');
  app.useGlobalInterceptors(new OrgScopeInterceptor());
  app.enableCors();
  const configService = app.get(ConfigService);
  const swaggerUsername = configService.get<string>('SWAGGER_USERNAME')?.trim();
  const swaggerPassword = configService.get<string>('SWAGGER_PASSWORD');
  const nodeEnv = configService.get<string>('NODE_ENV') ?? 'development';
  const isProduction = nodeEnv === 'production';

  if (Boolean(swaggerUsername) !== Boolean(swaggerPassword)) {
    throw new Error('SWAGGER_USERNAME and SWAGGER_PASSWORD must both be set to protect Swagger docs.');
  }

  // DX fix 2026-04-15: never gate Swagger in non-production. Public specs let
  // developers generate SDKs, import into Postman, and explore endpoints before
  // signing up. Production still requires Basic auth if the env vars are set.
  if (isProduction && swaggerUsername && swaggerPassword) {
    const safeCompare = (value: string, expected: string) => {
      const valueBuffer = Buffer.from(value);
      const expectedBuffer = Buffer.from(expected);

      if (valueBuffer.length !== expectedBuffer.length) {
        return false;
      }

      return timingSafeEqual(valueBuffer, expectedBuffer);
    };

    const unauthorized = (res: any) => {
      res.setHeader('WWW-Authenticate', 'Basic realm="CodeRover API Docs"');
      res.status(401).send('Authentication required.');
    };

    const swaggerAuthMiddleware = (req: any, res: any, next: () => void) => {
      const authorizationHeader = Array.isArray(req.headers.authorization)
        ? req.headers.authorization[0]
        : req.headers.authorization;

      if (!authorizationHeader?.startsWith('Basic ')) {
        unauthorized(res);
        return;
      }

      const decodedCredentials = Buffer.from(authorizationHeader.slice(6).trim(), 'base64').toString('utf8');
      const separatorIndex = decodedCredentials.indexOf(':');

      if (separatorIndex === -1) {
        unauthorized(res);
        return;
      }

      const username = decodedCredentials.slice(0, separatorIndex);
      const password = decodedCredentials.slice(separatorIndex + 1);

      if (!safeCompare(username, swaggerUsername) || !safeCompare(password, swaggerPassword)) {
        unauthorized(res);
        return;
      }

      next();
    };

    app.use('/api-docs', swaggerAuthMiddleware);
    app.use('/api-docs-json', swaggerAuthMiddleware);
    app.use('/api-docs-yaml', swaggerAuthMiddleware);
  }

  const swaggerConfig = new DocumentBuilder()
    .setTitle('CodeRover API')
    .setDescription(
      'REST and MCP companion API for repository intelligence, ingestion orchestration, and PR review automation.',
    )
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT access token obtained from POST /auth/login',
      },
      'bearer',
    )
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig, {
    deepScanRoutes: true,
    operationIdFactory: (controllerKey: string, methodKey: string) => `${controllerKey}_${methodKey}`,
  });
  SwaggerModule.setup('api-docs', app, swaggerDocument, {
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'none',
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
    },
  });

  const port = process.env.PORT || 3001;
  await app.listen(port);
  logger.log(`CodeRover API running on port ${port}`);
  logger.log(`Swagger docs: http://localhost:${port}/api-docs`);
  logger.log(`Health endpoint: http://localhost:${port}/health`);
  logger.log(`MCP endpoint: http://localhost:${port}/mcp`);
  logger.log(`GitHub webhook: POST http://localhost:${port}/webhooks/github`);
}

bootstrap();
