# GitHub App — provisioning + rollout runbook

Phase 2B target: replace the user OAuth `repo` scope with **per-installation
GitHub App tokens** as the primary credential for repo operations
(ingest, PR review, check-runs).

The resolver path now prefers App installation tokens whenever the App is
configured and installed on the repo's owner. OAuth, per-repo PAT, and
the env `GITHUB_TOKEN` remain as fallbacks so the rollout is gradual:

```
1. App installation token  ← preferred (Zero Trust target)
2. OAuth user token        ← fallback (still has `repo` scope, will tighten later)
3. Per-repo PAT            ← legacy, manual registration
4. env GITHUB_TOKEN        ← dev-box default
```

This document is the operator-side checklist. The code is in
`coderover-api/src/github-integration/github-app.service.ts` and
`coderover-api/src/github-integration/github-token-resolver.service.ts`.

---

## 1. Create the GitHub App

One App per CodeRover environment. Org-scoped is recommended unless you're
running a personal-account deploy.

1. Go to **GitHub → org → Settings → Developer settings → GitHub Apps → New**.
2. Name it something operator-scoped, e.g. `CodeRover (production)` /
   `CodeRover (staging)` so you can tell installations apart at a glance.
3. **Homepage URL** — your CodeRover front-end URL.
4. **Callback URL** — leave blank for now (the user-OAuth flow stays on the
   old GitHub OAuth App for now; Phase 2B is server-to-server only).
5. **Webhook** — optional. Enable + point at
   `<api-base>/webhooks/github` if you want install events (future PR adds
   the handler that auto-invalidates the resolver's lookup cache).
6. **Permissions — Repository:**
   - **Contents** → Read
   - **Pull requests** → Read & write (only if you want PR-review posting;
     read-only is fine if all you need is ingest)
   - **Checks** → Read & write (only if check-run UX is enabled)
   - **Metadata** → Read (auto-granted, just confirm)
7. **Permissions — Organization:** none required by Phase 2B. Leave all at
   "No access".
8. **Where can this App be installed?** — "Only on this account" for the
   first rollout. Open it up later if you want multi-tenant.
9. **Save**.

You should now be on the App settings page with an **App ID** at the top.

## 2. Generate + capture the private key

1. Same page → **Generate a private key**.
2. Browser downloads `<app-name>.<date>.private-key.pem`.
3. **Treat this like a root password.** Anyone with the PEM can mint
   installation tokens for any account that's installed your App.
4. Store it in your secrets manager:
   - AWS Secrets Manager / GCP Secret Manager / Doppler / 1Password / etc.
   - Never commit, never paste into Slack, never email.

## 3. Wire the env vars

Set on every running api instance:

```bash
GITHUB_APP_ID=<the numeric App ID from step 1>
GITHUB_APP_PRIVATE_KEY=$(cat <app-name>.<date>.private-key.pem)
```

For docker-compose / k8s the easiest forms are:

- Inline `\n`-joined PEM string in a `.env` file the container reads
- Mounted file via env-from-file (k8s `secretRef` from a Secret object)

After restart, hit any path that goes through `GitHubTokenResolver` and
check the api log for one of:
- `Resolved App installation token for <owner>/<repo>` — App path active
- `Resolved OAuth token from github_connections for user <id>` — fallback

## 4. Install the App on each owner

For every org / personal account whose repos CodeRover ingests:

1. Public install URL: `https://github.com/apps/<app-slug>/installations/new`
2. Pick **All repositories** for the simplest setup, or **Only select
   repositories** to scope down. Either works — the resolver looks up the
   installation per-repo on demand.
3. After install, GitHub redirects back to your callback (or shows a
   success page if no callback configured).

Verify:

```sh
# From any machine that can reach the api:
curl -s https://api.github.com/repos/<owner>/<repo>/installation \
  -H "Authorization: Bearer $(./scripts/sign-app-jwt.sh)" \
  -H "Accept: application/vnd.github+json"
```

If you get a JSON body with `"id": <number>`, the App can see this repo and
the resolver will use installation tokens for it.

If you get `404`, the App is not installed on that repo's owner yet.

> **`scripts/sign-app-jwt.sh` is not in this repo today** — operators who
> need ad-hoc verification can use any of the [GitHub-published one-liners](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app#generating-a-jwt-using-a-script).

## 5. Rollout sequence (recommended)

1. **Stage:** ship the App config + install the App on a single test org.
   Ingest one repo. Confirm log line says `Resolved App installation token`.
2. **Prod, App configured but not yet installed everywhere:** mixed mode.
   Repos whose owner has the App installed get installation tokens. Repos
   whose owner doesn't, fall back to OAuth. Both work. No user-visible
   change.
3. **Install on all production orgs.** Run a sanity audit: check the api
   log for any `Resolved OAuth token` lines on repo paths and chase down
   the owner-installs.
4. **Once 100% on App tokens for repo ops:** open a follow-up PR to drop
   `repo` from the OAuth scope at `auth.service.ts:GITHUB_OAUTH_SCOPE` —
   leaving only `read:user,user:email,read:org` for sign-in identity.

## 6. Cache + invalidation

The resolver's installation lookup is cached in-memory for **5 minutes**
per `(owner, repo)`. That means:
- New install → up to 5 min before the resolver starts returning App
  tokens for that owner.
- Uninstall → up to 5 min of "App configured" log lines that then 401 on
  the actual API call. The resolver catches that 401 (caller falls back
  to OAuth automatically).

To force-invalidate without a restart:

```ts
appService.invalidateInstallationLookupCache();
```

A future PR adds the `installation` webhook handler that calls this
automatically. Until then, restarting the api is the simple lever.

## 7. Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| All repos use OAuth path despite App being configured | App not installed on owner | Install at `https://github.com/apps/<slug>` |
| One repo uses OAuth path, others don't | App install scope is "Only select repositories" and this repo is not included | Add the repo to the install or switch to "All repositories" |
| `App installation lookup failed: ... 401` | Wrong/expired/garbled `GITHUB_APP_PRIVATE_KEY` | Re-paste the PEM, verify newline handling |
| `Failed to mint App installation token ... 403` | App permissions too narrow | Re-check step 1.6 (Contents read at minimum) |
| api boot fine, no logs at all | Resolver isn't being called from this code path | Verify `tokenResolver.resolveFor(...)` is the actual call (Phase 2B fixes the ingest case at `ingest.service.ts`) |
