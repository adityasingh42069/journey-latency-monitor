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

## What is and isn't published

This repository is public and publishes clients under their real names, along
with their latency, backlog and failure counts.

- **Credentials and base URLs live only in GitHub Actions secrets** and are never
  committed. They are not present in any API response body either.
- The workflow gates every run on a credential-shaped string (a JWT, a bearer
  header, a `password` field) appearing anywhere under `data/`, and fails the run
  rather than commit one.
- Upstream error strings are published verbatim, including tenant ids — a mangled
  tenant id makes diagnosing a broken tenant materially harder.

To publish anonymously instead, set `ANONYMISE=1` in the workflow env. Every
identifying term (base URL, hostname, host slug, login id, echoed tenant id, plus
environment/vendor names) is then replaced by the tenant's opaque id, and the
fetcher re-scans its own output and **throws** if any term survived — so a leak
fails the run instead of being committed. Give `config/tenants.json` opaque
labels to match.

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
