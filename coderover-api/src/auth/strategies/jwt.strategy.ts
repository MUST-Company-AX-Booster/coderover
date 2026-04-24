import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService, JwtPayload } from '../auth.service';
import { TokenRevocationService } from '../token-revocation.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly authService: AuthService,
    private readonly tokenRevocation: TokenRevocationService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET'),
    });
  }

  /**
   * Phase 10 A4: if the token carries a `jti`, check revocation state.
   * Legacy tokens (no `jti`) bypass the DB hit — critical for backward
   * compat with sessions issued before A4 landed.
   */
  async validate(payload: JwtPayload): Promise<JwtPayload> {
    if (payload.jti) {
      const revoked = await this.tokenRevocation.isRevoked(payload.jti);
      if (revoked) {
        // Explicit 401 so MCP clients can surface a "token revoked —
        // re-authenticate or re-issue" message instead of guessing at a
        // generic 403. Failure mode table in Phase10_Plan §11.2.
        throw new UnauthorizedException('Token has been revoked');
      }
    }
    return this.authService.validateUser(payload);
  }
}
