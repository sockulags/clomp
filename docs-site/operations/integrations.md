# Integrations

clomp integrates outward through three deliberately simple mechanisms: a
GitHub Action for recording, webhooks for forwarding, and email for
reminders. No plugin system, no agents.

## GitHub Action: record from CI

Log deploys, patches and pipeline activities as chain events:

```yaml
- name: Record the deploy in the audit trail
  uses: sockulags/clomp/.github/actions/record@main
  with:
    api-url: https://clomp.example.com
    api-key: ${{ secrets.CLOMP_API_KEY }}
    action: patch.applied
    actor: service:github-actions
    target: system:web-01
    context: '{"sha": "${{ github.sha }}", "run": "${{ github.run_id }}"}'
```

The API key comes from an admin (**Admin → API keys**) and belongs in a
repository secret.

## Outgoing event webhooks

POST every appended event to your endpoint — the hook for Slack relays,
SIEM forwarding and automations:

```bash
EVENT_WEBHOOK_URL=https://hooks.example.com/clomp
EVENT_WEBHOOK_TOKEN=optional-bearer-token
# forward only some actions (prefix match); empty = everything
EVENT_WEBHOOK_ACTIONS=incident.,retention.,control.
```

Delivery is asynchronous with a 10-second timeout: an unreachable receiver
never fails or slows down recording. The payload is the event JSON with
`"type": "event"`.

### Delivery log & retries

Every outgoing webhook POST — event webhooks and [anchor
webhooks](/operations/anchoring) alike — is recorded in a delivery log
before the first attempt. A failed delivery is retried with exponential
backoff (by default 5 attempts spread over ~15 minutes: +1, +2, +4, +8
minutes), and pending deliveries survive a restart because they live in
PostgreSQL. Tune with:

```bash
WEBHOOK_RETRY_MAX_ATTEMPTS=5        # 1 disables retries
WEBHOOK_RETRY_BASE_MS=60000         # delay before first retry; doubles per attempt
WEBHOOK_SWEEP_INTERVAL_MS=30000     # how often due retries are picked up
WEBHOOK_DELIVERY_RETENTION_DAYS=30  # prune delivered/failed log rows after this
```

Admins can inspect the log for troubleshooting:

```bash
curl -b cookies.txt 'https://clomp.example.com/api/webhook-deliveries?status=failed&kind=event'
```

Each entry carries the target URL, a payload summary (event sequence and
action, or checkpoint id — never the full payload or bearer token), status
(`pending` / `delivered` / `failed`), attempt count, last error, and the
next scheduled attempt.

This is durability plus visibility, not guaranteed delivery: after the
retry budget is exhausted a delivery is marked `failed` and left in the
log. The [export API](/guide/exports) remains the source of truth —
webhooks are a convenience signal.

## Overdue-control email digest

The passive complement to `clomp schedules --fail-on-overdue`: a daily
email when scheduled controls slip, silent when everything is on time.

```bash
NOTIFY_EMAIL_TO=ciso@example.com
NOTIFY_SCHEDULE=0 6 * * *      # cron, UTC
NOTIFY_INCLUDE_DUE=false       # true: also controls in their grace period
# uses the same SMTP_* settings as external anchoring
```

## API clients in other languages

The [OpenAPI 3.1 specification](/openapi.yaml) covers the full REST
surface — generate a client, or just read it. Recording an event is a
single authenticated POST; see the [REST API reference](/reference/rest-api).
