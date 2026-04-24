import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { ScopeGuard } from './guards/scope.guard';
import { OAuthStateService } from './oauth-state.service';
import { TokenRevocationService } from './token-revocation.service';
import { GithubConnection } from '../entities/github-connection.entity';
import { User } from '../entities/user.entity';
import { OrgMembership } from '../entities/org-membership.entity';
import { RevokedToken } from '../entities/revoked-token.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([GithubConnection, User, OrgMembership, RevokedToken]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: configService.get<string>('JWT_EXPIRES_IN', '7d') },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    JwtAuthGuard,
    RolesGuard,
    ScopeGuard,
    OAuthStateService,
    TokenRevocationService,
  ],
  exports: [AuthService, JwtAuthGuard, RolesGuard, ScopeGuard, TokenRevocationService],
})
export class AuthModule {}
