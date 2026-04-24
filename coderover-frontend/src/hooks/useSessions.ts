import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { copilotApi } from '../lib/api/copilot';

export function useSessions() {
  return useQuery({
    queryKey: ['chat-sessions'],
    queryFn: copilotApi.getSessions,
  });
}

export function useDeleteSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: copilotApi.deleteSession,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['chat-sessions'] }),
  });
}
