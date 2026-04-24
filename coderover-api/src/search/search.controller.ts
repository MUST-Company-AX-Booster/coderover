import {
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SearchService, SearchResult } from './search.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ScopeGuard } from '../auth/guards/scope.guard';
import { RequiresScope } from '../common/decorators/scope.decorator';

/**
 * Phase 10 A4 — Sample application of `@RequiresScope`.
 *
 * This is the one endpoint we retrofit in A4 to prove the decorator
 * works end-to-end. The wider retrofit (every MCP-callable endpoint)
 * lands with the MCP integration PR; full-user tokens already pass
 * through because a missing `scope` claim is an explicit bypass.
 */
@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @UseGuards(JwtAuthGuard, ScopeGuard)
  @RequiresScope('search:read')
  @ApiOperation({ summary: 'Hybrid code search (demonstrates @RequiresScope)' })
  async search(
    @Query('q') q: string,
    @Query('topK') topK?: string,
  ): Promise<SearchResult[]> {
    const topKNum = topK ? Number(topK) : undefined;
    return this.searchService.search(q, { topK: topKNum });
  }
}
