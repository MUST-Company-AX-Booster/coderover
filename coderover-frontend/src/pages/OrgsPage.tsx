import { useEffect, useState } from 'react';
import { organizationsApi } from '../lib/api/organizations';
import { apiClient } from '../lib/api/client';
import type { OrgMembership } from '../stores/orgStore';
import { useOrgStore } from '../stores/orgStore';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Eyebrow } from '@/components/brand';

interface OrgWithUsage extends OrgMembership {
  monthlyTokenCap?: number | null;
  usage?: { prompt: number; completion: number };
}

/**
 * Phase 9 / Workstream C + F — Organization admin page.
 *
 * Shows the orgs this user belongs to, the active org, and for owners:
 * a form to create a new org and (scaffold) edit the monthly token cap.
 * Invitation flow uses POST /organizations/:orgId/members.
 */
export default function OrgsPage() {
  const { activeOrgId } = useOrgStore();
  const [orgs, setOrgs] = useState<OrgWithUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [inviteUserId, setInviteUserId] = useState('');
  const [busy, setBusy] = useState(false);

  async function reload() {
    setLoading(true);
    try {
      const list = await organizationsApi.list();
      setOrgs(list as OrgWithUsage[]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { reload(); }, []);

  async function handleCreate() {
    if (!newName || !newSlug) return;
    setBusy(true);
    try {
      await organizationsApi.create({ name: newName, slug: newSlug });
      setNewName(''); setNewSlug('');
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  async function handleInvite(orgId: string) {
    if (!inviteUserId) return;
    setBusy(true);
    try {
      await organizationsApi.invite(orgId, inviteUserId);
      setInviteUserId('');
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  async function handleSetCap(orgId: string, capRaw: string) {
    const cap = capRaw === '' ? null : Number(capRaw);
    if (cap !== null && (!Number.isFinite(cap) || cap < 0)) return;
    setBusy(true);
    try {
      await apiClient.post(`/organizations/${orgId}/cap`, { monthlyTokenCap: cap });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  if (loading) return <div className="p-6 text-muted-foreground">Loading organizations…</div>;

  return (
    <div className="p-6 space-y-8 max-w-4xl">
      <div className="flex flex-col gap-2">
        <Eyebrow prefix>Crews</Eyebrow>
        <h1 className="text-2xl font-normal tracking-tight">
          Organizations.{' '}
          <span className="text-muted-foreground">Members, invites, and per-crew spend caps.</span>
        </h1>
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded">{error}</div>}

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Your memberships</h2>
        {orgs.length === 0 ? (
          <p className="text-sm text-muted-foreground">You are not a member of any organization.</p>
        ) : (
          <div className="border rounded divide-y">
            {orgs.map(o => (
              <div key={o.id} className="p-3 flex items-center justify-between">
                <div>
                  <div className="font-medium">
                    {o.name}{' '}
                    {o.id === activeOrgId && (
                      <span className="ml-1 text-xs uppercase tracking-wider text-primary-600">Active</span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    slug: {o.slug} &middot; role: {o.role}
                  </div>
                </div>
                {(o.role === 'owner' || o.role === 'admin') && (
                  <div className="flex items-center gap-2">
                    <Input
                      placeholder="cap (tokens/mo)"
                      defaultValue={o.monthlyTokenCap ?? ''}
                      className="w-36 text-xs"
                      onBlur={e => handleSetCap(o.id, e.currentTarget.value)}
                    />
                    <Input
                      placeholder="user id to invite"
                      value={inviteUserId}
                      onChange={e => setInviteUserId(e.target.value)}
                      className="w-56 text-xs"
                    />
                    <Button size="sm" disabled={busy || !inviteUserId} onClick={() => handleInvite(o.id)}>
                      Invite
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Create a new organization</h2>
        <div className="flex items-center gap-2 max-w-xl">
          <Input placeholder="Name" value={newName} onChange={e => setNewName(e.target.value)} />
          <Input placeholder="slug" value={newSlug} onChange={e => setNewSlug(e.target.value)} />
          <Button disabled={busy || !newName || !newSlug} onClick={handleCreate}>
            Create
          </Button>
        </div>
      </section>
    </div>
  );
}
