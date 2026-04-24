import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { ChevronDown, Loader2 } from "lucide-react"

import { useAuthStore } from "@/stores/authStore"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RepoPicker, type RepoPickerValue } from "./RepoPicker"
import { reposApi } from "@/lib/api/repos"

interface RepoCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:3001"

/**
 * Two-mode "Add Repository" dialog:
 *
 * - **From GitHub** (default): OAuth-backed dropdown. No token pasting —
 *   `connectedByUserId` is sent to the backend and `GitHubTokenResolver`
 *   fetches a fresh access token from `github_connections` at every
 *   ingest/PR-review.
 *
 * - **Advanced** (collapsed by default): the legacy URL + PAT form.
 *   Kept for users who can't/won't OAuth — GHE enterprise, air-gapped
 *   setups, or hand-managed tokens.
 */
export function RepoCreateDialog({ open, onOpenChange }: RepoCreateDialogProps) {
  const [mode, setMode] = useState<"oauth" | "manual">("oauth")
  const [showAdvanced, setShowAdvanced] = useState(false)

  // OAuth mode state
  const [picked, setPicked] = useState<RepoPickerValue | null>(null)
  const [oauthLabel, setOauthLabel] = useState("")
  const [oauthBranch, setOauthBranch] = useState("")

  // Manual mode state
  const [manualUrl, setManualUrl] = useState("")
  const [manualToken, setManualToken] = useState("")
  const [manualLabel, setManualLabel] = useState("")
  const [manualBranch, setManualBranch] = useState("")

  const user = useAuthStore((s) => s.user)
  const qc = useQueryClient()

  const createMutation = useMutation({
    mutationFn: reposApi.create,
    onSuccess: (repo) => {
      qc.invalidateQueries({ queryKey: ["repos"] })
      toast.success(`Added ${repo.fullName ?? "repository"}`)
      resetAndClose()
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : "Failed to add repository"
      toast.error(msg)
    },
  })

  const resetAndClose = () => {
    setPicked(null)
    setOauthLabel("")
    setOauthBranch("")
    setManualUrl("")
    setManualToken("")
    setManualLabel("")
    setManualBranch("")
    setMode("oauth")
    setShowAdvanced(false)
    onOpenChange(false)
  }

  const handleConnectGitHub = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/auth/github/connect`)
      const data = await response.json()
      if (!data.configured || !data.authUrl) {
        toast.error("GitHub OAuth is not configured. Set GITHUB_CLIENT_ID/SECRET in Settings.")
        return
      }
      window.location.href = data.authUrl
    } catch {
      toast.error("Failed to start GitHub sign-in")
    }
  }

  const handleSubmitOauth = () => {
    if (!picked) {
      toast.error("Pick a repository from the dropdown")
      return
    }
    if (!user?.id) {
      toast.error("You must be signed in")
      return
    }
    createMutation.mutate({
      repoUrl: picked.fullName,
      connectedByUserId: user.id,
      githubRepoId: picked.repoId,
      branch: (oauthBranch || picked.defaultBranch).trim() || undefined,
      label: oauthLabel.trim() || undefined,
    })
  }

  const handleSubmitManual = () => {
    if (!manualUrl.trim()) {
      toast.error("Repository URL is required")
      return
    }
    createMutation.mutate({
      repoUrl: manualUrl.trim(),
      githubToken: manualToken.trim() || undefined,
      branch: manualBranch.trim() || undefined,
      label: manualLabel.trim() || undefined,
    })
  }

  const isSubmitting = createMutation.isPending

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? resetAndClose() : onOpenChange(o))}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Add a repository</DialogTitle>
          <DialogDescription>
            Pick a repo from your connected GitHub account, or add one manually by URL.
          </DialogDescription>
        </DialogHeader>

        {/* Tab switcher */}
        <div className="flex gap-1 border-b pb-2">
          <button
            type="button"
            onClick={() => setMode("oauth")}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              mode === "oauth" ? "bg-primary text-primary-foreground" : "hover:bg-accent"
            }`}
          >
            From GitHub
          </button>
          <button
            type="button"
            onClick={() => setMode("manual")}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              mode === "manual" ? "bg-primary text-primary-foreground" : "hover:bg-accent"
            }`}
          >
            Advanced (URL + PAT)
          </button>
        </div>

        {mode === "oauth" ? (
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Repository</Label>
              <RepoPicker
                value={picked}
                onChange={setPicked}
                onConnectGitHub={handleConnectGitHub}
                disabled={isSubmitting}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="oauth-branch">Branch</Label>
                <Input
                  id="oauth-branch"
                  placeholder={picked?.defaultBranch || "main"}
                  value={oauthBranch}
                  onChange={(e) => setOauthBranch(e.target.value)}
                  disabled={isSubmitting}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="oauth-label">Label (optional)</Label>
                <Input
                  id="oauth-label"
                  placeholder="Display name"
                  value={oauthLabel}
                  onChange={(e) => setOauthLabel(e.target.value)}
                  disabled={isSubmitting}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Token is fetched live from your GitHub connection on every sync —
              you never need to paste or rotate a PAT.
            </p>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="manual-url">Repository URL</Label>
              <Input
                id="manual-url"
                placeholder="https://github.com/owner/repo"
                value={manualUrl}
                onChange={(e) => setManualUrl(e.target.value)}
                disabled={isSubmitting}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="manual-token">GitHub Token</Label>
              <Input
                id="manual-token"
                type="password"
                placeholder="ghp_..."
                value={manualToken}
                onChange={(e) => setManualToken(e.target.value)}
                disabled={isSubmitting}
              />
              <p className="text-xs text-muted-foreground">
                Required for private repos when not using OAuth.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ChevronDown
                className={`h-3 w-3 transition-transform ${showAdvanced ? "rotate-0" : "-rotate-90"}`}
              />
              Optional: branch, label
            </button>
            {showAdvanced && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="manual-branch">Branch</Label>
                  <Input
                    id="manual-branch"
                    placeholder="main"
                    value={manualBranch}
                    onChange={(e) => setManualBranch(e.target.value)}
                    disabled={isSubmitting}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="manual-label">Label</Label>
                  <Input
                    id="manual-label"
                    placeholder="Display name"
                    value={manualLabel}
                    onChange={(e) => setManualLabel(e.target.value)}
                    disabled={isSubmitting}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={resetAndClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={mode === "oauth" ? handleSubmitOauth : handleSubmitManual}
            disabled={isSubmitting}
          >
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Add repository
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
