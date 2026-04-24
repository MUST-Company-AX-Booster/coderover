import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000, // 30s — data is fresh for 30s before refetching
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
