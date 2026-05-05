# LLM kill switch — operator runbook

Phase 4A target: give the on-call operator a one-flip lever to stop every
outbound LLM call across the api, **without an api redeploy**.

This document is the response procedure. The code is in
`coderover-api/src/llm-guard/llm-kill-switch.service.ts` and the
integration today is `CopilotService` (the user-facing chat surface).
Other call sites are wired in subsequent PRs and, until then, will
continue to call the LLM provider even with the switch engaged — so this
is currently a "stop chat" lever, not a complete blackout.

---

## When to engage

- LLM provider has confirmed (or is suspected of) returning tampered
  output, leaked context, or model substitution.
- Prompt-injection / data-exfiltration incident under investigation
  through chat/copilot. Engaging stops further surface area until
  forensics finish.
- Cost emergency. A bug in the prompt builder is looping the model in
  10k-token retries, or a customer is stress-testing chat — flip to
  stop the bleed while you fix the root cause.
- Any `[REDACTED:*]` warn-log spike on the
  `LLMResponseValidatorService` — that's evidence the model is
  surfacing credentials. Engage, audit, then disengage.

## How to engage

The switch is sourced from the `LLM_KILL_SWITCH` env var. Truthy values
(case-insensitive, whitespace-trimmed): `1`, `true`, `yes`, `on`,
`enabled`. Anything else (or unset) is OFF.

### Docker compose

```bash
# 1. Set the var on the api service. Use compose override or env_file.
docker compose exec api sh -c 'env | grep LLM_KILL'   # confirm before
echo 'LLM_KILL_SWITCH=1' >> coderover-api/.env
docker compose restart api                             # Node re-reads env on boot
```

The service re-reads `process.env` on **every** call, so once the
container has the new env var, the very next request gets a 503. No
in-flight requests are cancelled — they continue against the upstream
provider — but anything queued after the env update is blocked.

### Kubernetes

```bash
# Patch the deployment env. Restart triggered automatically.
kubectl set env deployment/coderover-api LLM_KILL_SWITCH=1
kubectl rollout status deployment/coderover-api
```

### Bare-metal / systemd

```bash
sudo systemctl edit coderover-api    # add: Environment=LLM_KILL_SWITCH=1
sudo systemctl restart coderover-api
```

## Verifying it's engaged

Make a chat request as a test user and observe the response:

```http
POST /api/chat
Content-Type: application/json
{...}

→ 503 Service Unavailable
{
  "statusCode": 503,
  "error": "LLM Kill Switch Engaged",
  "message": "LLM calls are temporarily disabled by an operator. Try again later, or contact your administrator if this persists."
}
```

In the api log, every blocked attempt emits:

```
[LLMKillSwitchService] WARN  LLM call rejected — LLM_KILL_SWITCH engaged
```

## How to disengage

Reverse of engage:

```bash
# Compose
sed -i '/LLM_KILL_SWITCH=/d' coderover-api/.env
docker compose restart api

# Kubernetes
kubectl set env deployment/coderover-api LLM_KILL_SWITCH-

# Systemd
sudo systemctl edit coderover-api    # remove the Environment= line
sudo systemctl restart coderover-api
```

Verify:
- `curl /api/chat` succeeds (returns SSE stream)
- No `LLM call rejected` log lines for new requests

## What this does NOT do (yet)

| Concern | Status |
|---|---|
| Stops chat / copilot LLM calls | **Yes — covered** |
| Stops embedder / ingest LLM calls | **No — separate wiring PR.** Embedder still hits the provider. |
| Stops PR-review LLM calls | **No — separate wiring PR.** |
| Stops agent (refactor / scan) LLM calls | **No — separate wiring PR.** |
| Hot-toggle without restart | **Partial.** Reads on every call, so any orchestrator that updates env without restart (rare) gets instant effect. Restart is the documented path. |
| SystemSetting-backed toggle for in-app admin UI | **No — Phase 4B** alongside the audit log. |
| Cancel in-flight requests | **No — out of scope.** Engage stops new requests; existing ones complete or fail naturally. |

## Related signals

The response validator (`LLMResponseValidatorService`) is the *post-hoc*
counterpart — it scrubs credentials and length-caps every response that
DID get past the kill switch. If you see this in the api log:

```
[LLMResponseValidatorService] WARN  LLM response had N credential pattern(s) redacted: AWS_ACCESS_KEY=2, GITHUB_PAT=1
```

… that's evidence of either prompt-injection succeeding past your
context filter OR the model hallucinating real-shape tokens. Engage the
kill switch and investigate before disengaging.

---

## Audit log (Phase 4B)

Every wired LLM call writes one row to `llm_audit_log` via
`LLMAuditService`. Useful for forensics during an incident — find every
call that happened in a window, slice by call-site / org / user.

We persist **hashes only** for prompt and response (sha256), never the
raw bytes. The post-validator redaction tally is preserved separately
so the per-row JSONB column tells you exactly how many of each pattern
type the validator scrubbed.

Useful queries:

```sql
-- Recent kill-switch-blocked calls by org (verifies engagement scope).
SELECT org_id, count(*), max(created_at)
FROM llm_audit_log
WHERE kill_switch_blocked
  AND created_at > now() - interval '1 hour'
GROUP BY org_id
ORDER BY count(*) DESC;

-- Which surfaces are leaking credentials? (sustained non-empty redactions).
SELECT call_site,
       sum((redactions->>'AWS_ACCESS_KEY')::int) AS aws,
       sum((redactions->>'GITHUB_PAT')::int)    AS gh,
       count(*) FILTER (WHERE redactions != '{}'::jsonb) AS rows_with_redactions
FROM llm_audit_log
WHERE created_at > now() - interval '24 hours'
GROUP BY call_site
ORDER BY rows_with_redactions DESC;

-- Token spend per org last hour (cost spike detection).
SELECT org_id, sum(total_tokens), count(*) AS calls
FROM llm_audit_log
WHERE created_at > now() - interval '1 hour'
  AND total_tokens IS NOT NULL
GROUP BY org_id
ORDER BY sum(total_tokens) DESC
LIMIT 20;
```

Retention is intentionally not enforced at the DB layer. Run a periodic
`DELETE WHERE created_at < now() - interval 'N days'` via cron when
storage becomes a concern; rows are ~200 bytes each so 10M rows is
roughly 2 GB.

Phase 4C (next PR) wires automated alerts on top of these queries
(token-rate spikes, sustained redactions, kill-switch-block volume).
