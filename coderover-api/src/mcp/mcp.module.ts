import { Module } from '@nestjs/common';
import { SearchModule } from '../search/search.module';
import { PrReviewModule } from '../pr-review/pr-review.module';
import { ArtifactsModule } from '../artifacts/artifacts.module';
import { GraphModule } from '../graph/graph.module';
import { McpController } from './mcp.controller';
import { McpProtocolController } from './mcp-protocol.controller';
import { McpService } from './mcp.service';
import { SearchCodebaseTool } from './tools/search-codebase.tool';
import { GetModuleSummaryTool } from './tools/get-module-summary.tool';
import { GetApiEndpointsTool } from './tools/get-api-endpoints.tool';
import { GenerateCodeTool } from './tools/generate-code.tool';
import { FindSymbolTool } from './tools/find-symbol.tool';
import { FindDependenciesTool } from './tools/find-dependencies.tool';
import { ReviewPrTool } from './tools/review-pr.tool';
import { GraphAnalysisTool } from './tools/graph-analysis.tool';
import { QueryCodeGraphTool } from './tools/query-code-graph.tool';

@Module({
  imports: [SearchModule, PrReviewModule, ArtifactsModule, GraphModule],
  controllers: [
    McpController,          // POST /mcp/execute  (REST endpoint)
    McpProtocolController,  // GET+POST /mcp      (MCP protocol for Trae/Cursor)
  ],
  providers: [
    McpService,
    SearchCodebaseTool,
    GetModuleSummaryTool,
    GetApiEndpointsTool,
    GenerateCodeTool,
    FindSymbolTool,
    FindDependenciesTool,
    ReviewPrTool,
    GraphAnalysisTool,
    QueryCodeGraphTool,
  ],
  exports: [McpService],
})
export class McpModule {}
