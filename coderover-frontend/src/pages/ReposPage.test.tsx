import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ReposPage from './ReposPage';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const mockRepos = [
  { id: 'r1', fullName: 'org/repo-alpha', label: 'Repo Alpha', branch: 'main', language: 'TypeScript', fileCount: 120, isActive: true },
  { id: 'r2', fullName: 'org/repo-beta', label: null, branch: 'develop', language: null, fileCount: 0, isActive: true },
];

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPut = vi.fn();
const mockDelete = vi.fn();

vi.mock('../stores/authStore', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    put: (...args: unknown[]) => mockPut(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
  useAuthStore: (selector: (state: { user: { id: string; orgId: string } | null }) => unknown) =>
    selector({ user: { id: 'test-user', orgId: 'test-org' } }),
}));

function renderReposPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ReposPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ReposPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(mockRepos);
  });

  // TODO: re-add a loading-skeleton assertion targeting the Phase 12
  // Fleet Registry / "Your Repositories" shell once we stabilize the
  // initial-render element IDs.

  it('renders repository list after loading', async () => {
    renderReposPage();

    await waitFor(() => {
      expect(screen.getByText('Repo Alpha')).toBeInTheDocument();
    });
    // fullName appears twice per repo (link + external link), so use getAllByText
    expect(screen.getAllByText('org/repo-alpha').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('org/repo-beta').length).toBeGreaterThanOrEqual(1);
  });

  it('displays stat cards with correct counts', async () => {
    renderReposPage();

    await waitFor(() => {
      expect(screen.getByText('Total Repositories')).toBeInTheDocument();
    });

    // 2 total repos — text "2" may appear in multiple stat cards, just check it exists
    const totalCard = screen.getByText('Total Repositories').closest('.card');
    expect(totalCard).toBeTruthy();
    expect(totalCard!.textContent).toContain('2');
  });

  // TODO: replace this test with one that drives the Phase 10
  // RepoCreateDialog flow (OAuth tab + Manual tab) instead of the
  // legacy inline form that was removed.

  it('shows empty state when no repos exist', async () => {
    mockGet.mockResolvedValue([]);
    renderReposPage();

    await waitFor(() => {
      expect(screen.getByText('No repositories yet')).toBeInTheDocument();
    });
  });

  it('displays branch info for each repo', async () => {
    renderReposPage();

    await waitFor(() => {
      expect(screen.getByText('main')).toBeInTheDocument();
      expect(screen.getByText('develop')).toBeInTheDocument();
    });
  });
});
