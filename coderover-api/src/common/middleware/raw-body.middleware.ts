import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/**
 * Captures the raw request body as a Buffer on `req.rawBody`.
 * Required for GitHub webhook HMAC-SHA256 signature verification.
 * Must be applied before NestJS parses the JSON body.
 */
@Injectable()
export class RawBodyMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on('end', () => {
      (req as any).rawBody = Buffer.concat(chunks);
      next();
    });

    req.on('error', (err) => {
      next(err);
    });
  }
}
