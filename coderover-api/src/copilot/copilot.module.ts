import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatSession } from '../entities/chat-session.entity';
import { ChatMessage } from '../entities/chat-message.entity';
import { RagCitation } from '../entities/rag-citation.entity';
import { SearchModule } from '../search/search.module';
import { McpModule } from '../mcp/mcp.module';
import { RepoModule } from '../repo/repo.module';
import { ObservabilityModule } from '../observability/observability.module';
import { GraphModule } from '../graph/graph.module';
import { CopilotController } from './copilot.controller';
import { CopilotService } from './copilot.service';
import { SessionService } from './session.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ChatSession, ChatMessage, RagCitation]),
    SearchModule,
    McpModule,
    RepoModule,
    ObservabilityModule,
    GraphModule,
  ],
  controllers: [CopilotController],
  providers: [CopilotService, SessionService],
})
export class CopilotModule {}
