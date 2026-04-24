import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AgentMemoryService } from './agent-memory.service';
import { AgentMemory, AgentMemoryType } from '../../entities/agent-memory.entity';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';

@ApiTags('agent-memory')
@Controller('agent/memory')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AgentMemoryController {
  constructor(private readonly agentMemoryService: AgentMemoryService) {}

  @Get(':repoId')
  @ApiOperation({ summary: 'List agent memory entries' })
  async listMemory(
    @Param('repoId') repoId: string,
    @Query('type') type?: AgentMemoryType,
  ): Promise<AgentMemory[]> {
    return this.agentMemoryService.listMemory(repoId, type);
  }

  @Post(':repoId')
  @ApiOperation({ summary: 'Create a memory entry' })
  @HttpCode(HttpStatus.CREATED)
  async createMemory(
    @Param('repoId') repoId: string,
    @Body()
    body: {
      type: AgentMemoryType;
      key: string;
      value: Record<string, any>;
      ttlDays?: number;
    },
  ): Promise<AgentMemory> {
    return this.agentMemoryService.createMemory(
      repoId,
      body.type,
      body.key,
      body.value,
      body.ttlDays,
    );
  }

  @Delete(':repoId/:id')
  @ApiOperation({ summary: 'Delete a memory entry' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteMemory(@Param('id') id: string): Promise<void> {
    await this.agentMemoryService.deleteMemory(id);
  }
}
