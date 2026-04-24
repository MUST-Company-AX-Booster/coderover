import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentApproval, AgentApprovalStatus } from '../../entities/agent-approval.entity';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class AgentApprovalService {
  private readonly logger = new Logger(AgentApprovalService.name);

  constructor(
    @InjectRepository(AgentApproval)
    private approvalRepo: Repository<AgentApproval>,
  ) {}

  async createApproval(
    agentRunId: string,
    actionType: string,
    actionPayload: Record<string, any>,
    ttlHours = 24,
  ): Promise<AgentApproval> {
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
    const approval = this.approvalRepo.create({
      agentRunId,
      actionType,
      actionPayload,
      approvalToken: uuidv4(),
      expiresAt,
      status: AgentApprovalStatus.PENDING,
    });
    return this.approvalRepo.save(approval);
  }

  async getApproval(token: string): Promise<AgentApproval | null> {
    return this.approvalRepo.findOne({ where: { approvalToken: token }, relations: ['agentRun'] });
  }

  async getApprovalById(id: string): Promise<AgentApproval | null> {
    return this.approvalRepo.findOne({ where: { id }, relations: ['agentRun'] });
  }

  async getPendingApprovals(repoId?: string): Promise<AgentApproval[]> {
    const query = this.approvalRepo
      .createQueryBuilder('approval')
      .leftJoinAndSelect('approval.agentRun', 'agentRun')
      .where('approval.status = :status', { status: AgentApprovalStatus.PENDING });

    if (repoId) {
      query.andWhere('agentRun.repoId = :repoId', { repoId });
    }

    return query.orderBy('approval.createdAt', 'DESC').getMany();
  }

  async updateStatus(id: string, status: AgentApprovalStatus, approver?: string): Promise<AgentApproval> {
    const approval = await this.approvalRepo.findOne({ where: { id } });
    if (!approval) throw new Error('Approval not found');

    approval.status = status;
    if (approver) approval.approver = approver;
    if (status !== AgentApprovalStatus.PENDING) approval.decidedAt = new Date();

    return this.approvalRepo.save(approval);
  }
}
