import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { Send, FileText, RefreshCw, MessageSquare, Trash2, Plus } from 'lucide-react';
import { apiClient, getAuthHeaders } from '../stores/authStore';
import { toast } from 'sonner';
import MarkdownRenderer from '../components/MarkdownRenderer';
import ConfidenceMark from '../components/ConfidenceMark';
import type { SourceCitation, CitationConfidenceTag } from '../lib/api/copilot';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Eyebrow } from '@/components/brand';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  sources?: SourceCitation[];
  toolCalls?: Array<{ tool: string; args: unknown; result: unknown }>;
}

/**
 * Normalize a raw citation from the stream (which may be in the legacy
 * `{ filePath, lines, similarity }` shape or the B2-enriched shape) into a
 * `SourceCitation`. Missing `confidence` defaults to AMBIGUOUS — per plan,
 * untagged rows are treated conservatively so the "why?" affordance is
 * always reachable.
 */
const VALID_TAGS: CitationConfidenceTag[] = ['EXTRACTED', 'INFERRED', 'AMBIGUOUS'];

function normalizeCitation(raw: unknown, idx: number): SourceCitation {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rawTag = typeof r.confidence === 'string' ? r.confidence.toUpperCase() : '';
  const confidence: CitationConfidenceTag = VALID_TAGS.includes(rawTag as CitationConfidenceTag)
    ? (rawTag as CitationConfidenceTag)
    : 'AMBIGUOUS';

  const scoreRaw =
    typeof r.confidenceScore === 'number' ? r.confidenceScore :
    typeof r.confidence_score === 'number' ? r.confidence_score :
    null;

  const lineStart =
    typeof r.lineStart === 'number' ? r.lineStart :
    typeof r.line_start === 'number' ? r.line_start :
    null;
  const lineEnd =
    typeof r.lineEnd === 'number' ? r.lineEnd :
    typeof r.line_end === 'number' ? r.line_end :
    null;

  const filePath =
    typeof r.filePath === 'string' ? r.filePath :
    typeof r.file_path === 'string' ? r.file_path :
    '';

  const id = typeof r.id === 'string' ? r.id : `cite-${idx}`;
  const similarity = typeof r.similarity === 'number' ? r.similarity : undefined;
  const lines = typeof r.lines === 'string' ? r.lines : undefined;

  return {
    id,
    filePath,
    lineStart,
    lineEnd,
    lines,
    similarity,
    confidence,
    confidenceScore: scoreRaw,
  };
}

function formatLineRange(citation: SourceCitation): string | null {
  if (citation.lineStart != null && citation.lineEnd != null) {
    return citation.lineStart === citation.lineEnd
      ? `L${citation.lineStart}`
      : `L${citation.lineStart}-${citation.lineEnd}`;
  }
  if (citation.lineStart != null) return `L${citation.lineStart}`;
  if (citation.lines) return `L${citation.lines}`;
  return null;
}

interface ChatSession {
  id: string;
  title: string;
  repoIds?: string[] | null;
  createdAt: string;
  updatedAt: string;
}

interface Repository {
  id: string;
  fullName: string;
  label: string;
  branch: string;
  isActive: boolean;
}

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

interface RepoApiResponse {
  id: string;
  fullName: string;
  label: string | null;
  branch: string;
  isActive: boolean;
}

const normalizeRepo = (repo: RepoApiResponse): Repository => ({
  id: repo.id,
  fullName: repo.fullName,
  label: repo.label ?? repo.fullName,
  branch: repo.branch,
  isActive: repo.isActive,
});

