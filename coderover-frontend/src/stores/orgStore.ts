import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface OrgMembership {
  id: string;
  name: string;
  slug: string;
  role: 'owner' | 'admin' | 'member';
}

interface OrgState {
  activeOrgId: string | null;
  memberships: OrgMembership[];
  setMemberships: (m: OrgMembership[]) => void;
  setActiveOrg: (orgId: string) => void;
  clear: () => void;
}

export const useOrgStore = create<OrgState>()(
  persist(
    set => ({
      activeOrgId: null,
      memberships: [],
      setMemberships: memberships => {
        set(state => ({
          memberships,
          activeOrgId: state.activeOrgId && memberships.some(m => m.id === state.activeOrgId)
            ? state.activeOrgId
            : memberships[0]?.id ?? null,
        }));
      },
      setActiveOrg: activeOrgId => set({ activeOrgId }),
      clear: () => set({ activeOrgId: null, memberships: [] }),
    }),
    { name: 'coderover-org' },
  ),
);
