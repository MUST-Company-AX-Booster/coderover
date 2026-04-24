import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Organization } from '../entities/organization.entity';
import { OrgMembership, OrgRole } from '../entities/org-membership.entity';

@Injectable()
export class OrganizationsService {
  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  constructor(
    @InjectRepository(Organization)
    private readonly orgRepo: Repository<Organization>,
    @InjectRepository(OrgMembership)
    private readonly membershipRepo: Repository<OrgMembership>,
  ) {}

  async listForUser(userId: string): Promise<Array<{ id: string; name: string; slug: string; role: OrgRole }>> {
    if (!this.isUuid(userId)) {
      return [];
    }

    const memberships = await this.membershipRepo.find({
      where: { userId },
      relations: ['organization'],
    });
    return memberships.map(m => ({
      id: m.organization.id,
      name: m.organization.name,
      slug: m.organization.slug,
      role: m.role,
    }));
  }

  async assertMember(userId: string, orgId: string): Promise<OrgMembership> {
    if (!this.isUuid(userId)) {
      throw new ForbiddenException('Invalid user identity');
    }

    const m = await this.membershipRepo.findOne({ where: { userId, orgId } });
    if (!m) throw new ForbiddenException('Not a member of this organization');
    return m;
  }

  async createOrg(name: string, slug: string, ownerUserId: string): Promise<Organization> {
    if (!this.isUuid(ownerUserId)) {
      throw new ForbiddenException('Invalid user identity');
    }

    const org = this.orgRepo.create({ name, slug });
    const saved = await this.orgRepo.save(org);
    const membership = this.membershipRepo.create({
      orgId: saved.id,
      userId: ownerUserId,
      role: OrgRole.OWNER,
    });
    await this.membershipRepo.save(membership);
    return saved;
  }

  async inviteMember(
    orgId: string,
    targetUserId: string,
    role: OrgRole = OrgRole.MEMBER,
  ): Promise<OrgMembership> {
    const existing = await this.membershipRepo.findOne({ where: { orgId, userId: targetUserId } });
    if (existing) return existing;
    const membership = this.membershipRepo.create({ orgId, userId: targetUserId, role });
    return this.membershipRepo.save(membership);
  }

  async getBySlug(slug: string): Promise<Organization> {
    const org = await this.orgRepo.findOne({ where: { slug } });
    if (!org) throw new NotFoundException(`Org '${slug}' not found`);
    return org;
  }

  async setMonthlyTokenCap(orgId: string, cap: number | null): Promise<Organization> {
    const org = await this.orgRepo.findOne({ where: { id: orgId } });
    if (!org) throw new NotFoundException(`Org ${orgId} not found`);
    org.monthlyTokenCap = cap;
    return this.orgRepo.save(org);
  }
}
