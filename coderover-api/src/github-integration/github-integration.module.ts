import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GitHubIntegrationController } from './github-integration.controller';
import { GitHubIntegrationService } from './github-integration.service';
import { GitHubAppService } from './github-app.service';
import { GitHubTokenResolver } from './github-token-resolver.service';
import { GithubConnection } from '../entities/github-connection.entity';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [TypeOrmModule.forFeature([GithubConnection]), AuthModule],
  controllers: [GitHubIntegrationController],
  providers: [GitHubIntegrationService, GitHubAppService, GitHubTokenResolver],
  exports: [GitHubIntegrationService, GitHubAppService, GitHubTokenResolver],
})
export class GitHubIntegrationModule {}
