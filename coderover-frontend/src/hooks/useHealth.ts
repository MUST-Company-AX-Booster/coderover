import { useQuery } from '@tanstack/react-query';
import { healthApi } from '../lib/api/health';

export function useHealth(autoRefresh = true) {
  return useQuery({
    queryKey: ['health'],
    queryFn: healthApi.check,
    refetchInterval: autoRefresh ? 30_000 : false,
  });
}
