#!/usr/bin/env node
// Pulls ClickHouse journey telemetry per tenant, anonymises it, and writes the
// dashboard's data files. Zero dependencies - Node 20+ native fetch.
//
// Per tenant <ID>, expects env: <ID>_BASE, <ID>_USER, <ID>_PASS
// (id "client-a" -> CLIENT_A_BASE, CLIENT_A_USER, CLIENT_A_PASS)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const API = "/pfm/api/v2";
const TIMEOUT_MS = 90_000;
const SERIES_CAP = 720; // ~90 days at 8 runs/day

// windowMinutes=1440 -> trailing 24h. The snapshot endpoint is always the live
// last-15-min view and takes no window.
const ENDPOINTS = [
  ["snapshot", "/journey/delay-stats/snapshot"],
  ["analytics", "/journey/analytics-pipeline?windowMinutes=1440"],
  ["webhook", "/journey/webhook-delivery-stats?windowMinutes=1440"],
  ["categorization", "/journey/deposit-categorization-stats?windowMinutes=1440"],
  ["fierrors", "/journey/fi-notification-errors?windowMinutes=1440"],
];

const envKey = (id, suffix) => `${id.toUpperCase().replace(/-/g, "_")}_${suffix}`;
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

async function req(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const body = await r.text();
    return { ok: r.ok, status: r.status, body };
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Anonymisation. Every identifying term is replaced by the tenant's public id.
// buildScrubber collects the base URL, hostname, host slug, login id and the
// tenantId the API echoes back, then rewrites them out of the payload.
//
// GLOBAL_TERMS are environment/vendor names that are not client-specific but
// still appear in upstream error strings; they collapse to a neutral token so
// the published data carries no infrastructure identity either.
// ---------------------------------------------------------------------------
const GLOBAL_TERMS = (process.env.SCRUB_TERMS ?? "fiulive,finfactor,wealthscape")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length >= 4);
const GLOBAL_REPLACEMENT = "internal";

function buildScrubber(id, base, user, tenantId) {
  const terms = new Set();
  const add = (s) => {
    if (s && String(s).trim().length >= 4) terms.add(String(s).trim());
  };
  add(base);
  add(user);
  add(tenantId);
  if (user?.includes("@")) add(user.split("@")[1]);
  if (tenantId?.includes("@")) add(tenantId.split("@")[1]);
  try {
    const host = new URL(base).hostname;
    add(host);
    const first = host.split(".")[0];
    add(first);
    add(first.replace(/^wealthscape-/, ""));
  } catch {
    /* base may be malformed; the other terms still apply */
  }
  // Longest first, so "wealthscape-acme.example.com" is consumed before "acme".
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const scrub = (text) => {
    const tenantScrubbed = sorted.reduce(
      (out, t) => out.replace(new RegExp(esc(t), "gi"), id),
      text
    );
    return GLOBAL_TERMS.reduce(
      (out, t) => out.replace(new RegExp(esc(t), "gi"), GLOBAL_REPLACEMENT),
      tenantScrubbed
    );
  };

  // Safety gate: if any term survives, the caller must abort rather than commit.
  const leaks = (text) =>
    [...sorted, ...GLOBAL_TERMS].filter((t) => new RegExp(esc(t), "i").test(text));
  return { scrub, leaks };
}

// ---------------------------------------------------------------------------
// KPI derivation - the numbers the dashboard leads with.
// ---------------------------------------------------------------------------
const byTransition = (ep, name) =>
  ep?.data?.summary?.byTransition?.find((r) => r.transition === name) ?? null;

function weightedAvg(rows, valueKey, weightKey) {
  let num = 0;
  let den = 0;
  for (const r of rows) {
    const v = r[valueKey];
    const w = r[weightKey];
    if (typeof v === "number" && typeof w === "number" && w > 0 && v > 0) {
      num += v * w;
      den += w;
    }
  }
  return den > 0 ? num / den : null;
}

function deriveKpis(eps) {
  const snap = eps.snapshot?.ok ? eps.snapshot : null;
  const ana = eps.analytics?.ok ? eps.analytics : null;
  const cat = eps.categorization?.ok ? eps.categorization : null;
  const web = eps.webhook?.ok ? eps.webhook : null;
  const fie = eps.fierrors?.ok ? eps.fierrors : null;

  const anaItems = ana?.data?.items ?? [];
  // The live incremental path: analytics recomputed off a USER callback.
  const userRows = anaItems.filter(
    (r) => r.analytics_callback_type === "USER" && r.processor_received_count > 0
  );
  // First-load deposits on a real consent - what a newly linked user waits for.
  const depositConsent = anaItems.find(
    (r) =>
      r.fi_type === "DEPOSIT" &&
      r.fi_request_trigger === "CONSENT_BASED" &&
      r.analytics_callback_type === "ACCOUNT"
  );

  const prism = byTransition(
    cat,
    "DEPOSIT_PRISM_TASK_CREATED->DEPOSIT_PRISM_CALLBACK_RECEIVED"
  );
  const prismQueue = byTransition(
    cat,
    "PROCESSOR_EVENT_RECEIVED->DEPOSIT_PRISM_TASK_CREATED"
  );

  const webRows = web?.data?.summary?.byWebhookType ?? [];
  const webAttempts = webRows.reduce((a, r) => a + (r.attempt_count || 0), 0);
  const webOk = webRows.reduce((a, r) => a + (r.success_count || 0), 0);

  const fiRows = fie?.data?.items ?? [];

  const fip = byTransition(snap, "AA_FI_REQUEST_SENT->AA_FI_NOTIFICATION_SESSION");

  return {
    liveInsightAvgMs: weightedAvg(userRows, "avg_processing_ms", "processor_received_count"),
    liveInsightP95Ms: Math.max(0, ...userRows.map((r) => r.p95_processing_ms || 0)) || null,
    liveInsightEvents: userRows.reduce((a, r) => a + (r.processor_received_count || 0), 0),
    depositConsentAvgMs: num(depositConsent?.avg_processing_ms),
    depositConsentP95Ms: num(depositConsent?.p95_processing_ms),
    prismAvgMs: num(prism?.avg_ms),
    prismP95Ms: num(prism?.p95_ms),
    prismMaxMs: num(prism?.max_ms),
    prismQueued: num(prismQueue?.pending_count),
    fipDeliverAvgMs: num(fip?.avg_ms),
    fipDeliverP95Ms: num(fip?.p95_ms),
    webhookAttempts: webAttempts,
    webhookSuccessPct: webAttempts > 0 ? (webOk / webAttempts) * 100 : null,
    fiErrorTotal: fiRows.reduce((a, r) => a + (r.error_count || 0), 0),
    fiSessionsAffected: fiRows.reduce((a, r) => a + (r.distinct_session_count || 0), 0),
  };
}

