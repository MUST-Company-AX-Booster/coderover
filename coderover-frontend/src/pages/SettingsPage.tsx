import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { apiClient } from '../stores/authStore';
import { toast } from 'sonner';
import { useThemeStore } from '../stores/themeStore';
import { Eyebrow } from '@/components/brand';
import {
  Palette,
  Server,
  Brain,
  Github,
  Wrench,
  ClipboardList,
  ChevronRight,
} from 'lucide-react';

/* ───────────── Types ───────────── */

interface ManagedSetting {
  key: string;
  value: string | number | boolean | null;
  isSecret: boolean;
  isSet?: boolean;
  version: number;
  updatedAt: string;
}

interface SettingAuditRecord {
  id: string;
  key: string;
  previousValue: string | number | boolean | null;
  nextValue: string | number | boolean | null;
  version: number;
  reason: string;
  updatedBy: string;
  updatedAt: string;
}

interface LlmConfig {
  provider: string;
  baseUrl: string;
  chatModel: string;
  embeddingModel: string;
  embeddingDimensions: number;
  openaiApiKeySet: boolean;
}

interface GitHubRepo {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  updatedAt: string;
}

interface McpToolCatalog {
  name: string;
  description: string;
  parameters: Array<{
    name: string;
    type: string;
    description: string;
    required: boolean;
  }>;
}

interface McpHistoryItem {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs: number;
  createdAt: string;
}

type TabId = 'preferences' | 'admin' | 'llm' | 'github' | 'mcp' | 'audit';

const tabs: { id: TabId; label: string; icon: typeof Palette }[] = [
  { id: 'preferences', label: 'Preferences', icon: Palette },
  { id: 'admin', label: 'Admin Config', icon: Server },
  { id: 'llm', label: 'LLM Config', icon: Brain },
  { id: 'github', label: 'GitHub', icon: Github },
  { id: 'mcp', label: 'MCP Tools', icon: Wrench },
  { id: 'audit', label: 'Audit Log', icon: ClipboardList },
];

/* ───────────── Tab Components ───────────── */

function PreferencesTab({ apiUrl }: { apiUrl: string }) {
  const { theme, setTheme } = useThemeStore();

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium text-foreground mb-2">Theme</h3>
        <select value={theme} onChange={(e) => {
          const v = e.target.value;
          if (v === 'system' || v === 'light' || v === 'dark') setTheme(v);
        }} className="input max-w-xs">
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>
      <div>
        <h3 className="text-sm font-medium text-foreground mb-2">Backend</h3>
        <div className="flex items-center justify-between bg-foreground/5 rounded-lg px-4 py-3">
          <div>
            <p className="text-sm text-muted-foreground">API Base URL</p>
            <p className="text-sm font-medium text-foreground mt-0.5">{apiUrl}</p>
          </div>
          <span className="text-xs text-muted-foreground bg-foreground/10 px-2 py-1 rounded">VITE_API_URL</span>
        </div>
      </div>
    </div>
  );
}

