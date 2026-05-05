import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import OpenAI from 'openai';
import { ChatRequestDto } from './dto/chat-request.dto';
import { SSEEventType, SSEEvent } from './dto/chat-response.dto';
import { SearchService, SearchResult } from '../search/search.service';
import { McpService } from '../mcp/mcp.service';
import { SessionService } from './session.service';
import { RepoService } from '../repo/repo.service';
import { DataSource } from 'typeorm';
import { TokenCapService } from '../observability/token-cap.service';
import { currentOrgId } from '../organizations/org-context';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { LLMKillSwitchService } from '../llm-guard/llm-kill-switch.service';
import { LLMResponseValidatorService } from '../llm-guard/llm-response-validator.service';

const otelTracer = trace.getTracer('coderover.copilot');
import {
  createLocalChatCompletion,
  resolveLlmBaseUrl,
  resolveLlmProvider,
} from '../config/openai.config';

/** Max past messages loaded from session history for context */
const HISTORY_LIMIT = 6;

@Injectable()
export class CopilotService {
  private readonly logger = new Logger(CopilotService.name);
  private readonly openai: OpenAI;
  private readonly chatModel: string;
  private readonly llmProvider: 'openai' | 'openrouter' | 'local';

  constructor(
    private readonly configService: ConfigService,
    private readonly searchService: SearchService,
    private readonly mcpService: McpService,
    private readonly sessionService: SessionService,
    private readonly repoService: RepoService,
    private readonly dataSource: DataSource,
    private readonly tokenCap: TokenCapService,
    // Phase 4A: kill switch is checked before EVERY outbound LLM call,
    // response validator scrubs accumulated content before persistence.
    private readonly llmKillSwitch: LLMKillSwitchService,
    private readonly llmValidator: LLMResponseValidatorService,
  ) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    const configuredBaseURL = this.configService.get<string>('OPENAI_BASE_URL');
    this.llmProvider = resolveLlmProvider(
      this.configService.get<string>('LLM_PROVIDER'),
      apiKey,
      configuredBaseURL,
    );
    const baseURL = resolveLlmBaseUrl(this.llmProvider, configuredBaseURL, apiKey, 'chat');

