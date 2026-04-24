import { Body, Controller, HttpCode, HttpStatus, NotFoundException, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SearchService } from '../search/search.service';
import { RetrievalDebugRequestDto } from './dto/retrieval-debug.dto';

@ApiTags('debug')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('debug')
export class DebugController {
  constructor(
    private readonly configService: ConfigService,
    private readonly searchService: SearchService,
  ) {}

  @Post('retrieval')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dev-only retrieval diagnostics' })
  @ApiBody({
    type: RetrievalDebugRequestDto,
    examples: {
      basic: {
        summary: 'Basic retrieval debug',
        value: { query: 'where is auth guard used', topK: 5, searchMode: 'auto' },
      },
    },
  })
  @ApiOkResponse({
    description: 'Resolved retrieval mode, fallback usage, query tokens, and result preview',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiNotFoundResponse({ description: 'Debug endpoint is unavailable in production' })
  async debugRetrieval(@Body() dto: RetrievalDebugRequestDto) {
    if (this.configService.get<string>('NODE_ENV') === 'production') {
      throw new NotFoundException('Not found');
    }

    const { query, ...options } = dto;
    const diagnostics = await this.searchService.debugRetrieval(query, options);

    return {
      query,
      mode: diagnostics.mode,
      fallbackUsed: diagnostics.fallbackUsed,
      queryTokens: diagnostics.queryTokens,
      resultsFound: diagnostics.results.length,
      error: diagnostics.error,
      results: diagnostics.results.map((row) => ({
        filePath: row.filePath,
        moduleName: row.moduleName,
        lineStart: row.lineStart,
        lineEnd: row.lineEnd,
        similarity: row.similarity,
        language: row.language,
        framework: row.framework,
      })),
    };
  }
}
