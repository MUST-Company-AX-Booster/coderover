import React, { useCallback, useEffect, useState } from 'react';
import { 
  Shield, 
  CheckCircle, 
  XCircle, 
  Play, 
  Settings,
  Bot,
  Sparkles,
  RefreshCw,
  Trash2,
  X
} from 'lucide-react';
import { toast } from 'sonner';
import {
  agentApi,
  AgentRun,
  AgentApproval,
  AgentRule,
  EnforcerViolation,
  RefactorSuggestion,
  AgentMemoryEntry,
  AgentMemoryType,
} from '../../lib/api/agent';
import { apiClient } from '../../stores/authStore';
import { Eyebrow } from '@/components/brand';

interface Repo {
  id: string;
  fullName: string;
  label: string | null;
  branch: string;
}

const AgentDashboard = () => {
  const [activeTab, setActiveTab] = useState<'overview' | 'enforcer' | 'refactor' | 'approvals' | 'memory'>(
    'overview',
  );
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [loading, setLoading] = useState(true);

  // Data states
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [approvals, setApprovals] = useState<AgentApproval[]>([]);
  const [rules, setRules] = useState<AgentRule[]>([]);
  const [violations, setViolations] = useState<EnforcerViolation[]>([]);
  const [suggestions, setSuggestions] = useState<RefactorSuggestion[]>([]);
  const [memoryEntries, setMemoryEntries] = useState<AgentMemoryEntry[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [memoryTypeFilter, setMemoryTypeFilter] = useState<AgentMemoryType | 'all'>('all');

  const [creatingRule, setCreatingRule] = useState(false);
  const [ruleForm, setRuleForm] = useState({
    name: '',
    description: '',
    regex: '',
    severity: 'warning' as AgentRule['severity'],
  });

  const [creatingMemory, setCreatingMemory] = useState(false);
  const [memoryForm, setMemoryForm] = useState({
    type: 'preference' as AgentMemoryType,
    key: '',
    valueJson: '{\n  \n}',
    ttlDays: '',
  });

  const fetchRepos = useCallback(async () => {
    try {
      const res = await apiClient.get<Repo[]>('/repos');
      setRepos(res);
      if (res.length > 0 && !selectedRepo) {
        setSelectedRepo(res[0].id);
      }
    } catch {
      toast.error('Failed to fetch repositories');
    } finally {
      setLoading(false);
    }
  }, [selectedRepo]);

  const fetchRuns = useCallback(async () => {
    if (!selectedRepo) return;
    setRefreshing(true);
    try {
      const data = await agentApi.getRuns(selectedRepo);
      setRuns(data);
    } catch {
      toast.error('Failed to fetch agent runs');
    } finally {
      setRefreshing(false);
    }
  }, [selectedRepo]);

  const fetchApprovals = useCallback(async () => {
    setRefreshing(true);
    try {
      // Fetch all pending approvals (global)
      const data = await agentApi.getPendingApprovals();
      setApprovals(data);
    } catch {
      toast.error('Failed to fetch approvals');
    } finally {
      setRefreshing(false);
    }
  }, []);

  const fetchRules = useCallback(async () => {
    if (!selectedRepo) return;
    setRefreshing(true);
    try {
      const data = await agentApi.getRules(selectedRepo);
      setRules(data);
    } catch {
      toast.error('Failed to fetch rules');
    } finally {
      setRefreshing(false);
    }
  }, [selectedRepo]);

  const fetchViolations = useCallback(async () => {
    if (!selectedRepo) return;
    setRefreshing(true);
    try {
      const data = await agentApi.getEnforcerViolations(selectedRepo);
      setViolations(data);
    } catch {
      toast.error('Failed to fetch enforcer violations');
    } finally {
      setRefreshing(false);
    }
  }, [selectedRepo]);

  const fetchSuggestions = useCallback(async () => {
    if (!selectedRepo) return;
    setRefreshing(true);
    try {
      const data = await agentApi.getRefactorSuggestions(selectedRepo);
      setSuggestions(data);
    } catch {
      toast.error('Failed to fetch refactor suggestions');
    } finally {
      setRefreshing(false);
    }
  }, [selectedRepo]);

  const fetchMemory = useCallback(async () => {
    if (!selectedRepo) return;
    setRefreshing(true);
    try {
      const type = memoryTypeFilter === 'all' ? undefined : memoryTypeFilter;
      const data = await agentApi.listMemory(selectedRepo, type);
      setMemoryEntries(data);
    } catch {
      toast.error('Failed to fetch memory entries');
    } finally {
      setRefreshing(false);
    }
  }, [memoryTypeFilter, selectedRepo]);

  useEffect(() => {
    fetchRepos();
  }, [fetchRepos]);

  useEffect(() => {
    if (activeTab === 'approvals') {
      fetchApprovals();
      return;
    }

    if (!selectedRepo) return;
    if (activeTab === 'overview') fetchRuns();
    if (activeTab === 'enforcer') {
      fetchViolations();
      fetchRules();
    }
    if (activeTab === 'refactor') fetchSuggestions();
    if (activeTab === 'memory') fetchMemory();
  }, [activeTab, fetchApprovals, fetchMemory, fetchRuns, fetchRules, fetchSuggestions, fetchViolations, selectedRepo]);

  const handleApprove = async (token: string) => {
    try {
      const res = await agentApi.approveAction(token);
      const prUrl = res?.result?.prUrl;
      if (typeof prUrl === 'string' && prUrl.length > 0) {
        toast.success(`Fix applied: ${prUrl}`);
      } else {
        toast.success('Action approved successfully');
      }
      fetchApprovals(); // Refresh list
    } catch {
      toast.error('Failed to approve action');
    }
  };

  const handleReject = async (token: string) => {
    try {
      await agentApi.rejectAction(token);
      toast.success('Action rejected');
      fetchApprovals(); // Refresh list
    } catch {
      toast.error('Failed to reject action');
    }
  };

  const handleTriggerRun = async (type: string) => {
    if (!selectedRepo) return;
    try {
      await agentApi.triggerRun(selectedRepo, type);
      toast.success(`${type} run triggered`);
      fetchRuns();
    } catch {
      toast.error(`Failed to trigger ${type} run`);
    }
  };

  const handleCreateRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRepo) return;
    if (!ruleForm.name.trim() || !ruleForm.description.trim() || !ruleForm.regex.trim()) {
      toast.error('Name, description, and regex are required');
      return;
    }
    setCreatingRule(true);
    try {
      await agentApi.createRule(selectedRepo, {
        name: ruleForm.name.trim(),
        description: ruleForm.description.trim(),
        detectionPattern: { regex: ruleForm.regex },
        severity: ruleForm.severity,
        isActive: true,
      });
      toast.success('Rule created');
      setRuleForm({ name: '', description: '', regex: '', severity: 'warning' });
      fetchRules();
    } catch {
      toast.error('Failed to create rule');
    } finally {
      setCreatingRule(false);
    }
  };

  const suggestionKey = (s: RefactorSuggestion) => `${s.file}|${s.smellId}`;

  const handleRefactorScan = async () => {
    if (!selectedRepo) return;
    setRefreshing(true);
    try {
      const data = await agentApi.scanRefactor(selectedRepo);
      setSuggestions(data);
      toast.success('Refactor scan completed');
      fetchRuns();
    } catch {
      toast.error('Failed to run refactor scan');
    } finally {
      setRefreshing(false);
    }
  };

  const handleRequestFix = async (s: RefactorSuggestion) => {
    if (!selectedRepo) return;
    setRefreshing(true);
    try {
      const res = await agentApi.requestRefactorFix(selectedRepo, suggestionKey(s));
      toast.success(res.message);
      setActiveTab('approvals');
      fetchApprovals();
    } catch {
      toast.error('Failed to request fix');
    } finally {
      setRefreshing(false);
    }
  };

  const handleDismissSuggestion = async (s: RefactorSuggestion) => {
    if (!selectedRepo) return;
    setRefreshing(true);
    try {
      await agentApi.createMemory(selectedRepo, {
        type: 'dismissed',
        key: suggestionKey(s),
        value: { dismissedAt: new Date().toISOString() },
      });
      setSuggestions((prev) => prev.filter((x) => suggestionKey(x) !== suggestionKey(s)));
      toast.success('Suggestion dismissed');
    } catch {
      toast.error('Failed to dismiss suggestion');
    } finally {
      setRefreshing(false);
    }
  };

  const handleCreateMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRepo) return;
    const key = memoryForm.key.trim();
    if (!key) {
      toast.error('Key is required');
      return;
    }

    let value: Record<string, unknown>;
    try {
      const parsed = JSON.parse(memoryForm.valueJson);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        toast.error('Value must be a JSON object');
        return;
      }
      value = parsed as Record<string, unknown>;
    } catch {
      toast.error('Value must be valid JSON');
      return;
    }

    const ttlDaysRaw = memoryForm.ttlDays.trim();
    const ttlDays = ttlDaysRaw ? Number(ttlDaysRaw) : undefined;
    if (ttlDays !== undefined && (!Number.isFinite(ttlDays) || ttlDays <= 0)) {
      toast.error('TTL days must be a positive number');
      return;
    }

    setCreatingMemory(true);
    try {
      await agentApi.createMemory(selectedRepo, {
        type: memoryForm.type,
        key,
        value,
        ttlDays,
      });
      toast.success('Memory entry created');
      setMemoryForm({ type: 'preference', key: '', valueJson: '{\n  \n}', ttlDays: '' });
      fetchMemory();
    } catch {
      toast.error('Failed to create memory entry');
    } finally {
      setCreatingMemory(false);
    }
  };

  const handleDeleteMemory = async (id: string) => {
    if (!selectedRepo) return;
    setRefreshing(true);
    try {
      await agentApi.deleteMemory(selectedRepo, id);
      setMemoryEntries((prev) => prev.filter((m) => m.id !== id));
      toast.success('Memory entry deleted');
    } catch {
      toast.error('Failed to delete memory entry');
    } finally {
      setRefreshing(false);
    }
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'overview':
        return (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-semibold">Recent Activity</h2>
              <div className="flex space-x-2">
                <button
                  onClick={() => handleTriggerRun('enforcer')}
                  disabled={refreshing}
                  className={`px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 flex items-center space-x-2 ${refreshing ? 'opacity-60 cursor-not-allowed' : ''}`}
                >
                  <Play className="w-4 h-4" />
                  <span>Run Enforcer</span>
                </button>
              </div>
            </div>

            {runs.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground border rounded-lg bg-card/50">
                <Bot className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>No agent runs found for this repository.</p>
              </div>
            ) : (
              <div className="bg-card rounded-lg border shadow-sm overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium">Type</th>
                      <th className="px-4 py-3 text-left font-medium">Status</th>
                      <th className="px-4 py-3 text-left font-medium">Started</th>
                      <th className="px-4 py-3 text-left font-medium">Duration</th>
                      <th className="px-4 py-3 text-left font-medium">Findings</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {runs.map((run) => (
                      <tr key={run.id} className="hover:bg-muted/50 transition-colors">
                        <td className="px-4 py-3 font-medium capitalize">{run.agentType.replace('_', ' ')}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium
                            ${run.status === 'completed' ? 'bg-green-100 text-green-700' : 
                              run.status === 'failed' ? 'bg-red-100 text-red-700' : 
                              run.status === 'running' ? 'bg-blue-100 text-blue-700' : 
                              'bg-gray-100 text-gray-700'}`}>
                            {run.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {run.startedAt ? new Date(run.startedAt).toLocaleString() : '-'}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {run.completedAt && run.startedAt ? 
                            `${Math.round((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s` : 
                            '-'}
                        </td>
                        <td className="px-4 py-3 font-mono">{run.findingsCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );

      case 'enforcer':
        return (
          <div className="space-y-8">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-semibold">Enforcer</h2>
              <div className="flex space-x-2">
                <button
                  onClick={() => handleTriggerRun('enforcer')}
                  disabled={refreshing}
                  className={`px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 flex items-center space-x-2 ${refreshing ? 'opacity-60 cursor-not-allowed' : ''}`}
                >
                  <Play className="w-4 h-4" />
                  <span>Run Enforcer</span>
                </button>
                <button
                  onClick={() => {
                    fetchViolations();
                    fetchRules();
                  }}
                  disabled={refreshing}
                  className={`px-4 py-2 border rounded-md hover:bg-muted flex items-center space-x-2 ${refreshing ? 'opacity-60 cursor-not-allowed' : ''}`}
                >
                  <RefreshCw className="w-4 h-4" />
                  <span>Refresh</span>
                </button>
              </div>
            </div>

            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Latest Violations</h3>
              {violations.length === 0 ? (
                <div className="text-center py-10 text-muted-foreground border rounded-lg bg-card/50">
                  <Shield className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>No violations found for this repository.</p>
                </div>
              ) : (
                <div className="bg-card rounded-lg border shadow-sm overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="px-4 py-3 text-left font-medium">Rule</th>
                        <th className="px-4 py-3 text-left font-medium">Severity</th>
                        <th className="px-4 py-3 text-left font-medium">Location</th>
                        <th className="px-4 py-3 text-left font-medium">Message</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {violations.map((v, idx) => (
                        <tr key={`${v.ruleId}-${idx}`} className="hover:bg-muted/50 transition-colors">
                          <td className="px-4 py-3 font-medium">{v.ruleId}</td>
                          <td className="px-4 py-3">
                            <span
                              className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium capitalize
                                ${v.severity === 'critical' ? 'bg-red-100 text-red-700' : v.severity === 'warning' ? 'bg-yellow-100 text-yellow-700' : 'bg-blue-100 text-blue-700'}`}
                            >
                              {v.severity}
                            </span>
                          </td>
                          <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                            {v.file}:{v.line}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">{v.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold">Custom Rules</h3>
                <div className="text-sm text-muted-foreground">{rules.length} total</div>
              </div>

              <form onSubmit={handleCreateRule} className="bg-card border rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="font-medium flex items-center gap-2">
                    <Settings className="w-4 h-4" />
                    <span>Create Rule</span>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <input
                    value={ruleForm.name}
                    onChange={(e) => setRuleForm((p) => ({ ...p, name: e.target.value }))}
                    placeholder="Rule name"
                    className="h-10 px-3 rounded-md border border-input bg-background text-sm"
                    disabled={creatingRule}
                  />
                  <select
                    value={ruleForm.severity}
                    onChange={(e) => setRuleForm((p) => ({ ...p, severity: e.target.value as AgentRule['severity'] }))}
                    className="h-10 px-3 rounded-md border border-input bg-background text-sm"
                    disabled={creatingRule}
                  >
                    <option value="critical">critical</option>
                    <option value="warning">warning</option>
                    <option value="info">info</option>
                  </select>
                  <input
                    value={ruleForm.regex}
                    onChange={(e) => setRuleForm((p) => ({ ...p, regex: e.target.value }))}
                    placeholder="Regex (e.g. TODO:)"
                    className="h-10 px-3 rounded-md border border-input bg-background text-sm md:col-span-2"
                    disabled={creatingRule}
                  />
                  <textarea
                    value={ruleForm.description}
                    onChange={(e) => setRuleForm((p) => ({ ...p, description: e.target.value }))}
                    placeholder="Description"
                    className="min-h-[80px] p-3 rounded-md border border-input bg-background text-sm md:col-span-2"
                    disabled={creatingRule}
                  />
                </div>

                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={creatingRule}
                    className={`px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 flex items-center space-x-2 ${creatingRule ? 'opacity-60 cursor-not-allowed' : ''}`}
                  >
                    <span>Create</span>
                  </button>
                </div>
              </form>

              {rules.length === 0 ? (
                <div className="text-center py-10 text-muted-foreground border rounded-lg bg-card/50">
                  <Shield className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>No rules configured for this repository.</p>
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {rules.map((rule) => (
                    <div key={rule.id} className="bg-card border rounded-lg p-4 shadow-sm hover:shadow-md transition-shadow">
                      <div className="flex justify-between items-start mb-2">
                        <h3 className="font-semibold">{rule.name}</h3>
                        <span
                          className={`px-2 py-0.5 rounded text-xs font-medium capitalize
                            ${rule.severity === 'critical' ? 'bg-red-100 text-red-700' : rule.severity === 'warning' ? 'bg-yellow-100 text-yellow-700' : 'bg-blue-100 text-blue-700'}`}
                        >
                          {rule.severity}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground mb-4 line-clamp-2">{rule.description}</p>
                      <div className="flex items-center justify-between mt-auto pt-2 border-t text-xs text-muted-foreground">
                        <span>
                          {typeof (rule.detectionPattern as Record<string, unknown>)['regex'] === 'string' ? 'regex' : 'built-in'}
                        </span>
                        <span className={rule.isActive ? 'text-green-600' : 'text-gray-400'}>
                          {rule.isActive ? 'Active' : 'Disabled'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        );

      case 'refactor':
        return (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-semibold">Refactor Scan</h2>
              <div className="flex space-x-2">
                <button
                  onClick={handleRefactorScan}
                  disabled={refreshing}
                  className={`px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 flex items-center space-x-2 ${refreshing ? 'opacity-60 cursor-not-allowed' : ''}`}
                >
                  <Sparkles className="w-4 h-4" />
                  <span>Run Scan</span>
                </button>
                <button
                  onClick={() => fetchSuggestions()}
                  disabled={refreshing}
                  className={`px-4 py-2 border rounded-md hover:bg-muted flex items-center space-x-2 ${refreshing ? 'opacity-60 cursor-not-allowed' : ''}`}
                >
                  <RefreshCw className="w-4 h-4" />
                  <span>Refresh</span>
                </button>
              </div>
            </div>

            {suggestions.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground border rounded-lg bg-card/50">
                <Bot className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>No refactor suggestions found for this repository.</p>
              </div>
            ) : (
              <div className="grid gap-4">
                {suggestions.map((s) => (
                  <div key={suggestionKey(s)} className="bg-card border rounded-lg p-6 shadow-sm flex flex-col gap-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span
                            className={`px-2 py-1 rounded-full text-xs font-medium uppercase tracking-wider
                              ${s.severity === 'critical' ? 'bg-red-100 text-red-700' : s.severity === 'warning' ? 'bg-yellow-100 text-yellow-800' : 'bg-blue-100 text-blue-700'}`}
                          >
                            {s.severity}
                          </span>
                          <span className="text-sm text-muted-foreground">{s.smellId}</span>
                        </div>
                        <div className="font-semibold">{s.name}</div>
                        <div className="text-sm text-muted-foreground font-mono break-all">
                          {s.file}
                          {typeof s.line === 'number' ? `:${s.line}` : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleDismissSuggestion(s)}
                          disabled={refreshing}
                          className={`px-3 py-2 border rounded-md hover:bg-muted flex items-center gap-2 ${refreshing ? 'opacity-60 cursor-not-allowed' : ''}`}
                        >
                          <X className="w-4 h-4" />
                          <span>Dismiss</span>
                        </button>
                        <button
                          onClick={() => handleRequestFix(s)}
                          disabled={refreshing}
                          className={`px-3 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 flex items-center gap-2 ${refreshing ? 'opacity-60 cursor-not-allowed' : ''}`}
                        >
                          <CheckCircle className="w-4 h-4" />
                          <span>Request Fix</span>
                        </button>
                      </div>
                    </div>
                    <div className="text-sm text-muted-foreground">{s.message}</div>
                    {s.context !== undefined && s.context !== null && (
                      <pre className="text-xs bg-muted p-2 rounded overflow-x-auto max-w-full">
                        {JSON.stringify(s.context, null, 2)}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );

      case 'approvals':
        return (
          <div className="space-y-6">
            <h2 className="text-xl font-semibold">Pending Approvals</h2>
            {approvals.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground border rounded-lg bg-card/50">
                <CheckCircle className="w-12 h-12 mx-auto mb-4 opacity-50 text-green-500" />
                <p>No pending approvals. All caught up!</p>
              </div>
            ) : (
              <div className="grid gap-4">
                {approvals.map((approval) => (
                  <div key={approval.id} className="bg-card border rounded-lg p-6 shadow-sm flex flex-col md:flex-row justify-between gap-4 items-start md:items-center">
                    <div className="flex-1">
                      <div className="flex items-center space-x-2 mb-2">
                        <span className="px-2 py-1 bg-yellow-100 text-yellow-800 text-xs rounded-full font-medium uppercase tracking-wider">
                          {approval.actionType}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          {new Date(approval.createdAt).toLocaleString()}
                        </span>
                      </div>
                      <h3 className="font-semibold text-lg mb-1">Action Required</h3>
                      <pre className="text-xs bg-muted p-2 rounded overflow-x-auto max-w-2xl">
                        {JSON.stringify(approval.actionPayload, null, 2)}
                      </pre>
                    </div>
                    <div className="flex items-center space-x-3 w-full md:w-auto">
                      <button
                        onClick={() => handleReject(approval.approvalToken)}
                        disabled={refreshing}
                        className={`flex-1 md:flex-none px-4 py-2 border border-red-200 text-red-700 hover:bg-red-50 rounded-md flex items-center justify-center space-x-2 transition-colors ${refreshing ? 'opacity-60 cursor-not-allowed' : ''}`}
                      >
                        <XCircle className="w-4 h-4" />
                        <span>Reject</span>
                      </button>
                      <button
                        onClick={() => handleApprove(approval.approvalToken)}
                        disabled={refreshing}
                        className={`flex-1 md:flex-none px-4 py-2 bg-green-600 text-white hover:bg-green-700 rounded-md flex items-center justify-center space-x-2 transition-colors shadow-sm ${refreshing ? 'opacity-60 cursor-not-allowed' : ''}`}
                      >
                        <CheckCircle className="w-4 h-4" />
                        <span>Approve</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );

      case 'memory':
        return (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-semibold">Memory</h2>
              <div className="flex items-center gap-2">
                <select
                  value={memoryTypeFilter}
                  onChange={(e) => setMemoryTypeFilter(e.target.value as AgentMemoryType | 'all')}
                  className="h-10 px-3 rounded-md border border-input bg-background text-sm"
                  disabled={refreshing}
                >
                  <option value="all">all</option>
                  <option value="dismissed">dismissed</option>
                  <option value="approved_pattern">approved_pattern</option>
                  <option value="preference">preference</option>
                  <option value="decision">decision</option>
                </select>
                <button
                  onClick={() => fetchMemory()}
                  disabled={refreshing}
                  className={`px-4 py-2 border rounded-md hover:bg-muted flex items-center space-x-2 ${refreshing ? 'opacity-60 cursor-not-allowed' : ''}`}
                >
                  <RefreshCw className="w-4 h-4" />
                  <span>Refresh</span>
                </button>
              </div>
            </div>

            <form onSubmit={handleCreateMemory} className="bg-card border rounded-lg p-4 space-y-3">
              <div className="font-medium flex items-center gap-2">
                <Settings className="w-4 h-4" />
                <span>Create Memory Entry</span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <select
                  value={memoryForm.type}
                  onChange={(e) => setMemoryForm((p) => ({ ...p, type: e.target.value as AgentMemoryType }))}
                  className="h-10 px-3 rounded-md border border-input bg-background text-sm"
                  disabled={creatingMemory}
                >
                  <option value="dismissed">dismissed</option>
                  <option value="approved_pattern">approved_pattern</option>
                  <option value="preference">preference</option>
                  <option value="decision">decision</option>
                </select>
                <input
                  value={memoryForm.key}
                  onChange={(e) => setMemoryForm((p) => ({ ...p, key: e.target.value }))}
                  placeholder="Key"
                  className="h-10 px-3 rounded-md border border-input bg-background text-sm"
                  disabled={creatingMemory}
                />
                <input
                  value={memoryForm.ttlDays}
                  onChange={(e) => setMemoryForm((p) => ({ ...p, ttlDays: e.target.value }))}
                  placeholder="TTL days (optional)"
                  className="h-10 px-3 rounded-md border border-input bg-background text-sm"
                  disabled={creatingMemory}
                />
                <div className="md:col-span-2">
                  <textarea
                    value={memoryForm.valueJson}
                    onChange={(e) => setMemoryForm((p) => ({ ...p, valueJson: e.target.value }))}
                    className="min-h-[120px] p-3 rounded-md border border-input bg-background text-sm font-mono"
                    disabled={creatingMemory}
                  />
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={creatingMemory}
                  className={`px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 ${creatingMemory ? 'opacity-60 cursor-not-allowed' : ''}`}
                >
                  Create
                </button>
              </div>
            </form>
            
            {memoryEntries.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground border rounded-lg bg-card/50">
                <Shield className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>No memory entries found for this repository.</p>
              </div>
            ) : (
              <div className="grid gap-4">
                {memoryEntries.map((m) => (
                  <div key={m.id} className="bg-card border rounded-lg p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="px-2 py-1 bg-muted text-xs rounded-full font-medium uppercase tracking-wider">
                            {m.memoryType}
                          </span>
                          <span className="text-xs text-muted-foreground">{new Date(m.createdAt).toLocaleString()}</span>
                        </div>
                        <div className="font-mono text-sm break-all">{m.key}</div>
                      </div>
                      <button
                        onClick={() => handleDeleteMemory(m.id)}
                        disabled={refreshing}
                        className={`px-3 py-2 border rounded-md hover:bg-muted flex items-center gap-2 ${refreshing ? 'opacity-60 cursor-not-allowed' : ''}`}
                      >
                        <Trash2 className="w-4 h-4" />
                        <span>Delete</span>
                      </button>
                    </div>
                    <pre className="text-xs bg-muted p-2 rounded overflow-x-auto max-w-full mt-3">
                      {JSON.stringify(m.value, null, 2)}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      
      default:
        return null;
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Eyebrow prefix>Rover Ops</Eyebrow>
          <h1 className="text-2xl font-normal tracking-tight">
            The fleet, up close.{' '}
            <span className="text-muted-foreground">Monitor agents, approve actions, configure rules.</span>
          </h1>
        </div>
        
        {activeTab !== 'approvals' && (
          <div className="w-full md:w-64">
            <select
              value={selectedRepo}
              onChange={(e) => setSelectedRepo(e.target.value)}
              className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              disabled={loading}
            >
              <option value="" disabled>Select Repository</option>
              {repos.map((repo) => (
                <option key={repo.id} value={repo.id}>{repo.fullName}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="flex space-x-1 bg-muted p-1 rounded-lg w-full md:w-auto inline-flex">
        <button
          onClick={() => setActiveTab('overview')}
          className={`flex-1 md:flex-none px-4 py-2 text-sm font-medium rounded-md transition-all
            ${activeTab === 'overview' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
        >
          Overview
        </button>
        <button
          onClick={() => setActiveTab('enforcer')}
          className={`flex-1 md:flex-none px-4 py-2 text-sm font-medium rounded-md transition-all
            ${activeTab === 'enforcer' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
        >
          Enforcer
        </button>
        <button
          onClick={() => setActiveTab('refactor')}
          className={`flex-1 md:flex-none px-4 py-2 text-sm font-medium rounded-md transition-all
            ${activeTab === 'refactor' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
        >
          Refactor
        </button>
        <button
          onClick={() => setActiveTab('approvals')}
          className={`flex-1 md:flex-none px-4 py-2 text-sm font-medium rounded-md transition-all flex items-center justify-center space-x-2
            ${activeTab === 'approvals' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
        >
          <span>Approvals</span>
          {approvals.length > 0 && (
            <span className="bg-red-500 text-white text-[10px] px-1.5 py-0.5 rounded-full">
              {approvals.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('memory')}
          className={`flex-1 md:flex-none px-4 py-2 text-sm font-medium rounded-md transition-all
            ${activeTab === 'memory' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
        >
          Memory
        </button>
      </div>

      <div className="min-h-[400px]">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        ) : (
          renderTabContent()
        )}
      </div>
    </div>
  );
};

export default AgentDashboard;