function AdminConfigTab({
  settings,
  settingKey,
  setSettingKey,
  settingValue,
  setSettingValue,
  settingReason,
  setSettingReason,
  agentMaxRuns,
  setAgentMaxRuns,
  agentMaxRunsReason,
  setAgentMaxRunsReason,
  onUpdateSetting,
  onSaveAgentMaxRuns,
}: {
  settings: ManagedSetting[];
  settingKey: string;
  setSettingKey: (v: string) => void;
  settingValue: string;
  setSettingValue: (v: string) => void;
  settingReason: string;
  setSettingReason: (v: string) => void;
  agentMaxRuns: string;
  setAgentMaxRuns: (v: string) => void;
  agentMaxRunsReason: string;
  setAgentMaxRunsReason: (v: string) => void;
  onUpdateSetting: () => void;
  onSaveAgentMaxRuns: () => void;
}) {
  return (
    <div className="space-y-6">
      {/* Agent Rate Limiting */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3">Agent Rate Limiting</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Max runs per hour</label>
            <input className="input" type="number" min={0} value={agentMaxRuns} onChange={(e) => setAgentMaxRuns(e.target.value)} />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs text-muted-foreground mb-1">Reason</label>
            <input className="input" value={agentMaxRunsReason} onChange={(e) => setAgentMaxRunsReason(e.target.value)} placeholder="Reason for change" />
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-1">Set to 0 to disable rate limiting.</p>
        <button className="btn btn-primary mt-3" onClick={onSaveAgentMaxRuns} disabled={agentMaxRuns === ''}>Save Rate Limit</button>
      </div>

      {/* System Settings */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3">System Settings</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <select value={settingKey} onChange={(e) => setSettingKey(e.target.value)} className="input">
            {settings.map((item) => (
              <option key={item.key} value={item.key}>{item.key}</option>
            ))}
          </select>
          <input className="input" value={settingValue} onChange={(e) => setSettingValue(e.target.value)} placeholder="New value" />
          <input className="input" value={settingReason} onChange={(e) => setSettingReason(e.target.value)} placeholder="Reason" />
        </div>
        <button className="btn btn-primary mt-3" onClick={onUpdateSetting} disabled={!settingKey || !settingValue}>Update Setting</button>
      </div>

      {/* Settings Table */}
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left border-b border-border">
              <th className="py-2 pr-4 font-medium text-muted-foreground">Key</th>
              <th className="py-2 pr-4 font-medium text-muted-foreground">Value</th>
              <th className="py-2 pr-4 font-medium text-muted-foreground">Version</th>
              <th className="py-2 pr-4 font-medium text-muted-foreground">Updated</th>
            </tr>
          </thead>
          <tbody>
            {settings.map((item) => {
              // Phase 10 (2026-04-16): FILE_WATCH_ENABLED is read at
              // service init, not per-call, so toggling it in the UI
              // doesn't take effect until the backend is restarted.
              // Surface this clearly so ops aren't confused by a
              // persisted value not matching live behavior.
              const requiresRestart = item.key === 'FILE_WATCH_ENABLED';
              return (
                <tr key={item.key} className="border-b border-border">
                  <td className="py-2 pr-4 font-medium text-foreground">
                    {item.key}
                    {requiresRestart && (
                      <span className="ml-2 text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded">
                        restart required
                      </span>
                    )}
                    {(item as { encrypted?: boolean }).encrypted && (
                      <span className="ml-2 text-xs bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded">
                        encrypted
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-muted-foreground">
                    {item.isSecret ? (item.isSet ? <span className="text-xs bg-foreground/10 px-2 py-0.5 rounded">set</span> : <span className="text-xs text-muted-foreground">not set</span>) : String(item.value ?? '')}
                  </td>
                  <td className="py-2 pr-4 text-muted-foreground">v{item.version}</td>
                  <td className="py-2 pr-4 text-muted-foreground">{new Date(item.updatedAt).toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LlmConfigTab({
  llmConfig,
  llmDraft,
  setLlmDraft,
  llmTestResult,
  onSave,
  onTest,
}: {
  llmConfig: LlmConfig | null;
  llmDraft: { provider: string; baseUrl: string; chatModel: string; embeddingModel: string; embeddingDimensions: number; apiKey: string };
  setLlmDraft: React.Dispatch<React.SetStateAction<typeof llmDraft>>;
  llmTestResult: string;
  onSave: () => void;
  onTest: () => void;
}) {
  return (
    <div className="space-y-6">
      {llmConfig && (
        <div className="bg-foreground/5 rounded-lg px-4 py-3 text-sm text-foreground flex items-center gap-4 flex-wrap">
          <span>Provider: <strong>{llmConfig.provider || '—'}</strong></span>
          <span>Chat model: <strong>{llmConfig.chatModel || '—'}</strong></span>
          <span>API key: <strong className={llmConfig.openaiApiKeySet ? 'text-success-600' : 'text-error-600'}>{llmConfig.openaiApiKeySet ? 'configured' : 'not set'}</strong></span>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">Provider</label>
          <input className="input" value={llmDraft.provider} onChange={(e) => setLlmDraft((p) => ({ ...p, provider: e.target.value }))} placeholder="auto | openai | openrouter | local" />
        </div>
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">Base URL</label>
          <input className="input" value={llmDraft.baseUrl} onChange={(e) => setLlmDraft((p) => ({ ...p, baseUrl: e.target.value }))} placeholder="https://..." />
        </div>
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">Chat Model</label>
          <input className="input" value={llmDraft.chatModel} onChange={(e) => setLlmDraft((p) => ({ ...p, chatModel: e.target.value }))} placeholder="gpt-4o-mini" />
        </div>
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">Embedding Model</label>
          <input className="input" value={llmDraft.embeddingModel} onChange={(e) => setLlmDraft((p) => ({ ...p, embeddingModel: e.target.value }))} placeholder="text-embedding-3-small" />
        </div>
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">Embedding Dimensions</label>
          <input className="input" type="number" value={llmDraft.embeddingDimensions} onChange={(e) => setLlmDraft((p) => ({ ...p, embeddingDimensions: Number(e.target.value) }))} />
        </div>
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">API Key (optional update)</label>
          <input className="input" type="password" value={llmDraft.apiKey} onChange={(e) => setLlmDraft((p) => ({ ...p, apiKey: e.target.value }))} placeholder="sk-..." />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button className="btn btn-primary" onClick={onSave}>Save LLM Config</button>
        <button className="btn btn-outline" onClick={onTest}>Test Connectivity</button>
      </div>
      {llmTestResult && <pre className="bg-foreground/10 rounded-lg p-4 text-xs overflow-x-auto max-h-64">{llmTestResult}</pre>}
    </div>
  );
}

function GitHubTab({
  githubRepos,
  oauthCode,
  setOauthCode,
  oauthState,
  setOauthState,
  webhookRepo,
  setWebhookRepo,
  webhookBranch,
  setWebhookBranch,
  githubResult,
  onConnect,
  onCallback,
  onRefreshRepos,
  onSetupWebhook,
}: {
  githubRepos: GitHubRepo[];
  oauthCode: string;
  setOauthCode: (v: string) => void;
  oauthState: string;
  setOauthState: (v: string) => void;
  webhookRepo: string;
  setWebhookRepo: (v: string) => void;
  webhookBranch: string;
  setWebhookBranch: (v: string) => void;
  githubResult: string;
  onConnect: () => void;
  onCallback: () => void;
  onRefreshRepos: () => void;
  onSetupWebhook: () => void;
}) {
  return (
    <div className="space-y-6">
      {/* OAuth */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3">OAuth Connection</h3>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <button className="btn btn-primary" onClick={onConnect}>Start OAuth</button>
          <button className="btn btn-outline" onClick={onRefreshRepos}>Refresh Repositories</button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <input className="input" value={oauthCode} onChange={(e) => setOauthCode(e.target.value)} placeholder="OAuth code" />
          <input className="input" value={oauthState} onChange={(e) => setOauthState(e.target.value)} placeholder="OAuth state" />
          <button className="btn btn-secondary" onClick={onCallback} disabled={!oauthCode}>Complete Callback</button>
        </div>
      </div>

      {/* Webhook Setup */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3">Webhook Setup</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <input className="input" value={webhookRepo} onChange={(e) => setWebhookRepo(e.target.value)} placeholder="owner/repo" />
          <input className="input" value={webhookBranch} onChange={(e) => setWebhookBranch(e.target.value)} placeholder="branch" />
          <button className="btn btn-outline" onClick={onSetupWebhook} disabled={!webhookRepo}>Create Webhook</button>
        </div>
      </div>

      {/* Connected Repos */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3">Connected Repositories</h3>
        <div className="max-h-52 overflow-y-auto border border-border rounded-lg">
          {githubRepos.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground text-center">No connected repositories yet.</div>
          ) : (
            githubRepos.map((repo) => (
              <button
                key={repo.id}
                className="w-full text-left px-4 py-3 border-b last:border-b-0 border-border hover:bg-foreground/5 flex items-center justify-between"
                onClick={() => { setWebhookRepo(repo.fullName); setWebhookBranch(repo.defaultBranch || 'main'); }}
              >
                <div>
                  <div className="text-sm font-medium text-foreground">{repo.fullName}</div>
                  <div className="text-xs text-muted-foreground">
                    {repo.private ? 'private' : 'public'} · {repo.defaultBranch} · {new Date(repo.updatedAt).toLocaleDateString()}
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </button>
            ))
          )}
        </div>
      </div>

      {githubResult && <pre className="bg-foreground/10 rounded-lg p-4 text-xs overflow-x-auto max-h-48">{githubResult}</pre>}
    </div>
  );
}

function McpToolsTab({
  mcpTools,
  mcpTool,
  setMcpTool,
  mcpArgs,
  setMcpArgs,
  mcpResult,
  mcpHistory,
  setMcpResult,
  onExecute,
}: {
  mcpTools: McpToolCatalog[];
  mcpTool: string;
  setMcpTool: (v: string) => void;
  mcpArgs: string;
  setMcpArgs: (v: string) => void;
  mcpResult: string;
  mcpHistory: McpHistoryItem[];
  setMcpResult: (v: string) => void;
  onExecute: () => void;
}) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">Tool</label>
          <select
            className="input"
            value={mcpTool}
            onChange={(e) => {
              const name = e.target.value;
              setMcpTool(name);
              const meta = mcpTools.find((t) => t.name === name);
              if (!meta) return;
              const tpl = meta.parameters.reduce<Record<string, unknown>>((a, p) => { if (p.required) a[p.name] = ''; return a; }, {});
              setMcpArgs(JSON.stringify(tpl, null, 2));
            }}
          >
            {mcpTools.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
          </select>
        </div>
        <div className="md:col-span-2">
          <label className="block text-xs font-medium text-muted-foreground mb-1">Arguments (JSON)</label>
          <textarea className="textarea min-h-[100px] font-mono text-xs" value={mcpArgs} onChange={(e) => setMcpArgs(e.target.value)} />
        </div>
      </div>
      {mcpTools.find((t) => t.name === mcpTool)?.description && (
        <p className="text-xs text-muted-foreground">{mcpTools.find((t) => t.name === mcpTool)?.description}</p>
      )}
      <button className="btn btn-primary" onClick={onExecute} disabled={!mcpTool}>Execute Tool</button>
      {mcpResult && <pre className="bg-foreground/10 rounded-lg p-4 text-xs overflow-x-auto max-h-64">{mcpResult}</pre>}

      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3">Recent Executions</h3>
        <div className="space-y-2 max-h-48 overflow-y-auto">
          {mcpHistory.length === 0 ? (
            <div className="text-sm text-muted-foreground">No MCP executions yet.</div>
          ) : (
            mcpHistory.map((item, idx) => (
              <button
                key={`${item.toolName}-${item.createdAt}-${idx}`}
                className="w-full text-left border border-border rounded-lg px-3 py-2 hover:bg-foreground/5"
                onClick={() => setMcpResult(JSON.stringify(item, null, 2))}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-foreground">{item.toolName}</span>
                  <span className={`text-xs ${item.error ? 'text-error-600' : 'text-success-600'}`}>{item.error ? 'error' : 'ok'}</span>
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">{item.durationMs}ms · {new Date(item.createdAt).toLocaleTimeString()}</div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function AuditLogTab({ audit, isLoading }: { audit: SettingAuditRecord[]; isLoading: boolean }) {
  if (isLoading) return <div className="text-sm text-muted-foreground">Loading...</div>;
  if (audit.length === 0) return <div className="text-sm text-muted-foreground text-center py-8">No audit entries yet.</div>;

  return (
    <div className="space-y-2">
      {audit.map((entry) => (
        <div key={entry.id} className="border border-border rounded-lg px-4 py-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-foreground">{entry.key} <span className="text-muted-foreground">v{entry.version}</span></span>
            <span className="text-xs text-muted-foreground">{new Date(entry.updatedAt).toLocaleString()}</span>
          </div>
          <div className="text-xs text-muted-foreground mt-1">{entry.reason} · by {entry.updatedBy}</div>
        </div>
      ))}
    </div>
  );
}

/* ───────────── Main Component ───────────── */

export default function SettingsPage() {
  const location = useLocation();
  const [activeTab, setActiveTab] = useState<TabId>('preferences');
  const [settings, setSettings] = useState<ManagedSetting[]>([]);
  const [audit, setAudit] = useState<SettingAuditRecord[]>([]);
  const [llmConfig, setLlmConfig] = useState<LlmConfig | null>(null);
  const [githubRepos, setGithubRepos] = useState<GitHubRepo[]>([]);
  const [mcpTools, setMcpTools] = useState<McpToolCatalog[]>([]);
  const [mcpHistory, setMcpHistory] = useState<McpHistoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [settingKey, setSettingKey] = useState('');
  const settingKeyRef = useRef(settingKey);
  useEffect(() => { settingKeyRef.current = settingKey; }, [settingKey]);

  const [settingValue, setSettingValue] = useState('');
  const [settingReason, setSettingReason] = useState('');
  const [agentMaxRuns, setAgentMaxRuns] = useState('3');
  const [agentMaxRunsReason, setAgentMaxRunsReason] = useState('');
  const [oauthCode, setOauthCode] = useState('');
  const [oauthState, setOauthState] = useState('');
  const [webhookRepo, setWebhookRepo] = useState('');
  const [webhookBranch, setWebhookBranch] = useState('main');
  const [mcpTool, setMcpTool] = useState('search_codebase');
  const [mcpArgs, setMcpArgs] = useState('{"query":"auth guard"}');
  const [mcpResult, setMcpResult] = useState('');
  const [githubResult, setGithubResult] = useState('');
  const [llmTestResult, setLlmTestResult] = useState('');
  const [llmDraft, setLlmDraft] = useState({ provider: '', baseUrl: '', chatModel: '', embeddingModel: '', embeddingDimensions: 1536, apiKey: '' });

  const apiUrl = useMemo(() => import.meta.env.VITE_API_URL || 'http://localhost:3001', []);

  const refreshAdminData = useCallback(async () => {
    try {
      setIsLoading(true);
      const [settingsData, auditData, llmData] = await Promise.all([
        apiClient.get<ManagedSetting[]>('/admin/settings'),
        apiClient.get<SettingAuditRecord[]>('/admin/settings/audit?limit=20'),
        apiClient.get<LlmConfig>('/admin/llm/config'),
      ]);
      setSettings(settingsData);
      if (settingsData.length > 0) {
        const hasCurrentKey = settingsData.some((item) => item.key === settingKeyRef.current);
        if (!hasCurrentKey) setSettingKey(settingsData[0].key);
      } else {
        setSettingKey('');
      }
      setAudit(auditData);
      setLlmConfig(llmData);
      setLlmDraft({ provider: llmData.provider || '', baseUrl: llmData.baseUrl || '', chatModel: llmData.chatModel || '', embeddingModel: llmData.embeddingModel || '', embeddingDimensions: llmData.embeddingDimensions || 1536, apiKey: '' });
      const [toolData, historyData] = await Promise.all([
        apiClient.get<McpToolCatalog[]>('/mcp/tools'),
        apiClient.get<McpHistoryItem[]>('/mcp/history?limit=15'),
      ]);
      setMcpTools(toolData);
      setMcpHistory(historyData);
      if (toolData.length > 0 && !toolData.some((t) => t.name === mcpTool)) {
        setMcpTool(toolData[0].name);
        const tpl = toolData[0].parameters.reduce<Record<string, unknown>>((a, p) => { if (p.required) a[p.name] = ''; return a; }, {});
        setMcpArgs(JSON.stringify(tpl, null, 2));
      }
    } catch (error) {
      console.error(error);
      toast.error('Failed to load admin settings');
    } finally {
      setIsLoading(false);
    }
  }, [mcpTool]);

  const refreshGitHubRepos = useCallback(async () => {
    try {
      const result = await apiClient.request<{ items: GitHubRepo[] }>('/github-integration/repos', { method: 'GET', suppressAuthLogout: true });
      setGithubRepos(result.items || []);
    } catch {
      setGithubRepos([]);
    }
  }, []);

  useEffect(() => { refreshAdminData(); }, [refreshAdminData]);
  useEffect(() => {
    const current = settings.find((item) => item.key === 'AGENT_MAX_RUNS_PER_HOUR');
    if (current) setAgentMaxRuns(String(current.value ?? ''));
  }, [settings]);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const c = params.get('code');
    const s = params.get('state');
    if (c) { setOauthCode(c); setActiveTab('github'); }
    if (s) setOauthState(s);
  }, [location.search]);

  /* ── Handlers ── */
  const handleUpdateSetting = async () => {
    try {
      await apiClient.put(`/admin/settings/${settingKey}`, { value: settingValue, reason: settingReason || 'Updated from settings UI' });
      toast.success('Setting updated');
      setSettingValue(''); setSettingReason('');
      await refreshAdminData();
    } catch (error) { console.error(error); toast.error('Failed to update setting'); }
  };

  const handleSaveAgentMaxRuns = async () => {
    const parsed = Number(agentMaxRuns);
    if (!Number.isFinite(parsed) || parsed < 0) { toast.error('Must be a number >= 0'); return; }
    try {
      await apiClient.put('/admin/settings/AGENT_MAX_RUNS_PER_HOUR', { value: parsed, reason: agentMaxRunsReason || 'Updated agent rate limit from settings UI' });
      toast.success('Agent rate limit updated');
      setAgentMaxRunsReason('');
      await refreshAdminData();
    } catch (error) { console.error(error); toast.error('Failed to update agent rate limit'); }
  };

  const handleSaveLlmConfig = async () => {
    try {
      await apiClient.put('/admin/llm/config', { provider: llmDraft.provider || undefined, baseUrl: llmDraft.baseUrl || '', chatModel: llmDraft.chatModel || undefined, embeddingModel: llmDraft.embeddingModel || undefined, embeddingDimensions: Number(llmDraft.embeddingDimensions), apiKey: llmDraft.apiKey || undefined });
      toast.success('LLM config updated');
      setLlmDraft((p) => ({ ...p, apiKey: '' }));
      await refreshAdminData();
    } catch (error) { console.error(error); toast.error('Failed to update LLM config'); }
  };

  const handleTestLlm = async () => {
    try {
      const result = await apiClient.post<Record<string, unknown>>('/admin/llm/test', { provider: llmDraft.provider || undefined, model: llmDraft.chatModel || undefined, prompt: 'health check' });
      setLlmTestResult(JSON.stringify(result, null, 2));
      toast.success('LLM test completed');
    } catch (error) { console.error(error); toast.error('LLM test failed'); }
  };

  const handleGitHubConnect = async () => {
    try {
      const state = `settings-${Date.now()}`;
      const result = await apiClient.get<{ authUrl: string }>(`/github-integration/connect?state=${encodeURIComponent(state)}`, { suppressAuthLogout: true });
      setOauthState(state);
      if (result.authUrl) { window.open(result.authUrl, '_blank', 'noopener,noreferrer'); toast.success('GitHub authorization opened'); }
    } catch (error) { console.error(error); toast.error('Failed to start GitHub OAuth'); }
  };

  const handleOAuthCallback = async () => {
    if (!oauthCode) { toast.error('OAuth code is required'); return; }
    try {
      const result = await apiClient.get<Record<string, unknown>>(`/github-integration/callback?code=${encodeURIComponent(oauthCode)}&state=${encodeURIComponent(oauthState)}`, { suppressAuthLogout: true });
      setGithubResult(JSON.stringify(result, null, 2));
      toast.success('GitHub account connected');
      await refreshGitHubRepos();
    } catch (error) { console.error(error); toast.error('Failed to complete OAuth callback'); }
  };

  const handleWebhookSetup = async () => {
    try {
      const result = await apiClient.post<Record<string, unknown>>('/github-integration/webhooks/setup', { repo: webhookRepo, branch: webhookBranch }, { suppressAuthLogout: true });
      toast.success('Webhook created');
      setGithubResult(JSON.stringify(result, null, 2));
      await refreshGitHubRepos();
    } catch (error) { console.error(error); toast.error('Failed to create webhook'); }
  };

  const handleExecuteMcp = async () => {
    try {
      const args = JSON.parse(mcpArgs) as Record<string, unknown>;
      const result = await apiClient.post<Record<string, unknown>>('/mcp/execute', { tool: mcpTool, args });
      setMcpResult(JSON.stringify(result, null, 2));
      toast.success('MCP tool executed');
      const historyData = await apiClient.get<McpHistoryItem[]>('/mcp/history?limit=15');
      setMcpHistory(historyData);
    } catch (error) { console.error(error); toast.error('MCP execution failed'); }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <Eyebrow prefix>Mission Control · Config</Eyebrow>
        <h1 className="text-2xl font-normal tracking-tight">
          Operator settings.{' '}
          <span className="text-muted-foreground">Per-user preferences and admin keys.</span>
        </h1>
      </div>

      {/* Tab Navigation */}
      <div className="border-b border-border">
        <nav className="flex gap-1 -mb-px overflow-x-auto">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                  isActive
                    ? 'border-primary-600 text-primary-700'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
                }`}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Tab Content */}
      <div className="card p-6">
        {activeTab === 'preferences' && <PreferencesTab apiUrl={apiUrl} />}
        {activeTab === 'admin' && (
          <AdminConfigTab
            settings={settings} settingKey={settingKey} setSettingKey={setSettingKey}
            settingValue={settingValue} setSettingValue={setSettingValue}
            settingReason={settingReason} setSettingReason={setSettingReason}
            agentMaxRuns={agentMaxRuns} setAgentMaxRuns={setAgentMaxRuns}
            agentMaxRunsReason={agentMaxRunsReason} setAgentMaxRunsReason={setAgentMaxRunsReason}
            onUpdateSetting={handleUpdateSetting} onSaveAgentMaxRuns={handleSaveAgentMaxRuns}
          />
        )}
        {activeTab === 'llm' && (
          <LlmConfigTab llmConfig={llmConfig} llmDraft={llmDraft} setLlmDraft={setLlmDraft} llmTestResult={llmTestResult} onSave={handleSaveLlmConfig} onTest={handleTestLlm} />
        )}
        {activeTab === 'github' && (
          <GitHubTab
            githubRepos={githubRepos} oauthCode={oauthCode} setOauthCode={setOauthCode}
            oauthState={oauthState} setOauthState={setOauthState} webhookRepo={webhookRepo}
            setWebhookRepo={setWebhookRepo} webhookBranch={webhookBranch} setWebhookBranch={setWebhookBranch}
            githubResult={githubResult} onConnect={handleGitHubConnect} onCallback={handleOAuthCallback}
            onRefreshRepos={refreshGitHubRepos} onSetupWebhook={handleWebhookSetup}
          />
        )}
        {activeTab === 'mcp' && (
          <McpToolsTab mcpTools={mcpTools} mcpTool={mcpTool} setMcpTool={setMcpTool} mcpArgs={mcpArgs} setMcpArgs={setMcpArgs} mcpResult={mcpResult} mcpHistory={mcpHistory} setMcpResult={setMcpResult} onExecute={handleExecuteMcp} />
        )}
        {activeTab === 'audit' && <AuditLogTab audit={audit} isLoading={isLoading} />}
      </div>
    </div>
  );
}
