import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SessionService } from './session.service';
import { ChatSession } from '../entities/chat-session.entity';
import { ChatMessage } from '../entities/chat-message.entity';
import { RagCitation } from '../entities/rag-citation.entity';
import { ConfidenceTaggerService } from '../graph/confidence-tagger.service';

/**
 * Phase 10 B2 — verifies that `saveMessage` mirrors `source_chunks` into
 * `rag_citations` with a confidence tag from `ConfidenceTagger`. The legacy
 * JSONB column on `chat_messages` is preserved for backward compat.
 */
describe('SessionService (Phase 10 B2 rag_citations wire-up)', () => {
  let service: SessionService;
  let sessionRepo: any;
  let messageRepo: any;
  let citationRepo: any;

  const SESSION_ID = 'session-uuid-1';
  const ORG_ID = 'org-uuid-1';

  beforeEach(async () => {
    sessionRepo = {
      findOne: jest.fn().mockResolvedValue({ id: SESSION_ID, orgId: ORG_ID }),
      create: jest.fn(),
      save: jest.fn(),
      find: jest.fn(),
      delete: jest.fn(),
      update: jest.fn(),
    };
    messageRepo = {
      create: jest.fn((v: any) => v),
      save: jest.fn(async (v: any) => ({ id: 'msg-uuid-1', ...v })),
      find: jest.fn(),
      delete: jest.fn(),
    };
    citationRepo = {
      insert: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionService,
        { provide: getRepositoryToken(ChatSession), useValue: sessionRepo },
        { provide: getRepositoryToken(ChatMessage), useValue: messageRepo },
        { provide: getRepositoryToken(RagCitation), useValue: citationRepo },
        ConfidenceTaggerService,
      ],
    }).compile();

    service = module.get(SessionService);
  });

  it('writes no rag_citations rows when source_chunks is missing', async () => {
    await service.saveMessage(SESSION_ID, 'assistant', 'hello');

    expect(messageRepo.save).toHaveBeenCalledTimes(1);
    expect(citationRepo.insert).not.toHaveBeenCalled();
  });

  it('writes one rag_citations row per source chunk with INFERRED tag + similarity', async () => {
    await service.saveMessage(SESSION_ID, 'assistant', 'hello', {
      sourceChunks: [
        { filePath: 'src/a.ts', lines: '10-20', similarity: 0.82 },
        { filePath: 'src/b.ts', lines: '1-5', similarity: 0.7 },
      ],
    });

    expect(citationRepo.insert).toHaveBeenCalledTimes(1);
    const rows = citationRepo.insert.mock.calls[0][0];
    expect(rows).toHaveLength(2);

    expect(rows[0]).toMatchObject({
      chatMessageId: 'msg-uuid-1',
      orgId: ORG_ID,
      filePath: 'src/a.ts',
      lineStart: 10,
      lineEnd: 20,
      similarity: 0.82,
      confidence: 'INFERRED',
      confidenceScore: 0.82,
      producer: 'hybrid-search',
    });
    expect(rows[0].evidenceRef).toMatchObject({
      source: 'chat-citation',
      filePath: 'src/a.ts',
      similarity: 0.82,
    });

    expect(rows[1]).toMatchObject({
      filePath: 'src/b.ts',
      lineStart: 1,
      lineEnd: 5,
      confidence: 'INFERRED',
      confidenceScore: 0.7,
    });
  });

  it('tags chunks with missing similarity as AMBIGUOUS', async () => {
    await service.saveMessage(SESSION_ID, 'assistant', 'hello', {
      sourceChunks: [{ filePath: 'src/a.ts', lines: '1-2' }],
    });

    expect(citationRepo.insert).toHaveBeenCalledTimes(1);
    const rows = citationRepo.insert.mock.calls[0][0];
    expect(rows[0].confidence).toBe('AMBIGUOUS');
    expect(rows[0].confidenceScore).toBeNull();
  });

  it('still saves the chat message when citation insert fails', async () => {
    citationRepo.insert.mockRejectedValueOnce(new Error('boom'));

    const saved = await service.saveMessage(SESSION_ID, 'assistant', 'hello', {
      sourceChunks: [{ filePath: 'src/a.ts', lines: '1-2', similarity: 0.5 }],
    });

    // Message persisted even though citation mirror failed.
    expect(saved).toMatchObject({ id: 'msg-uuid-1' });
    expect(messageRepo.save).toHaveBeenCalledTimes(1);
  });

  it('preserves the JSONB source_chunks column (backward compat)', async () => {
    const sourceChunks = [{ filePath: 'src/a.ts', lines: '1-2', similarity: 0.5 }];
    await service.saveMessage(SESSION_ID, 'assistant', 'hello', { sourceChunks });

    // The entity passed to messageRepo.save still carries source_chunks.
    const saved = messageRepo.save.mock.calls[0][0];
    expect(saved.sourceChunks).toBe(sourceChunks);
  });

  it('skips chunks with malformed payloads', async () => {
    await service.saveMessage(SESSION_ID, 'assistant', 'hello', {
      sourceChunks: [
        null,
        { lines: '1-2' }, // no filePath
        { filePath: 'src/ok.ts', lines: '3-4', similarity: 0.6 },
      ],
    });

    const rows = citationRepo.insert.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0].filePath).toBe('src/ok.ts');
  });
});
