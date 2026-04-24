import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import type { ReactNode } from 'react';

// Mock the repos API
vi.mock('../lib/api/repos', () => ({
  reposApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    deactivate: vi.fn(),
    hardDelete: vi.fn(),
    ingest: vi.fn(),
    status: vi.fn(),
  },
}));

import { useRepos, useRepo, useCreateRepo, useDeleteRepo, useIngestRepo } from './useRepos';
import { reposApi } from '../lib/api/repos';

const mockRepos = [
  { id: 'r1', fullName: 'org/repo1', label: 'Repo 1', branch: 'main', language: 'TypeScript', fileCount: 100, isActive: true },
  { id: 'r2', fullName: 'org/repo2', label: null, branch: 'develop', language: 'Python', fileCount: 50, isActive: false },
];

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

describe('useRepos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches and returns repository list', async () => {
    (reposApi.list as ReturnType<typeof vi.fn>).mockResolvedValue(mockRepos);

    const { result } = renderHook(() => useRepos(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(mockRepos);
    expect(reposApi.list).toHaveBeenCalledOnce();
  });

  it('handles fetch error gracefully', async () => {
    (reposApi.list as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useRepos(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('Network error');
  });
});

describe('useRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches a single repo by id', async () => {
    (reposApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockRepos[0]);

    const { result } = renderHook(() => useRepo('r1'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(mockRepos[0]);
    expect(reposApi.get).toHaveBeenCalledWith('r1');
  });

  it('does not fetch when id is undefined', () => {
    const { result } = renderHook(() => useRepo(undefined), { wrapper: createWrapper() });
    expect(result.current.fetchStatus).toBe('idle');
    expect(reposApi.get).not.toHaveBeenCalled();
  });
});

describe('useCreateRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a repo and invalidates cache', async () => {
    const newRepo = { id: 'r3', fullName: 'org/repo3', label: 'Repo 3', branch: 'main', language: null, fileCount: 0, isActive: true };
    (reposApi.create as ReturnType<typeof vi.fn>).mockResolvedValue(newRepo);

    const { result } = renderHook(() => useCreateRepo(), { wrapper: createWrapper() });

    result.current.mutate({ repoUrl: 'https://github.com/org/repo3', label: 'Repo 3' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(reposApi.create).toHaveBeenCalled();
    expect((reposApi.create as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({ repoUrl: 'https://github.com/org/repo3', label: 'Repo 3' });
  });
});

describe('useDeleteRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deactivates a repo', async () => {
    (reposApi.deactivate as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const { result } = renderHook(() => useDeleteRepo(), { wrapper: createWrapper() });

    result.current.mutate('r1');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(reposApi.deactivate).toHaveBeenCalled();
    expect((reposApi.deactivate as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('r1');
  });
});

describe('useIngestRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('triggers ingestion for a repo', async () => {
    (reposApi.ingest as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'started' });

    const { result } = renderHook(() => useIngestRepo(), { wrapper: createWrapper() });

    result.current.mutate('r1');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(reposApi.ingest).toHaveBeenCalled();
    expect((reposApi.ingest as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('r1');
  });
});
