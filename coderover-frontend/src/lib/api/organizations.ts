import { apiClient } from './client';
import type { OrgMembership } from '../../stores/orgStore';

export const organizationsApi = {
  list: () => apiClient.get<OrgMembership[]>('/organizations'),
  create: (body: { name: string; slug: string }) =>
    apiClient.post<OrgMembership>('/organizations', body),
  invite: (orgId: string, userId: string, role?: OrgMembership['role']) =>
    apiClient.post(`/organizations/${orgId}/members`, { orgId, userId, role }),
};
