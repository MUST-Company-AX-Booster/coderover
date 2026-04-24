import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import neo4j, { Driver, Session } from 'neo4j-driver';

@Injectable()
export class MemgraphService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MemgraphService.name);
  private driver!: Driver;

  async onModuleInit() {
    // Connect to Memgraph using the Neo4j Bolt driver
    const uri = process.env.MEMGRAPH_URI || 'bolt://localhost:7687';
    // Memgraph doesn't strictly require auth by default, but standard is empty or neo4j/neo4j
    this.driver = neo4j.driver(uri, neo4j.auth.basic('', ''));
    
    try {
      await this.driver.verifyConnectivity();
      this.logger.log('Connected to Memgraph successfully');
      
      // Initialize constraints/indexes if necessary
      await this.initializeSchema();
    } catch (error) {
      this.logger.error(`Failed to connect to Memgraph at ${uri}`, error);
    }
  }

  async onModuleDestroy() {
    if (this.driver) {
      await this.driver.close();
      this.logger.log('Disconnected from Memgraph');
    }
  }

  /**
   * Get a Memgraph session to run queries.
   */
  getSession(): Session {
    return this.driver.session();
  }

  /**
   * Run a read-only Cypher query.
   */
  async readQuery(cypher: string, params: Record<string, any> = {}): Promise<any[]> {
    const session = this.getSession();
    try {
      const result = await session.executeRead(tx => tx.run(cypher, params));
      return result.records;
    } finally {
      await session.close();
    }
  }

  /**
   * Run a write Cypher query.
   */
  async writeQuery(cypher: string, params: Record<string, any> = {}): Promise<any[]> {
    const session = this.getSession();
    try {
      const result = await session.executeWrite(tx => tx.run(cypher, params));
      return result.records;
    } finally {
      await session.close();
    }
  }

  /**
   * Remove all nodes and relationships associated with a specific repository.
   */
  async clearRepoData(repoId: string): Promise<void> {
    this.logger.log(`Clearing graph data for repo: ${repoId}`);
    try {
      // Delete all nodes with this repoId. Relationships are deleted automatically by DETACH DELETE.
      await this.writeQuery(`
        MATCH (n)
        WHERE n.repoId = $repoId
        DETACH DELETE n
      `, { repoId });
      this.logger.log(`Graph data cleared for repo: ${repoId}`);
    } catch (error) {
      this.logger.error(`Failed to clear graph data for repo: ${repoId}`, error);
    }
  }

  /**
   * Set up basic graph constraints.
   */
  private async initializeSchema() {
    try {
      // Ensure file nodes are uniquely identified by repoId + filePath
      await this.writeQuery(`CREATE INDEX ON :File(repoId, filePath);`);
      
      // Indexes for granular entities
      await this.writeQuery(`CREATE INDEX ON :Function(repoId, filePath, name);`);
      await this.writeQuery(`CREATE INDEX ON :Method(repoId, filePath, className, name);`);
      await this.writeQuery(`CREATE INDEX ON :Class(repoId, filePath, name);`);
      
      // Performance indexes for edges
      await this.writeQuery(`CREATE INDEX ON :Function(repoId, name);`);
      await this.writeQuery(`CREATE INDEX ON :Method(repoId, name);`);
      await this.writeQuery(`CREATE INDEX ON :Class(repoId, name);`);

      this.logger.log('Memgraph schema initialized');
    } catch (e) {
      // Indexes might already exist
      this.logger.debug('Memgraph schema initialization (indexes may already exist): ' + (e as Error).message);
    }
  }
}