export default function ChatPage() {
  const { sessionId } = useParams<{ sessionId?: string }>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const [currentSession, setCurrentSession] = useState<ChatSession | null>(null);
  const [isLoadingRepositories, setIsLoadingRepositories] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => { scrollToBottom(); }, [messages, scrollToBottom]);

  const loadSessions = useCallback(async () => {
    try {
      const data = await apiClient.get<ChatSession[]>('/copilot/sessions');
      setSessions(data);
      return data;
    } catch (error) {
      console.error('Failed to load sessions:', error);
      return [];
    }
  }, []);

  const loadRepositories = useCallback(async () => {
    try {
      setIsLoadingRepositories(true);
      const data = await apiClient.get<RepoApiResponse[]>('/repos');
      setRepositories(data.map(normalizeRepo));
    } catch (error) {
      console.error('Failed to load repositories:', error);
    } finally {
      setIsLoadingRepositories(false);
    }
  }, []);

  const loadSessionHistory = useCallback(async (id: string) => {
    try {
      const data = await apiClient.get<Array<Record<string, unknown>>>(
        `/copilot/sessions/${id}/history`,
      );
      const normalized: Message[] = data.map((raw) => {
        const rawSources = raw.sources ?? raw.sourceChunks;
        const sources = Array.isArray(rawSources)
          ? rawSources.map((c, i) => normalizeCitation(c, i))
          : undefined;
        return {
          id: String(raw.id ?? ''),
          role: (raw.role as Message['role']) ?? 'assistant',
          content: String(raw.content ?? ''),
          timestamp: String(raw.timestamp ?? raw.createdAt ?? new Date().toISOString()),
          sources,
          toolCalls: raw.toolCalls as Message['toolCalls'],
        };
      });
      setMessages(normalized);
    } catch (error) {
      console.error('Failed to load session history:', error);
      toast.error('Failed to load chat history');
    }
  }, []);

  useEffect(() => {
    loadSessions();
    loadRepositories();
    if (sessionId) loadSessionHistory(sessionId);
  }, [loadRepositories, loadSessionHistory, loadSessions, sessionId]);

  const createNewSession = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsStreaming(false);
    setCurrentSession(null);
    setMessages([]);
    window.history.replaceState({}, '', '/chat');
    textareaRef.current?.focus();
  };

  useEffect(() => () => { abortControllerRef.current?.abort(); }, []);

  useEffect(() => {
    if (!sessionId || !isUuid(sessionId)) return;
    const match = sessions.find((s) => s.id === sessionId) ?? null;
    setCurrentSession(match);
    if (match?.repoIds?.length) setSelectedRepos(match.repoIds);
  }, [sessionId, sessions]);

  const sendMessage = async () => {
    if (!inputMessage.trim() || isLoading || isStreaming) return;

    const userMessage: Message = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: inputMessage,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputMessage('');
    setIsLoading(true);
    setIsStreaming(true);

    // Auto-resize textarea back
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    try {
      abortControllerRef.current?.abort();
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      let assistantMessage = '';
      const currentMessageId = `msg-${Date.now()}`;

      const payload: Record<string, unknown> = { message: inputMessage, stream: true };
      if (currentSession?.id && isUuid(currentSession.id)) payload.sessionId = currentSession.id;
      if (selectedRepos.length > 0) payload.repoIds = selectedRepos;

      const response = await fetch(`${API_BASE_URL}/copilot/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify(payload),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        try {
          const parsed = JSON.parse(errorText) as { message?: string };
          throw new Error(parsed.message || 'Chat request failed');
        } catch { throw new Error(errorText || 'Chat request failed'); }
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('Streaming not supported');

      const decoder = new TextDecoder();
      let buffer = '';

      const handleEventData = async (data: unknown) => {
        if (!data || typeof data !== 'object') return;
        const type = (data as Record<string, unknown>).type;

        if (type === 'chunk') {
          const content = (data as Record<string, unknown>).content;
          if (typeof content === 'string') {
            assistantMessage += content;
            setMessages((prev) => {
              const newMessages = [...prev];
              const lastMessage = newMessages[newMessages.length - 1];
              if (lastMessage?.role === 'assistant' && lastMessage.id === currentMessageId) {
                lastMessage.content = assistantMessage;
              } else {
                newMessages.push({ id: currentMessageId, role: 'assistant', content: assistantMessage, timestamp: new Date().toISOString() });
              }
              return newMessages;
            });
          }
          return;
        }
        if (type === 'sources') {
          const chunks = (data as Record<string, unknown>).chunks;
          if (Array.isArray(chunks)) {
            const normalized = chunks.map((c, i) => normalizeCitation(c, i));
            setMessages((prev) => {
              const newMessages = [...prev];
              const lastMessage = newMessages[newMessages.length - 1];
              if (lastMessage?.role === 'assistant') lastMessage.sources = normalized;
              return newMessages;
            });
          }
          return;
        }
        if (type === 'done') {
          setIsStreaming(false);
          abortControllerRef.current = null;
          const newSessionId = (data as Record<string, unknown>).sessionId;
          if (typeof newSessionId === 'string' && isUuid(newSessionId)) {
            window.history.replaceState({}, '', `/chat/${newSessionId}`);
            const nextSessions = await loadSessions();
            setCurrentSession(nextSessions.find((s) => s.id === newSessionId) ?? null);
          } else { await loadSessions(); }
          return;
        }
        if (type === 'error') {
          toast.error(typeof (data as Record<string, unknown>).message === 'string' ? (data as Record<string, unknown>).message as string : 'Chat error');
          setIsStreaming(false);
          abortControllerRef.current = null;
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          const lines = part.split('\n');
          const dataLines: string[] = [];
          for (const line of lines) { if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart()); }
          const rawData = dataLines.join('\n').trim();
          if (!rawData) continue;
          try { await handleEventData(JSON.parse(rawData)); } catch { await handleEventData({ type: 'chunk', content: rawData }); }
        }
      }
      setIsStreaming(false);
      abortControllerRef.current = null;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') { setIsStreaming(false); }
      else { console.error('Failed to send message:', error); toast.error('Failed to send message'); setIsStreaming(false); }
      setIsLoading(false);
    } finally { setIsLoading(false); }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const deleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await apiClient.delete(`/copilot/sessions/${id}`);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (currentSession?.id === id) createNewSession();
      toast.success('Session deleted');
    } catch { toast.error('Failed to delete session'); }
  };

  const toggleRepoSelection = (repoId: string) => {
    setSelectedRepos((prev) => prev.includes(repoId) ? prev.filter((id) => id !== repoId) : [...prev, repoId]);
  };

  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputMessage(e.target.value);
    // Auto-grow
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  };

  return (
    <div className="flex h-[calc(100vh-7.5rem)] overflow-hidden rounded-xl border border-border bg-card">
      {/* ── Sidebar ── */}
      {sidebarOpen && (
        <div className="w-64 shrink-0 border-r border-border flex flex-col bg-card">
          {/* Sessions */}
          <div className="p-3 border-b border-border">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Sessions</span>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={createNewSession} title="New chat">
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="space-y-0.5 max-h-[40vh] overflow-y-auto">
              {sessions.length === 0 && (
                <p className="text-xs text-muted-foreground px-2 py-3 text-center">No sessions yet</p>
              )}
              {sessions.map((session) => (
                <div
                  key={session.id}
                  className={`group relative rounded-lg text-sm transition-colors ${
                    currentSession?.id === session.id
                      ? 'bg-primary-500/10 text-primary-600'
                      : 'hover:bg-accent text-foreground'
                  }`}
                >
                  <button
                    onClick={() => {
                      setCurrentSession(session);
                      if (session.repoIds?.length) setSelectedRepos(session.repoIds);
                      window.history.replaceState({}, '', `/chat/${session.id}`);
                      loadSessionHistory(session.id);
                    }}
                    className="w-full text-left px-2.5 py-2"
                  >
                    <div className="font-medium truncate pr-6 text-[13px]">{session.title}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {new Date(session.updatedAt).toLocaleDateString()}
                    </div>
                  </button>
                  <button
                    onClick={(e) => deleteSession(session.id, e)}
                    className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all"
                    title="Delete"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Repositories */}
          <div className="p-3 flex-1 overflow-y-auto">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 block">
              Repositories
            </span>
            <div className="space-y-1">
              {isLoadingRepositories && <p className="text-xs text-muted-foreground py-2">Loading...</p>}
              {!isLoadingRepositories && repositories.length === 0 && (
                <p className="text-xs text-muted-foreground py-2">No repositories yet</p>
              )}
              {repositories.map((repo) => (
                <label
                  key={repo.id}
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer transition-colors hover:bg-accent ${
                    selectedRepos.includes(repo.id) ? 'bg-primary-500/5' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedRepos.includes(repo.id)}
                    onChange={() => toggleRepoSelection(repo.id)}
                    disabled={!repo.isActive}
                    className="rounded border-border text-primary-500 focus:ring-primary-500 h-3.5 w-3.5"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium truncate">{repo.label}</div>
                    <div className="text-[11px] text-muted-foreground truncate">{repo.branch}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Chat Area ── */}
      <div className="flex-1 flex min-w-0 flex-col">
        {/* Chat header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5 bg-card">
          <div className="flex items-center gap-3 min-w-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={() => setSidebarOpen(!sidebarOpen)}
            >
              <MessageSquare className="h-3.5 w-3.5" />
            </Button>
            <div className="min-w-0">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] truncate text-muted-foreground">
                <span aria-hidden>§ </span>
                {currentSession?.title || 'new session'}
              </h2>
              {selectedRepos.length > 0 ? (
                <div className="flex items-center gap-1 mt-0.5">
                  {selectedRepos.slice(0, 2).map((id) => (
                    <Badge key={id} variant="secondary" className="text-[10px] h-4 px-1.5">
                      {repositories.find((r) => r.id === id)?.label || id.slice(0, 8)}
                    </Badge>
                  ))}
                  {selectedRepos.length > 2 && (
                    <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
                      +{selectedRepos.length - 2}
                    </Badge>
                  )}
                </div>
              ) : repositories.length > 0 ? (
                <p className="font-mono text-[11px] text-destructive">[archive] no repo scoped · select one for grounded answers</p>
              ) : null}
            </div>
          </div>
          {isStreaming && (
            <div className="flex items-center gap-1.5 font-mono text-xs text-accent">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              <span>[archive] querying...</span>
            </div>
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-6">
              <div className="mb-5">
                <Eyebrow prefix>Archive · Decision Memory</Eyebrow>
              </div>
              <h3 className="text-xl font-normal mb-1">
                Ask anything.{' '}
                <span className="text-muted-foreground">The rover remembers.</span>
              </h3>
              <p className="font-mono text-xs text-muted-foreground max-w-md leading-relaxed">
                [archive] grounds every answer in your indexed code and every decision your team has logged.
              </p>
              <div className="flex flex-wrap justify-center gap-2 mt-6">
                {['Why did we drop redis?', 'Where is retry logic for payments?', 'How is auth handled?'].map((q) => (
                  <button
                    key={q}
                    onClick={() => { setInputMessage(q); textareaRef.current?.focus(); }}
                    className="border border-border px-3 py-1.5 font-mono text-xs text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground transition-colors"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="px-4 sm:px-6 py-4 space-y-5 font-mono text-sm leading-[1.65]">
              {messages.map((message) => (
                <div key={message.id} className="flex flex-col gap-1.5">
                  {message.role === 'user' ? (
                    <div className="flex gap-2">
                      <span className="select-none text-muted-foreground shrink-0" aria-hidden>$</span>
                      <div className="whitespace-pre-wrap text-foreground min-w-0">{message.content}</div>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <span className="select-none text-muted-foreground shrink-0 pt-[1px]" aria-hidden>[archive]</span>
                      <div className="flex-1 min-w-0 font-sans text-foreground">
                        <MarkdownRenderer content={message.content} />
                      </div>
                    </div>
                  )}

                  {/* Sources */}
                  {message.sources && message.sources.length > 0 && (
                    <div className="ml-[4.5rem] mt-1 border-l border-border pl-3 space-y-1">
                      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                        <span aria-hidden>§ </span>sources
                      </p>
                      <ul className="space-y-1">
                        {message.sources.map((source) => {
                          const lineRange = formatLineRange(source);
                          const similarityPct =
                            typeof source.similarity === 'number' ? Math.round(source.similarity * 100) : null;
                          return (
                            <li
                              key={source.id}
                              className="flex flex-col gap-0.5 font-mono text-[12px]"
                              data-testid="chat-citation"
                            >
                              <div className="flex items-center gap-1.5 min-w-0">
                                <FileText className="h-3 w-3 text-muted-foreground shrink-0" aria-hidden />
                                <span className="truncate text-foreground" title={source.filePath}>
                                  {source.filePath}
                                </span>
                                {lineRange && (
                                  <span className="text-muted-foreground shrink-0">{lineRange}</span>
                                )}
                                {similarityPct !== null && (
                                  <span className="ml-auto shrink-0 text-accent tabular-nums">
                                    {similarityPct}%
                                  </span>
                                )}
                              </div>
                              <ConfidenceMark
                                tag={source.confidence}
                                score={source.confidenceScore}
                                surface="chat"
                              />
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}

                  <span className="ml-[4.5rem] font-mono text-[10px] text-muted-foreground/70">
                    {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              ))}

              {isLoading && !isStreaming && (
                <div className="flex gap-2">
                  <span className="select-none text-muted-foreground shrink-0" aria-hidden>[archive]</span>
                  <div className="flex items-center gap-1.5 pt-1">
                    <span className="block h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
                    <span className="block h-1.5 w-1.5 rounded-full bg-accent animate-pulse [animation-delay:0.2s]" />
                    <span className="block h-1.5 w-1.5 rounded-full bg-accent animate-pulse [animation-delay:0.4s]" />
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input */}
        <div className="border-t border-border bg-card p-3 sm:p-4">
          <div className="flex gap-2 items-end">
            <div className="flex-1 relative">
              <textarea
                ref={textareaRef}
                value={inputMessage}
                onChange={handleTextareaInput}
                onKeyDown={handleKeyPress}
                placeholder="Ask the archive anything. Try: 'why did we drop redis?'"
                className="w-full resize-none rounded-xl border border-border bg-background px-4 py-2.5 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-ring/20 focus:border-ring placeholder:text-muted-foreground"
                rows={1}
                disabled={isLoading}
                style={{ minHeight: '42px', maxHeight: '200px' }}
              />
            </div>
            <Button
              onClick={sendMessage}
              disabled={!inputMessage.trim() || isLoading}
              size="icon"
              className="h-[42px] w-[42px] shrink-0 rounded-xl"
            >
              <Send className={`h-4 w-4 ${isStreaming ? 'animate-pulse' : ''}`} />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
