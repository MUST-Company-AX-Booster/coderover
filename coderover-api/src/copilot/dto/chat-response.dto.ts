/** SSE event types for the streaming chat response */
export enum SSEEventType {
  CHUNK = 'chunk',
  TOOL_CALL = 'tool_call',
  SOURCES = 'sources',
  DONE = 'done',
  ERROR = 'error',
}

export interface SSEEvent {
  type: SSEEventType;
  content?: string;
  tool?: string;
  args?: Record<string, any>;
  result?: any;
  chunks?: Array<{ filePath: string; lines: string; similarity: number }>;
  sessionId?: string;
  messageId?: string;
  message?: string;
}
