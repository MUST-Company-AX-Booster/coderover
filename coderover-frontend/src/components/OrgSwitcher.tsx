import { useEffect, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useOrgStore } from '../stores/orgStore';
import { organizationsApi } from '../lib/api/organizations';
import { apiClient } from '../lib/api/client';

/**
 * Phase 9 / Workstream C — org switcher for the header.
 *
 * On mount: fetches memberships, hydrates orgStore.
 * On change: POSTs /auth/switch-org, updates authStore token, updates orgStore active.
 */
export function OrgSwitcher() {
  const { token } = useAuthStore();
  const { activeOrgId, memberships, setMemberships, setActiveOrg } = useOrgStore();
  const setToken = useAuthStore(s => s.setToken);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    organizationsApi
      .list()
      .then(list => setMemberships(list))
      .catch(() => { /* no-op: unauthorized or no orgs yet */ });
  }, [token, setMemberships]);

  if (!memberships.length) return null;

  const current = memberships.find(m => m.id === activeOrgId) ?? memberships[0];

  async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value;
    if (next === activeOrgId) return;
    setBusy(true);
    try {
      const res = await apiClient.post<{ accessToken: string; orgId: string }>(
        '/auth/switch-org',
        { orgId: next },
      );
      if (res?.accessToken) setToken(res.accessToken);
      setActiveOrg(next);
      // Full reload of cached data to re-run with new org scope
      window.location.reload();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('switch-org failed', err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <select
      value={current.id}
      onChange={handleChange}
      disabled={busy}
      title={`Active org: ${current.name} (${current.role})`}
      className="text-xs border rounded px-2 py-1 bg-background"
    >
      {memberships.map(m => (
        <option key={m.id} value={m.id}>
          {m.name}
        </option>
      ))}
    </select>
  );
}
