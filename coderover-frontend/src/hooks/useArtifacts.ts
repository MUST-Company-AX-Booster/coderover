import { useQuery } from '@tanstack/react-query';
import { artifactsApi } from '../lib/api/artifacts';

export function useArtifacts(repoId?: string) {
  return useQuery({
    queryKey: ['artifacts', repoId],
    queryFn: () => artifactsApi.list(repoId),
  });
}
