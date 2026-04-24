import { Body, Controller, Get, Post, Req, UseGuards, Param, ForbiddenException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OrganizationsService } from './organizations.service';
import { OrgRole } from '../entities/org-membership.entity';

@Controller('organizations')
@UseGuards(JwtAuthGuard)
export class OrganizationsController {
  constructor(private readonly orgsService: OrganizationsService) {}

  @Get()
  async list(@Req() req: any) {
    return this.orgsService.listForUser(req.user.userId ?? req.user.sub);
  }

  @Post()
  async create(@Req() req: any, @Body() body: { name: string; slug: string }) {
    const ownerId = req.user.userId ?? req.user.sub;
    return this.orgsService.createOrg(body.name, body.slug, ownerId);
  }

  @Post(':orgId/members')
  async invite(
    @Req() req: any,
    @Param('orgId') orgId: string,
    @Body() body: { userId: string; role?: OrgRole },
  ) {
    // Security fix 2026-04-15 (privilege escalation):
    //   1. Use :orgId from path; do not trust body.orgId — previously the
    //      auth target and the mutation target could diverge.
    //   2. Require caller is OWNER or ADMIN of the target org. Plain MEMBER
    //      callers could previously invite accomplices with arbitrary roles.
    //   3. Enforce role hierarchy: only OWNER may grant OWNER; ADMIN may at
    //      most grant ADMIN; MEMBER cannot invite at all.
    const callerId = req.user.userId ?? req.user.sub;
    const membership = await this.orgsService.assertMember(callerId, orgId);
    if (membership.role !== OrgRole.OWNER && membership.role !== OrgRole.ADMIN) {
      throw new ForbiddenException('Only owners and admins may invite members');
    }
    const requestedRole = body.role ?? OrgRole.MEMBER;
    if (requestedRole === OrgRole.OWNER && membership.role !== OrgRole.OWNER) {
      throw new ForbiddenException('Only an owner may grant the owner role');
    }
    return this.orgsService.inviteMember(orgId, body.userId, requestedRole);
  }

  @Post(':orgId/cap')
  async setCap(
    @Req() req: any,
    @Param('orgId') orgId: string,
    @Body() body: { monthlyTokenCap: number | null },
  ) {
    const callerId = req.user.userId ?? req.user.sub;
    const membership = await this.orgsService.assertMember(callerId, orgId);
    if (membership.role !== OrgRole.OWNER && membership.role !== OrgRole.ADMIN) {
      throw new ForbiddenException('Only owners/admins may change the token cap');
    }
    return this.orgsService.setMonthlyTokenCap(orgId, body.monthlyTokenCap);
  }
}
