# Monitoring

An audit trail that silently stops working is worse than none at all — you
only find out during the audit. clomp exposes Prometheus metrics so you can
answer "is the audit engine healthy?" continuously: are events flowing, are
checkpoints still being signed, did the last chain verification pass, and is
anything overdue.

## Enabling the endpoint

Metrics are **off by default**, and authenticated by default once on. The
output exposes operational details — tenant ids, ingestion rates, checkpoint
cadence — so treat `/metrics` as internal infrastructure, not a public page:

```bash
# .env — must be exactly the string "true"
METRICS_ENABLED=true

# Required: /metrics requires "Authorization: Bearer <token>"
# Generate one: openssl rand -hex 32
METRICS_TOKEN=change-me-metrics-token
```

With Docker Compose, both variables are passed through to the backend
container. The endpoint then answers on the backend port:

```bash
curl -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:3001/metrics
```

## When no token is set

`METRICS_ENABLED=true` without a `METRICS_TOKEN` does **not** produce an open
endpoint. The route is not mounted, `/metrics` answers 404, and the backend
logs the error at startup:

```
METRICS_ENABLED=true but METRICS_TOKEN is not set — /metrics is NOT served.
Set METRICS_TOKEN=<token> (openssl rand -hex 32) to require "Authorization:
Bearer <token>", or set METRICS_ALLOW_UNAUTHENTICATED=true to expose /metrics
without authentication on a trusted network. The backend keeps running and
keeps recording events either way.
```

The backend starts normally and keeps recording, signing and verifying —
misconfigured telemetry costs you the scrape target and nothing else. The
in-memory counters keep updating too, so the values are all there as soon as
the endpoint is configured properly and the process is restarted.

If your scraper reaches the backend over a network you genuinely trust
(compose network, VPN, cluster-internal) and you would rather not manage a
token, ask for that explicitly:

```bash
METRICS_ENABLED=true
METRICS_ALLOW_UNAUTHENTICATED=true
```

That serves `/metrics` unauthenticated, exactly as before, and logs a warning
at startup so the choice is visible in the logs. Setting `METRICS_TOKEN` as
well makes the token win: the endpoint stays behind bearer auth.

::: warning Exposure considerations
Metric values are not audit data, but they leak activity patterns. Prefer
`METRICS_TOKEN` over `METRICS_ALLOW_UNAUTHENTICATED`, and either way prefer
firewalling `/metrics` off at the reverse proxy as well.
:::

## Metrics reference

All clomp-specific metrics are prefixed `clomp_`; the standard Node.js
process metrics (`process_*`, `nodejs_*`) are included as well.

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `clomp_events_ingested_total` | counter | `tenant_id` | Events appended to the hash chain since process start |
| `clomp_checkpoints_signed_total` | counter | `tenant_id` | Checkpoints signed since process start |
| `clomp_checkpoint_age_seconds` | gauge | `tenant_id` | Seconds since the most recent signed checkpoint (read from the database at scrape time, so it is correct even right after a restart) |
| `clomp_chain_last_verify_ok` | gauge | `tenant_id` | Result of the most recent chain verification: `1` intact, `0` broken. Only a *full* verification sets `1`; a failed verification (full or partial) sets `0`. Benign out-of-range requests (`?from=` past the chain tip) are not recorded. Absent until a verification has run since process start |
| `clomp_overdue_controls` | gauge | `tenant_id` | Active scheduled controls currently past their grace deadline (computed at scrape time) |
| `clomp_http_request_duration_seconds` | histogram | `method`, `route`, `status_code` | Request duration, labelled with the matched Express route pattern; requests that never match a route (static assets, unknown paths) are not observed |

`clomp_checkpoint_age_seconds` and `clomp_overdue_controls` query the
database when scraped. If the database is down, the scrape still succeeds
and those gauges keep their previous values — pair them with alerting on
`/health` (or on `up`) so a database outage is not mistaken for "all quiet".

## Scrape configuration

```yaml
# prometheus.yml
scrape_configs:
  - job_name: clomp
    metrics_path: /metrics
    scrape_interval: 60s
    authorization:
      type: Bearer
      credentials: change-me-metrics-token
    static_configs:
      - targets: ['clomp-backend:3000']   # or localhost:3001 outside compose
```

A 60-second interval is plenty: the interesting signals (checkpoint age,
overdue controls) move on a scale of hours, and each scrape runs two small
database queries for the scrape-time gauges — no reason to pay that every
few seconds.

## Alert rules

The two alerts every install should run: checkpoints stopped being signed,
and a chain verification failed. The first means the engine that makes your
history tamper-evident is not doing its job; the second means the history
itself does not check out.

```yaml
# alerts.yml
groups:
  - name: clomp
    rules:
      # Checkpoints stop being signed.
      # Default CHECKPOINT_SCHEDULE is daily, so >26h means a missed run.
      - alert: ClompCheckpointStale
        expr: clomp_checkpoint_age_seconds > 26 * 3600
        for: 30m
        labels:
          severity: critical
        annotations:
          summary: "clomp has not signed a checkpoint for tenant {{ $labels.tenant_id }} in over 26 hours"
          description: "The checkpoint job may be failing — without fresh signed checkpoints, new events are not anchored. Check the backend logs for 'Scheduled checkpoint job failed'."

      # A chain verification reported a break.
      - alert: ClompChainVerifyFailed
        expr: clomp_chain_last_verify_ok == 0
        labels:
          severity: critical
        annotations:
          summary: "clomp chain verification failed for tenant {{ $labels.tenant_id }}"
          description: "The last verification found a hash-chain break. Run GET /api/verify (or `clomp verify`) to locate the first broken sequence, and treat it as a potential tampering incident."

      # Scheduled controls are overdue.
      - alert: ClompControlsOverdue
        expr: clomp_overdue_controls > 0
        for: 1h
        labels:
          severity: warning
        annotations:
          summary: "{{ $value }} scheduled control(s) overdue for tenant {{ $labels.tenant_id }}"
          description: "An activity that must be logged on a schedule has passed its grace deadline. See the Schedules view or GET /api/schedules."

      # The backend stopped answering scrapes at all.
      - alert: ClompScrapeDown
        expr: up{job="clomp"} == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "clomp metrics endpoint is not responding"
```

Note that `clomp_chain_last_verify_ok` only updates when a verification
actually runs (via `GET /api/verify`, the web UI's verify button, or
`clomp verify` from the CLI). If you want continuous assurance, schedule a
periodic verification — for example a cron job calling the API — and alert
on the gauge being absent as well:

```yaml
      # No verification has run in the last day (gauge absent since restart
      # also triggers this — which is exactly the point).
      - alert: ClompNoRecentVerify
        expr: absent(clomp_chain_last_verify_ok) == 1
        for: 24h
        labels:
          severity: warning
        annotations:
          summary: "No clomp chain verification has run since the backend started"
```

## Dashboards

Useful starting panels for Grafana:

- **Ingestion rate** — `sum by (tenant_id) (rate(clomp_events_ingested_total[5m]))`
- **Checkpoint age** — `clomp_checkpoint_age_seconds` (add a threshold line at 24h)
- **Overdue controls** — `clomp_overdue_controls`
- **API latency (p95)** — `histogram_quantile(0.95, sum by (le, route) (rate(clomp_http_request_duration_seconds_bucket[5m])))`
- **Error rate** — `sum(rate(clomp_http_request_duration_seconds_count{status_code=~"5.."}[5m]))`
