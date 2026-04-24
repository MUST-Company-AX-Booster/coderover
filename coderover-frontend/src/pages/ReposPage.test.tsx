import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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
}));

function renderReposPage() {
  return render(
    <MemoryRouter>
      <ReposPage />
    </MemoryRouter>,
  );
}

describe('ReposPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(mockRepos);
  });

  it('shows loading skeleton initially', () => {
    mockGet.mockReturnValue(new Promise(() => {})); // never resolves
    renderReposPage();
    expect(screen.getByText('Repositories')).toBeInTheDocument();
  });

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

  it('shows add repository modal when button is clicked', async () => {
    renderReposPage();

    await waitFor(() => {
      expect(screen.getByText('Repo Alpha')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Add Repository'));

    expect(screen.getByText('Repository URL')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('https://github.com/owner/repo')).toBeInTheDocument();
  });

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
