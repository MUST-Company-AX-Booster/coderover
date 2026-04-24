import { useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { reposApi } from '../lib/api/repos';
import { useEventsSocket } from './useEventsSocket';

export function useRepos() {
  return useQuery({
    queryKey: ['repos'],
    queryFn: reposApi.list,
  });
}

export function useRepo(id: string | undefined) {
  return useQuery({
    queryKey: ['repos', id],
    queryFn: () => reposApi.get(id!),
    enabled: !!id,
  });
}

export function useRepoStatus(id: string | undefined) {
  const qc = useQueryClient();
  const handler = useCallback(() => {
    // Phase 9 / Workstream A: server pushed an ingest.progress event; refetch.
    qc.invalidateQueries({ queryKey: ['repos', id, 'status'] });
    qc.invalidateQueries({ queryKey: ['repos', id] });
  }, [qc, id]);
  useEventsSocket(id ? `repo:${id}` : null, 'ingest.progress', handler);

  return useQuery({
    queryKey: ['repos', id, 'status'],
    queryFn: () => reposApi.status(id!),
    enabled: !!id,
    // Fallback polling stays as a safety net if the socket is unavailable,
    // but at a much lower cadence (10s vs 2s) since events are now primary.
    refetchInterval: (query) => {
      const status = query.state.data?.syncStatus ?? query.state.data?.status;
      return status === 'syncing' ? 10_000 : false;
    },
  });
}

export function useCreateRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: reposApi.create,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repos'] }),
  });
}

export function useUpdateRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof reposApi.update>[1] }) =>
      reposApi.update(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repos'] }),
  });
}

export function useIngestRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => reposApi.ingest(id),
    onSuccess: (_data, id) => qc.invalidateQueries({ queryKey: ['repos', id, 'status'] }),
  });
}

export function useDeleteRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: reposApi.deactivate,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repos'] }),
  });
}

export function useHardDeleteRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: reposApi.hardDelete,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repos'] }),
  });
}
