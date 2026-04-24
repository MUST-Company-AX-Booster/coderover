import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChatSession } from '../entities/chat-session.entity';
import { ChatMessage } from '../entities/chat-message.entity';
import { RagCitation } from '../entities/rag-citation.entity';
import { ConfidenceTaggerService } from '../graph/confidence-tagger.service';
import { currentOrgId } from '../organizations/org-context';

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @InjectRepository(ChatSession)
    private readonly sessionRepo: Repository<ChatSession>,
    @InjectRepository(ChatMessage)
    private readonly messageRepo: Repository<ChatMessage>,
    @InjectRepository(RagCitation)
    private readonly citationRepo: Repository<RagCitation>,
    private readonly confidenceTagger: ConfidenceTaggerService,
  ) {}

  /** Create a new chat session for a user, scoped to current org. */
  async createSession(userId: string): Promise<ChatSession> {
    const session = this.sessionRepo.create({ userId, orgId: currentOrgId() ?? null });
    const saved = await this.sessionRepo.save(session);
    this.logger.debug(`Created session ${saved.id} for user ${userId}`);
    return saved;
  }

  /** Find a session by ID, or null if not found */
  async getSession(sessionId: string): Promise<ChatSession | null> {
    return this.sessionRepo.findOne({ where: { id: sessionId } });
  }

  /** Get all sessions for a user, ordered by most recent first. Org-scoped. */
  async getUserSessions(userId: string): Promise<ChatSession[]> {
    // Security fix 2026-04-15: fail closed when orgId is missing.
    const orgId = currentOrgId();
    if (!orgId) throw new ForbiddenException('Organization scope required');
    return this.sessionRepo.find({
      where: { userId, orgId },
      order: { updatedAt: 'DESC' },
    });
  }

  /**
   * Get the last N messages for a session, ordered by created_at ASC.
   * Default limit: 20.
   */
  async getSessionHistory(sessionId: string, limit = 20): Promise<ChatMessage[]> {
    return this.messageRepo.find({
      where: { sessionId },
      order: { createdAt: 'ASC' },
      take: limit,
    });
  }

  /** Save a message (user or assistant) to a session */
  async saveMessage(
    sessionId: string,
    role: 'user' | 'assistant',
    content: string,
    metadata?: { toolCalls?: any; sourceChunks?: any },
  ): Promise<ChatMessage> {
    // 2026-04-16 fix: chat_messages.org_id is NOT NULL (migration 015).
    // Look up the parent session's orgId and write it here so chat writes
    // don't fail at the DB layer. The chat pipeline already fetched the
    // session earlier in the request; doing it once more is cheap and
    // avoids threading orgId through 3 call sites.
    const session = await this.sessionRepo.findOne({
      where: { id: sessionId },
      select: ['id', 'orgId'],
    });
    if (!session) {
      throw new Error(`saveMessage: session ${sessionId} not found`);
    }
    if (!session.orgId) {
      // Session created before migration 011 seeded org_ids. Refuse rather
      // than write a row we know will fail the NOT NULL constraint.
      throw new Error(
        `saveMessage: session ${sessionId} has no orgId; cannot save message`,
      );
    }
    const message = this.messageRepo.create({
      sessionId,
      role,
      content,
      toolCalls: metadata?.toolCalls ?? null,
      sourceChunks: metadata?.sourceChunks ?? null,
      orgId: session.orgId,
    } as Partial<ChatMessage>);
    const saved = await this.messageRepo.save(message);

    // Phase 10 B2: mirror source_chunks into rag_citations so every cited
    // chunk carries a confidence tag + evidence_ref. The JSONB column on
    // chat_messages is kept for backward compat (existing UIs read it);
    // new UIs and the /citations/evidence batch endpoint read this table.
    // Failures here never fail the message save — the chat response must
    // still render even if citation logging hiccups.
    const sourceChunks = metadata?.sourceChunks;
    if (saved.id && Array.isArray(sourceChunks)) {
      try {
        await this.writeRagCitations(saved.id, session.orgId, sourceChunks);
      } catch (err) {
        this.logger.warn(
          `Failed to write rag_citations for message ${saved.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return saved;
  }

  /**
   * Phase 10 B2 — persist one `rag_citations` row per retrieved chunk.
   *
   * Classification: RAG chunks come from embedding similarity (an LLM
   * signal), so `producerKind = 'llm'` and the chunk's similarity score
   * is the self-reported confidence. Missing scores fall through to
   * AMBIGUOUS by the tagger contract. The `evidence_ref` carries enough
   * detail that the citation-evidence UI can explain *why* this chunk
   * scored the way it did (similarity + producer label).
   */
  private async writeRagCitations(
    chatMessageId: string,
    orgId: string,
    sourceChunks: any,
  ): Promise<void> {
    if (!Array.isArray(sourceChunks) || sourceChunks.length === 0) return;

    const rows = sourceChunks
      .map((chunk) => this.buildCitationRow(chatMessageId, orgId, chunk))
      .filter((row): row is Partial<RagCitation> => row !== null);

    if (rows.length === 0) return;

    await this.citationRepo.insert(rows);
  }

  private buildCitationRow(
    chatMessageId: string,
    orgId: string,
    chunk: any,
  ): Partial<RagCitation> | null {
    if (!chunk || typeof chunk !== 'object') return null;
    const filePath: string | null =
      typeof chunk.filePath === 'string' ? chunk.filePath : null;
    if (!filePath) return null;

    const { lineStart, lineEnd } = parseLineSpan(chunk.lines);
    const similarity = typeof chunk.similarity === 'number' ? chunk.similarity : null;

    const evidence = this.confidenceTagger.tag({
      producer: 'hybrid-search',
      producerKind: 'llm',
      selfScore: similarity,
      refs: {
        source: 'chat-citation',
        filePath,
        lines: chunk.lines ?? null,
        similarity,
      },
    });

    return {
      chatMessageId,
      orgId,
      filePath,
      lineStart,
      lineEnd,
      similarity,
      confidence: evidence.tag,
      confidenceScore: evidence.score,
      evidenceRef: evidence.evidence_ref as any,
      producer: 'hybrid-search',
    };
  }

  /**
   * Auto-generate a session title from the first user message.
   * Only updates if title is currently null (first message).
   */
  async updateSessionTitle(sessionId: string, firstMessage: string): Promise<void> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (session && !session.title) {
      session.title = firstMessage.substring(0, 60);
      await this.sessionRepo.save(session);
    }
  }

  /** Update the repoIds associated with a session */
  async updateSessionRepoIds(sessionId: string, repoIds: string[]): Promise<void> {
    await this.sessionRepo.update(sessionId, { repoIds });
  }

  /** Delete a session and all its messages */
  async deleteSession(sessionId: string): Promise<void> {
    await this.messageRepo.delete({ sessionId });
    await this.sessionRepo.delete(sessionId);
    this.logger.debug(`Deleted session ${sessionId} and its messages`);
  }
}

/**
 * Parse a `"<start>-<end>"` span (as written into `source_chunks.lines`) into
 * numeric line endpoints. Returns `null` endpoints for malformed input; the
 * rag_citations schema allows both to be null for unknown ranges.
 */
function parseLineSpan(
  lines: unknown,
): { lineStart: number | null; lineEnd: number | null } {
  if (typeof lines !== 'string') {
    return { lineStart: null, lineEnd: null };
  }
  const match = lines.match(/^(\d+)-(\d+)$/);
  if (!match) return { lineStart: null, lineEnd: null };
  const lineStart = Number.parseInt(match[1], 10);
  const lineEnd = Number.parseInt(match[2], 10);
  return {
    lineStart: Number.isFinite(lineStart) ? lineStart : null,
    lineEnd: Number.isFinite(lineEnd) ? lineEnd : null,
  };
}
