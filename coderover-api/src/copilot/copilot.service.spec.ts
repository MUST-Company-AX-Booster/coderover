import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CopilotService } from './copilot.service';
import { SearchService } from '../search/search.service';
import { McpService } from '../mcp/mcp.service';
import { SessionService } from './session.service';
import { RepoService } from '../repo/repo.service';
import { SSEEventType } from './dto/chat-response.dto';

/** Helper to create a mock Express Response with SSE tracking */
function mockResponse() {
  const events: any[] = [];
  return {
    setHeader: jest.fn(),
    write: jest.fn((data: string) => {
      // Parse SSE "data: {...}\n\n" format
      const match = data.match(/^data: (.+)\n\n$/);
      if (match) {
        try {
          events.push(JSON.parse(match[1]));
        } catch {
          events.push(data);
        }
      }
    }),
    end: jest.fn(),
    _events: events,
  };
}

// Mock async iterator for OpenAI stream
function* makeStreamChunks(content: string) {
  // Yield the content in one chunk
  yield {
    choices: [
      {
        delta: { content, tool_calls: undefined },
        finish_reason: null,
      },
    ],
  };
  // Yield finish
  yield {
    choices: [
      {
        delta: {},
        finish_reason: 'stop',
      },
    ],
  };
}

const mockOpenAI = {
  chat: {
    completions: {
      create: jest.fn().mockResolvedValue(makeStreamChunks('Hello, I can help with that.')),
    },
  },
};

jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => mockOpenAI);
});

describe('CopilotService', () => {
  let service: CopilotService;
  let searchService: jest.Mocked<Partial<SearchService>>;
  let mcpService: jest.Mocked<Partial<McpService>>;
  let sessionService: jest.Mocked<Partial<SessionService>>;
  let repoService: jest.Mocked<Partial<RepoService>>;

  const mockSession = { id: 'session-123', userId: 'user-1', title: null, repoIds: null, createdAt: new Date(), updatedAt: new Date(), messages: [] };
  const mockMessage = { id: 'msg-1', sessionId: 'session-123', role: 'assistant', content: 'Hello', createdAt: new Date(), toolCalls: null, sourceChunks: null };

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    searchService = {
      search: jest.fn().mockResolvedValue([
        {
          id: 'chunk-1',
          filePath: 'src/auth/auth.service.ts',
          moduleName: 'AuthModule',
          chunkText: 'export class AuthService { ... }',
          lineStart: 1,
          lineEnd: 20,
          similarity: 0.85,
        },
      ]),
    };

    mcpService = {
      getToolsForOpenAI: jest.fn().mockReturnValue([]),
      executeTool: jest.fn(),
    };

    sessionService = {
      getSession: jest.fn().mockResolvedValue(null),
      createSession: jest.fn().mockResolvedValue(mockSession),
      saveMessage: jest.fn().mockResolvedValue(mockMessage),
      updateSessionTitle: jest.fn().mockResolvedValue(undefined),
      getSessionHistory: jest.fn().mockResolvedValue([]),
      updateSessionRepoIds: jest.fn().mockResolvedValue(undefined),
    };

    repoService = {
      buildSystemPrompt: jest.fn().mockResolvedValue(
        'You are an AI code assistant. You have access to tools to search indexed codebases. Always cite file paths and line numbers when referencing code.',
      ),
      findById: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CopilotService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const values: Record<string, string | undefined> = {
                OPENAI_API_KEY: 'test-key',
                OPENAI_BASE_URL: undefined,
                OPENAI_CHAT_MODEL: 'gpt-4o-mini',
                LLM_PROVIDER: 'openai',
              };
              return values[key];
            }),
          },
        },
        { provide: SearchService, useValue: searchService },
        { provide: McpService, useValue: mcpService },
        { provide: SessionService, useValue: sessionService },
        { provide: RepoService, useValue: repoService },
        { provide: DataSource, useValue: { query: jest.fn() } },
      ],
    }).compile();

    service = module.get<CopilotService>(CopilotService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should call searchService.search with the user message', async () => {
    const res = mockResponse();
    await service.chat({ message: 'how does auth work?' }, res as any);

    expect(searchService.search).toHaveBeenCalledWith('how does auth work?', { topK: 8, repoIds: undefined });
  });

  it('should save user message to session', async () => {
    const res = mockResponse();
    await service.chat({ message: 'explain booking' }, res as any);

    expect(sessionService.saveMessage).toHaveBeenCalledWith(
      'session-123',
      'user',
      'explain booking',
    );
  });

  it('should save assistant message after streaming', async () => {
    const res = mockResponse();
    await service.chat({ message: 'test' }, res as any);

    // Second call to saveMessage should be the assistant response
    const assistantCalls = (sessionService.saveMessage as jest.Mock).mock.calls.filter(
      (call: any[]) => call[1] === 'assistant',
    );
    expect(assistantCalls).toHaveLength(1);
    expect(assistantCalls[0][0]).toBe('session-123'); // sessionId
    expect(assistantCalls[0][1]).toBe('assistant');    // role
  });

  it('should send DONE SSE event with sessionId and messageId', async () => {
    const res = mockResponse();
    await service.chat({ message: 'test' }, res as any);

    const doneEvents = res._events.filter((e: any) => e.type === SSEEventType.DONE);
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0].sessionId).toBe('session-123');
    expect(doneEvents[0].messageId).toBe('msg-1');
  });

  it('should send ERROR SSE event when OpenAI fails', async () => {
    mockOpenAI.chat.completions.create.mockRejectedValueOnce(new Error('OpenAI API error'));

    const res = mockResponse();
    await service.chat({ message: 'test' }, res as any);

    const errorEvents = res._events.filter((e: any) => e.type === SSEEventType.ERROR);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].message).toContain('OpenAI API error');
    expect(res.end).toHaveBeenCalled();
  });

  it('should call repoService.buildSystemPrompt with effectiveRepoIds', async () => {
    const res = mockResponse();
    await service.chat({ message: 'test', repoIds: ['repo-uuid-1'] }, res as any);

    expect(repoService.buildSystemPrompt).toHaveBeenCalledWith(['repo-uuid-1']);
  });

  it('should pass repoIds to searchService when provided', async () => {
    const res = mockResponse();
    await service.chat({ message: 'test', repoIds: ['repo-uuid-1', 'repo-uuid-2'] }, res as any);

    expect(searchService.search).toHaveBeenCalledWith('test', {
      topK: 8,
      repoIds: ['repo-uuid-1', 'repo-uuid-2'],
    });
  });
});
