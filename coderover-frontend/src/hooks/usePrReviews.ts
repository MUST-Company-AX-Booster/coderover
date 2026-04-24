import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { prReviewApi } from '../lib/api/pr-review';

export function usePrReviews(limit = 25) {
  return useQuery({
    queryKey: ['pr-reviews', limit],
    queryFn: () => prReviewApi.list(limit),
  });
}

export function useWebhookEvents(limit = 25) {
  return useQuery({
    queryKey: ['webhook-events', limit],
    queryFn: () => prReviewApi.webhookEvents(limit),
  });
}

export function useTriggerReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: prReviewApi.trigger,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pr-reviews'] }),
  });
}
