import { Global, Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';

/**
 * Global so every module that needs to encrypt/decrypt settings (AdminConfig
 * today; potentially github_connections in a follow-up) can inject it
 * without an explicit import chain.
 */
@Global()
@Module({
  providers: [CryptoService],
  exports: [CryptoService],
})
export class CryptoModule {}