    this.openai = new OpenAI({
      apiKey,
      baseURL,
    });
    const defaultChatModel = apiKey?.startsWith('sk-or-') ? 'openai/gpt-4o' : 'gpt-4o';
    this.chatModel = this.configService.get<string>('OPENAI_CHAT_MODEL') || defaultChatModel;
  }

  /**
   * Process a chat request with RAG context, LLM streaming, and agentic tool-call loop.
   * Streams SSE events directly to the response.
   */
  async chat(dto: ChatRequestDto, res: Response): Promise<void> {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const startedAt = new Date();
    let sessionId: string | null = null;
    let primaryRepoId: string | null = null;
    let telemetry: {
      firstTokenAt: Date | null;
      completedAt: Date | null;
      durationMs: number | null;
      latencyMs: number | null;
      promptTokens: number | null;
      completionTokens: number | null;
      totalTokens: number | null;
    } | null = null;

    try {
      // 1. Session management
      let session;
      if (dto.sessionId) {
        session = await this.sessionService.getSession(dto.sessionId);
      }
      if (!session) {
        session = await this.sessionService.createSession('anonymous');
      }
      sessionId = session.id;

      // Resolve effective repoIds
      const effectiveRepoIds = dto.repoIds ?? (dto.repoId ? [dto.repoId] : session.repoIds ?? []);
      primaryRepoId = effectiveRepoIds[0] ?? null;

      // Update session repoIds when explicitly provided in the request
      const clientSentRepoIds = dto.repoIds ?? (dto.repoId ? [dto.repoId] : null);
      if (clientSentRepoIds && clientSentRepoIds.length > 0) {
        const changed = JSON.stringify(clientSentRepoIds.sort()) !== JSON.stringify((session.repoIds ?? []).sort());
        if (changed) {
          session.repoIds = clientSentRepoIds;
          await this.sessionService.updateSessionRepoIds(session.id, clientSentRepoIds);
        }
      } else if (effectiveRepoIds.length > 0 && !session.repoIds) {
        session.repoIds = effectiveRepoIds;
        await this.sessionService.updateSessionRepoIds(session.id, effectiveRepoIds);
      }

      // 2. Save user message
      await this.sessionService.saveMessage(session.id, 'user', dto.message);
      await this.sessionService.updateSessionTitle(session.id, dto.message);

      // 3. Build RAG context (graceful degradation if search fails)
      let searchResults: SearchResult[] = [];
      try {
        searchResults = await otelTracer.startActiveSpan('copilot.retrieval', async span => {
          try {
            span.setAttribute('query.length', dto.message.length);
            span.setAttribute('repo.count', effectiveRepoIds.length);
            const results = await this.searchService.search(dto.message, {
              topK: 8,
              repoIds: effectiveRepoIds.length > 0 ? effectiveRepoIds : undefined,
            });
            span.setAttribute('results.count', results.length);
            return results;
          } catch (err) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
            throw err;
          } finally { span.end(); }
        });
      } catch (err) {
        this.logger.warn(`Search failed, continuing without context: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 4. Build dynamic system prompt
      const systemPrompt = await this.repoService.buildSystemPrompt(effectiveRepoIds);

      // 5. Build messages array
      const messages = await this.buildMessages(session.id, dto.message, searchResults, systemPrompt);

      // 6. Stream with agentic tool-call loop
      const { fullContent: rawFullContent, toolCalls, metrics } = await this.streamWithToolLoop(messages, res);
      telemetry = metrics;

      // 6a. Phase 4A: validate + sanitize the LLM response before
      // persistence. Catches credential patterns the model may have
      // surfaced from context (legitimate or hallucinated) and length-caps
      // runaway output. We persist the sanitized version so any future
      // retrieval (chat history) returns the safe text. The streaming
      // SSE chunks already went out raw — that's a Phase-4 stretch
      // (chunk-level sanitization without breaking pattern boundaries).
      const validation = this.llmValidator.validate(rawFullContent);
      const fullContent = validation.sanitized;

      // 7. Send sources event
      if (searchResults.length > 0) {
        this.sendSSE(res, {
          type: SSEEventType.SOURCES,
          chunks: searchResults.map((r) => ({
            filePath: r.filePath,
            lines: `${r.lineStart}-${r.lineEnd}`,
            similarity: Math.round(r.similarity * 100) / 100,
          })),
        });
      }

      // 8. Save assistant message
      const assistantMsg = await this.sessionService.saveMessage(
        session.id,
        'assistant',
        fullContent,
        {
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          sourceChunks: searchResults.length > 0
            ? searchResults.map((r) => ({ filePath: r.filePath, lines: `${r.lineStart}-${r.lineEnd}`, similarity: r.similarity }))
            : undefined,
        },
      );

      // 9. Send done event
      this.sendSSE(res, {
        type: SSEEventType.DONE,
        sessionId: session.id,
        messageId: assistantMsg.id,
      });

      await this.recordTelemetry({
        source: 'chat',
        status: 'completed',
        repoId: primaryRepoId,
        sessionId,
        startedAt,
        firstTokenAt: telemetry.firstTokenAt,
        completedAt: telemetry.completedAt,
        latencyMs: telemetry.latencyMs,
        durationMs: telemetry.durationMs,
        promptTokens: telemetry.promptTokens,
        completionTokens: telemetry.completionTokens,
        totalTokens: telemetry.totalTokens,
        metadata: {
          toolCalls: toolCalls.length,
          provider: this.llmProvider,
        },
      });

      // Phase 9 / Workstream F: record actual token usage against org cap.
      const orgIdForUsage = currentOrgId();
      if (orgIdForUsage && (telemetry.promptTokens || telemetry.completionTokens)) {
        try {
          await this.tokenCap.recordUsage(
            orgIdForUsage,
            telemetry.promptTokens ?? 0,
            telemetry.completionTokens ?? 0,
          );
        } catch (err) {
          this.logger.warn(`recordUsage failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Chat error: ${errorMsg}`);
      this.sendSSE(res, { type: SSEEventType.ERROR, message: errorMsg });
      await this.recordTelemetry({
        source: 'chat',
        status: 'failed',
        repoId: primaryRepoId,
        sessionId,
        startedAt,
        firstTokenAt: telemetry?.firstTokenAt ?? null,
        completedAt: new Date(),
        latencyMs: telemetry?.latencyMs ?? null,
        durationMs: telemetry?.durationMs ?? Date.now() - startedAt.getTime(),
        promptTokens: telemetry?.promptTokens ?? null,
        completionTokens: telemetry?.completionTokens ?? null,
        totalTokens: telemetry?.totalTokens ?? null,
        metadata: {
          error: errorMsg,
          provider: this.llmProvider,
        },
      });
    } finally {
      res.end();
    }
  }

  /**
   * Build the messages array for the OpenAI API call.
   * Includes system prompt, session history, RAG context, and user message.
   */
  private async buildMessages(
    sessionId: string,
    userMessage: string,
    searchResults: SearchResult[],
    systemPrompt: string,
  ): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    // System prompt (dynamic, from RepoService.buildSystemPrompt)
    const prompt = systemPrompt + `\n\nCurrent date: ${new Date().toISOString().split('T')[0]}`;
    messages.push({ role: 'system', content: prompt });

    // Session history (last N messages)
    const history = await this.sessionService.getSessionHistory(sessionId, HISTORY_LIMIT);
    for (const msg of history) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    // RAG context injected as system message
    if (searchResults.length > 0) {
      const contextParts = searchResults.map(
        (r) =>
          `[File: ${r.filePath} | Lines: ${r.lineStart}-${r.lineEnd} | Similarity: ${Math.round(r.similarity * 100) / 100}]\n${r.chunkText}`,
      );
      messages.push({
        role: 'system',
        content: `Here are the most relevant code sections from the indexed codebases for this query:\n\n${contextParts.join('\n\n')}`,
      });
    }

    // User message
    messages.push({ role: 'user', content: userMessage });

    return messages;
  }

  /**
   * Stream the OpenAI response with agentic tool-call loop.
   * When finish_reason is 'tool_calls', executes tools and continues streaming.
   */
  private async streamWithToolLoop(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    res: Response,
  ): Promise<{
    fullContent: string;
    toolCalls: any[];
    metrics: {
      firstTokenAt: Date | null;
      completedAt: Date | null;
      durationMs: number | null;
      latencyMs: number | null;
      promptTokens: number | null;
      completionTokens: number | null;
      totalTokens: number | null;
    };
  }> {
    let fullContent = '';
    const allToolCalls: any[] = [];
    const currentMessages = [...messages];
    const startedAt = new Date();
    let firstTokenAt: Date | null = null;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let hasUsage = false;

    const maxIterations = this.llmProvider === 'local' ? 1 : 5;

    // Loop up to max iterations to prevent infinite tool-call chains
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (this.llmProvider === 'local') {
        const response = await createLocalChatCompletion({
          apiKey: this.configService.get<string>('OPENAI_API_KEY'),
          baseUrl: this.configService.get<string>('OPENAI_BASE_URL'),
          model: this.chatModel,
          messages: currentMessages.map((message) => ({
            role: message.role,
            content: 'content' in message ? message.content : '',
          })),
          temperature: 0.2,
          maxTokens: 2048,
        });

        const content = response.choices[0]?.message?.content ?? '';
        if (!firstTokenAt && content) {
          firstTokenAt = new Date();
        }
        if (content) {
          fullContent += content;
          this.sendSSE(res, { type: SSEEventType.CHUNK, content });
        }

        promptTokens = response.usage?.prompt_tokens ?? 0;
        completionTokens = response.usage?.completion_tokens ?? 0;
        totalTokens = response.usage?.total_tokens ?? 0;
        hasUsage = Boolean(response.usage);
        break;
      }

      // Phase 9 / Workstream F: guard against exceeding org token cap.
      const orgId = currentOrgId();
      if (orgId) {
        try { await this.tokenCap.guard(orgId); } catch (err) {
          this.logger.warn(`Token cap exceeded for org ${orgId}`);
          throw err;
        }
      }

      const generationSpan = otelTracer.startSpan('copilot.generation', {
        attributes: {
          'coderover.model': this.chatModel,
          'coderover.provider': this.llmProvider,
          'coderover.org': orgId ?? 'unknown',
        },
      });

      // Phase 4A: gate every outbound LLM call. Throws 503 immediately
      // if an operator has engaged LLM_KILL_SWITCH — request never
      // leaves the api process.
      this.llmKillSwitch.assertNotKilled();

      const stream = await this.openai.chat.completions.create({
        model: this.chatModel,
        messages: currentMessages,
        tools: this.mcpService.getToolsForOpenAI(),
        tool_choice: 'auto',
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 2048,
        temperature: 0.2,
      });

      let accumulatedContent = '';
      const pendingToolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
      let finishReason: string | null = null;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        finishReason = chunk.choices[0]?.finish_reason ?? finishReason;

        // Stream text content
        if (delta?.content) {
          if (!firstTokenAt) {
            firstTokenAt = new Date();
          }
          accumulatedContent += delta.content;
          this.sendSSE(res, { type: SSEEventType.CHUNK, content: delta.content });
        }

        const usage = (chunk as any).usage as
          | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
          | undefined;
        if (usage) {
          hasUsage = true;
          promptTokens += Number(usage.prompt_tokens) || 0;
          completionTokens += Number(usage.completion_tokens) || 0;
          totalTokens += Number(usage.total_tokens) || 0;
        }

        // Accumulate tool call deltas
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = pendingToolCalls.get(tc.index);
            if (existing) {
              existing.arguments += tc.function?.arguments ?? '';
            } else {
              pendingToolCalls.set(tc.index, {
                id: tc.id ?? '',
                name: tc.function?.name ?? '',
                arguments: tc.function?.arguments ?? '',
              });
            }
          }
        }
      }

      fullContent += accumulatedContent;

      generationSpan.setAttributes({
        'coderover.tokens.prompt': promptTokens,
        'coderover.tokens.completion': completionTokens,
        'coderover.tool_calls': pendingToolCalls.size,
        'coderover.finish_reason': finishReason ?? 'unknown',
      });
      generationSpan.end();

      // If no tool calls, we're done
      if (finishReason !== 'tool_calls' || pendingToolCalls.size === 0) {
        break;
      }

      // Execute tool calls
      const assistantMessage: OpenAI.Chat.ChatCompletionMessageParam = {
        role: 'assistant',
        content: accumulatedContent || null,
        tool_calls: [...pendingToolCalls.values()].map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
      currentMessages.push(assistantMessage);

      for (const [, tc] of pendingToolCalls) {
        let parsedArgs: Record<string, any> = {};
        try {
          parsedArgs = JSON.parse(tc.arguments);
        } catch {
          parsedArgs = {};
        }

        const toolResult = await this.mcpService.executeTool(tc.name, parsedArgs);
        allToolCalls.push(toolResult);

        // Send tool call SSE event
        this.sendSSE(res, {
          type: SSEEventType.TOOL_CALL,
          tool: tc.name,
          args: parsedArgs,
          result: toolResult.result ?? toolResult.error,
        });

        // Add tool result to messages for next iteration
        currentMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(toolResult.result ?? { error: toolResult.error }),
        } as OpenAI.Chat.ChatCompletionMessageParam);
      }
    }

    const completedAt = new Date();
    const durationMs = completedAt.getTime() - startedAt.getTime();
    const latencyMs = firstTokenAt ? firstTokenAt.getTime() - startedAt.getTime() : null;

    return {
      fullContent,
      toolCalls: allToolCalls,
      metrics: {
        firstTokenAt,
        completedAt,
        durationMs,
        latencyMs,
        promptTokens: hasUsage ? promptTokens : null,
        completionTokens: hasUsage ? completionTokens : null,
        totalTokens: hasUsage ? totalTokens : null,
      },
    };
  }

  /** Send a Server-Sent Event to the response */
  private sendSSE(res: Response, event: SSEEvent): void {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  private async recordTelemetry(params: {
    source: 'chat' | 'pr_review';
    status: 'completed' | 'failed';
    repoId: string | null;
    sessionId: string | null;
    startedAt: Date;
    firstTokenAt: Date | null;
    completedAt: Date | null;
    latencyMs: number | null;
    durationMs: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.dataSource.query(
        `
          INSERT INTO ai_request_metrics (
            source,
            status,
            repo_id,
            session_id,
            provider,
            model,
            started_at,
            first_token_at,
            completed_at,
            latency_ms,
            duration_ms,
            prompt_tokens,
            completion_tokens,
            total_tokens,
            metadata
          )
          VALUES (
            $1, $2, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb
          )
        `,
        [
          params.source,
          params.status,
          params.repoId,
          params.sessionId,
          this.llmProvider,
          this.chatModel,
          params.startedAt,
          params.firstTokenAt,
          params.completedAt,
          params.latencyMs,
          params.durationMs,
          params.promptTokens,
          params.completionTokens,
          params.totalTokens,
          JSON.stringify(params.metadata || {}),
        ],
      );
    } catch (err) {
      this.logger.warn(
        `Failed to persist chat telemetry: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
