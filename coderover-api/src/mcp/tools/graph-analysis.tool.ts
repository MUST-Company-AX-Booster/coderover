import { Injectable } from '@nestjs/common';
import { GraphService } from '../../graph/graph.service';
import { MCPTool, MCPToolParameter } from './index';

@Injectable()
export class GraphAnalysisTool implements MCPTool {
  readonly name = 'graph_analysis';
  readonly description =
    'Analyze the codebase dependency graph. You can request full dependency trees, detect circular dependencies (cycles), analyze impact of changing a file, or find architectural hotspots.';
  readonly parameters: MCPToolParameter[] = [
    {
      name: 'repoId',
      type: 'string',
      description: 'Repository UUID',
      required: true,
    },
    {
      name: 'analysisType',
      type: 'string',
      description: 'Type of analysis: "tree", "cycles", "impact", or "hotspots"',
      required: true,
    },
    {
      name: 'filePath',
      type: 'string',
      description: 'Target file path (required if analysisType is "impact")',
      required: false,
    },
  ];

  constructor(private readonly graphService: GraphService) {}

  async execute(args: Record<string, any>): Promise<any> {
    const repoId = args.repoId as string;
    const analysisType = args.analysisType as string;
    const filePath = args.filePath as string | undefined;

    if (!repoId) {
      throw new Error('repoId is required for graph_analysis');
    }

    switch (analysisType) {
      case 'tree': {
        const graph = await this.graphService.buildGraph(repoId);
        return {
          nodesCount: Object.keys(graph.nodes).length,
          edgesCount: graph.edges.length,
          edges: graph.edges,
          // Limit nodes to prevent huge payload
          nodes: Object.values(graph.nodes).map(n => ({
            filePath: n.filePath,
            nestRole: n.nestRole,
            dependenciesCount: n.dependencies.length,
          })),
        };
      }
      case 'cycles': {
        const graph = await this.graphService.buildGraph(repoId);
        return {
          cyclesCount: graph.cycles.length,
          cycles: graph.cycles,
        };
      }
      case 'hotspots': {
        const graph = await this.graphService.buildGraph(repoId);
        return {
          hotspots: graph.hotspots,
        };
      }
      case 'impact': {
        if (!filePath) {
          throw new Error('filePath is required for impact analysis');
        }
        const impactList = await this.graphService.analyzeImpact(repoId, filePath);
        return {
          target: filePath,
          impactCount: impactList.length,
          impactList,
        };
      }
      default:
        throw new Error(`Unknown analysisType: ${analysisType}`);
    }
  }
}
