import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Check, ChevronsUpDown, Loader2, Lock, RefreshCw } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { githubApi, type GitHubRepo } from "@/lib/api/github-integration"

export interface RepoPickerValue {
  repoId: number
  fullName: string
  defaultBranch: string
  private: boolean
}

interface RepoPickerProps {
  value: RepoPickerValue | null
  onChange: (value: RepoPickerValue | null) => void
  onConnectGitHub: () => void
  disabled?: boolean
}

/**
 * Searchable dropdown populated from the authenticated user's GitHub
 * connection (`GET /github-integration/repos`). When the user has no
 * connection yet, shows a "Connect GitHub" CTA instead of an empty list.
 */
export function RepoPicker({ value, onChange, onConnectGitHub, disabled }: RepoPickerProps) {
  const [open, setOpen] = useState(false)

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["github-integration", "repos"],
    queryFn: () => githubApi.listRepos(),
    staleTime: 60_000,
    retry: (failureCount, err) => {
      // 401 = no connection — don't retry, render CTA instead.
      const status = (err as any)?.status
      return status !== 401 && failureCount < 1
    },
  })

  const repos: GitHubRepo[] = useMemo(() => data?.items ?? [], [data])
  const is401 =
    isError && ((error as any)?.status === 401 || /401|no github connection/i.test(String((error as any)?.message ?? "")))

  if (is401) {
    return (
      <div className="rounded-md border border-dashed p-4 text-sm">
        <p className="mb-3 text-muted-foreground">
          Connect your GitHub account to see your repositories.
        </p>
        <Button type="button" onClick={onConnectGitHub}>
          Connect GitHub
        </Button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between"
            disabled={disabled || isLoading}
          >
            {value ? (
              <span className="flex items-center gap-2 truncate">
                {value.private && <Lock className="h-3.5 w-3.5 text-muted-foreground" />}
                <span className="truncate">{value.fullName}</span>
                <span className="ml-1 text-xs text-muted-foreground">@{value.defaultBranch}</span>
              </span>
            ) : isLoading ? (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading repositories…
              </span>
            ) : (
              <span className="text-muted-foreground">Select a GitHub repository…</span>
            )}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] min-w-[360px] p-0">
          <Command
            filter={(haystack, needle) => {
              const q = needle.toLowerCase()
              return haystack.toLowerCase().includes(q) ? 1 : 0
            }}
          >
            <CommandInput placeholder="Search by owner/name…" />
            <CommandList>
              <CommandEmpty>No repositories match that search.</CommandEmpty>
              <CommandGroup heading={`${repos.length} repositor${repos.length === 1 ? "y" : "ies"}`}>
                {repos.map((repo) => {
                  const selected = value?.repoId === repo.id
                  return (
                    <CommandItem
                      key={repo.id}
                      value={repo.fullName}
                      onSelect={() => {
                        onChange({
                          repoId: repo.id,
                          fullName: repo.fullName,
                          defaultBranch: repo.defaultBranch,
                          private: repo.private,
                        })
                        setOpen(false)
                      }}
                    >
                      <Check
                        className={cn("mr-2 h-4 w-4", selected ? "opacity-100" : "opacity-0")}
                      />
                      {repo.private && <Lock className="mr-2 h-3.5 w-3.5 text-muted-foreground" />}
                      <span className="truncate">{repo.fullName}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {repo.defaultBranch}
                      </span>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => refetch()}
        disabled={isFetching}
        title="Refresh repo list"
      >
        <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
      </Button>
    </div>
  )
}