// ---------------------------------------------------------------------------

async function collect(tenant) {
  const { id, label, note } = tenant;
  const base = process.env[envKey(id, "BASE")];
  const user = process.env[envKey(id, "USER")];
  const pass = process.env[envKey(id, "PASS")];

  const shell = { id, label, note, status: "error", error: null, endpoints: {}, kpis: null };

  if (!base || !user || !pass) {
    shell.error = { stage: "config", message: `missing ${envKey(id, "BASE")}/_USER/_PASS` };
    return shell;
  }

  // 1. Mint a channel token. The journey controller is @PreAuthorize
  //    hasAuthorityOfChannel(), so an admin token will 403 here.
  let token;
  try {
    const r = await req(`${base}${API}/user-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ userId: user, password: pass }),
    });
    if (!r.ok) {
      shell.error = { stage: "auth", status: r.status, message: `login returned ${r.status}` };
      return shell;
    }
    token = JSON.parse(r.body).token;
    if (!token) throw new Error("no token field in login response");
  } catch (e) {
    shell.error = { stage: "auth", message: String(e.message || e).slice(0, 200) };
    return shell;
  }

  // 2. Pull every endpoint. One failing endpoint must not sink the tenant -
  //    a partial view is still worth publishing.
  const results = await Promise.all(
    ENDPOINTS.map(async ([name, path]) => {
      try {
        const r = await req(`${base}${API}${path}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        });
        if (!r.ok) {
          let reason = `HTTP ${r.status}`;
          try {
            const j = JSON.parse(r.body);
            if (j.message) reason = j.message;
          } catch {
            /* non-JSON error body; the status alone is the signal */
          }
          return [name, { ok: false, status: r.status, reason: reason.slice(0, 300) }];
        }
        return [name, { ok: true, status: r.status, ...JSON.parse(r.body) }];
      } catch (e) {
        return [name, { ok: false, status: 0, reason: String(e.message || e).slice(0, 300) }];
      }
    })
  );

  const eps = Object.fromEntries(results);
  const okCount = results.filter(([, v]) => v.ok).length;
  const tenantId = results.map(([, v]) => v?.tenantId).find(Boolean) ?? null;

  shell.endpoints = eps;
  shell.kpis = deriveKpis(eps);
  shell.status = okCount === 0 ? "error" : okCount < ENDPOINTS.length ? "partial" : "ok";
  if (okCount === 0) {
    const first = results.find(([, v]) => !v.ok)?.[1];
    shell.error = { stage: "telemetry", status: first?.status, message: first?.reason };
  }

  // 3. Anonymise before anything touches disk.
  const { scrub, leaks } = buildScrubber(id, base, user, tenantId);
  const cleaned = JSON.parse(scrub(JSON.stringify(shell)));
  const remaining = leaks(JSON.stringify(cleaned));
  if (remaining.length) {
    throw new Error(
      `anonymisation failed for ${id}: ${remaining.length} identifying term(s) survived scrubbing`
    );
  }
  return cleaned;
}

async function main() {
  const tenants = JSON.parse(readFileSync(join(ROOT, "config", "tenants.json"), "utf8"));
  const capturedAt = new Date().toISOString();

  const clients = [];
  for (const t of tenants) clients.push(await collect(t));

  if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });

  const latest = { capturedAt, windowMinutes: 1440, clients };
  writeFileSync(join(DATA, "latest.json"), JSON.stringify(latest, null, 2) + "\n");

  // Append the KPI row per client so the dashboard can draw trend over time.
  const seriesPath = join(DATA, "series.json");
  const series = existsSync(seriesPath)
    ? JSON.parse(readFileSync(seriesPath, "utf8"))
    : { points: [] };
  for (const c of clients) {
    if (!c.kpis) continue;
    series.points.push({ t: capturedAt, c: c.id, status: c.status, ...c.kpis });
  }
  series.points = series.points.slice(-SERIES_CAP * tenants.length);
  writeFileSync(seriesPath, JSON.stringify(series) + "\n");

  for (const c of clients) {
    const k = c.kpis ?? {};
    const detail = c.status === "ok" || c.status === "partial"
      ? `prism=${k.prismAvgMs ? (k.prismAvgMs / 3.6e6).toFixed(1) + "h" : "n/a"} queued=${k.prismQueued ?? "n/a"} live=${k.liveInsightAvgMs ? Math.round(k.liveInsightAvgMs) + "ms" : "n/a"}`
      : `${c.error?.stage}: ${c.error?.message}`;
    console.log(`${c.id.padEnd(10)} ${c.status.padEnd(8)} ${detail}`);
  }
}

main().catch((e) => {
  console.error("fetch failed:", e.message);
  process.exit(1);
});
