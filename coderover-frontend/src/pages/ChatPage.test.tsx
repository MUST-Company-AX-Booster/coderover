import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ChatPage from './ChatPage';

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Mock MarkdownRenderer
vi.mock('../components/MarkdownRenderer', () => ({
  default: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}));

// Mock authStore exports
vi.mock('../stores/authStore', () => ({
  apiClient: {
    get: vi.fn().mockResolvedValue([]),
    post: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(undefined),
  },
  getAuthHeaders: vi.fn().mockReturnValue({ Authorization: 'Bearer test-token' }),
}));

function renderChatPage(sessionId?: string) {
  const path = sessionId ? `/chat/${sessionId}` : '/chat';
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ChatPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the empty state with prompt suggestions', () => {
    renderChatPage();

    expect(screen.getByText(/Ask anything\./i)).toBeInTheDocument();
    expect(screen.getByText('How is auth handled?')).toBeInTheDocument();
    expect(screen.getByText('Why did we drop redis?')).toBeInTheDocument();
    expect(screen.getByText('Where is retry logic for payments?')).toBeInTheDocument();
  });

  it('renders the chat input and send button', () => {
    renderChatPage();

    const textarea = screen.getByPlaceholderText(/Ask the archive anything/i);
    expect(textarea).toBeInTheDocument();
    expect(textarea).toBeEnabled();
  });

  it('renders "new session" header when no session is active', () => {
    renderChatPage();
    expect(screen.getByText(/new session/i)).toBeInTheDocument();
  });

  it('renders "No sessions yet" when session list is empty', () => {
    renderChatPage();
    expect(screen.getByText('No sessions yet')).toBeInTheDocument();
  });

  it('fills input when a suggestion chip is clicked', () => {
    renderChatPage();

    fireEvent.click(screen.getByText('How is auth handled?'));

    const textarea = screen.getByPlaceholderText(/Ask the archive anything/i) as HTMLTextAreaElement;
    expect(textarea.value).toBe('How is auth handled?');
  });

  it('has a disabled send button when input is empty', () => {
    renderChatPage();

    // Find the send button — it's the only disabled button in the input area
    const buttons = screen.getAllByRole('button');
    const disabledButtons = buttons.filter((btn) => (btn as HTMLButtonElement).disabled);
    expect(disabledButtons.length).toBeGreaterThanOrEqual(1);
  });

  it('shows Sessions and Repositories sidebar sections', () => {
    renderChatPage();

    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('Repositories')).toBeInTheDocument();
  });
});
