# Journey Latency Monitor

A self-updating dashboard for the **data-to-insight journey**: how long a user waits
from linking a financial account to having the data fetched, insights computed, and
spending categorized.

A GitHub Action runs every 3 hours, pulls journey telemetry from each tenant's
ClickHouse tracking API, anonymises it, and commits the snapshot. GitHub Pages
serves `index.html`, which reads the committed JSON.

## What it shows

| Section | Question it answers |
|---|---|
| Headline tiles | What does a user actually wait for, right now? |
| Live journey funnel | Which stage owns the wait — us, the bank, or the registry? |
| Categorization backlog | Is the transaction-categorization queue growing or draining? |
| Insight computation | How fast is analytics per asset class and trigger? |
| Reliability | Upstream fetch failures vs. our own delivery to the client |

The funnel is the **live 15-minute snapshot** — one user linking an account right
now. The tables are **24-hour** windows and include overnight batch refresh, where a
still-pending task's clock keeps running. Those averages are deliberately *not*
presented as single-user latency.

## Anonymisation

This repository is public, so no client can be identifiable from it.

- Base URLs, login ids and credentials live only in GitHub Actions secrets.
- `config/tenants.json` holds nothing but an opaque id and a display label.
- Before writing to disk, `scripts/fetch.mjs` scrubs the base URL, hostname, host
  slug, login id and the tenant id the API echoes back — plus environment/vendor
  terms — replacing each with the opaque id.
- The fetcher then re-scans its own output and **throws** if any identifying term
  survived, so a leak fails the run instead of being committed.
- The workflow runs a second, independent `grep` gate before committing.

## Configuration

Add one entry per tenant to `config/tenants.json`:

```json
[{ "id": "client-a", "label": "Client A", "note": "AA + MFC + deposits" }]
```

Then set three secrets per tenant, named from the id (`client-a` → `CLIENT_A_`):

| Secret | Value |
|---|---|
| `CLIENT_A_BASE` | tenant base URL, no trailing slash |
| `CLIENT_A_USER` | channel-role login id |
| `CLIENT_A_PASS` | channel-role password |

The journey controller is guarded by `hasAuthorityOfChannel()` — an admin-role
token returns `403`. Use channel credentials.

## Running locally

```bash
CLIENT_A_BASE=… CLIENT_A_USER=… CLIENT_A_PASS=… node scripts/fetch.mjs
python3 -m http.server 8000     # then open http://localhost:8000
```

Serve over HTTP rather than opening `index.html` from disk — browsers block
`fetch()` on `file://`.

## Data

| File | Contents |
|---|---|
| `data/latest.json` | Full anonymised payload from the most recent run |
| `data/series.json` | Rolling KPI history, capped at ~90 days, used for the trend chart |

## Adding a tenant

1. Add it to `config/tenants.json`.
2. Add its three secrets.
3. Run the workflow manually (**Actions → Refresh journey telemetry → Run workflow**).

A tenant whose telemetry endpoints fail is not dropped — it is rendered with the
failure reason, since "this client reports nothing" is itself a finding.
