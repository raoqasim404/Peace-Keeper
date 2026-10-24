require("dotenv").config();
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");

const { FASTN_API_BASE, FASTN_API_KEY, FASTN_IDV_SECRET, FASTN_ORG_ID, PORT = 3000 } = process.env;
for (const k of ["FASTN_API_BASE", "FASTN_API_KEY", "FASTN_IDV_SECRET"]) {
  if (!process.env[k]) { console.error(`Missing ${k} in .env`); process.exit(1); }
}
const base = FASTN_API_BASE.replace(/\/$/, "");
const prefix = process.env.FASTN_API_PREFIX ?? "/v1";
const DEMO_MODE = process.env.DEMO_MODE === "true";
if (!DEMO_MODE && !FASTN_ORG_ID) { console.error("Missing FASTN_ORG_ID in .env"); process.exit(1); }

const WF_SCAN = process.env.WF_SCAN || "wf_08faba4491b0";
const WF_HANDOFF = process.env.WF_HANDOFF || "wf_6b32495fd82a";
const RUN_PATH = process.env.FASTN_RUN_PATH || "/workflows/{id}/execute";
const ACCESS_CODE = process.env.ACCESS_CODE || ""; // set this on the public deploy
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "state.json");

const COMPANIES = {
  "acme-agency": {
    name: "Acme Agency", userId: "acme-admin",
    installationId: process.env.ACME_INSTALLATION_ID,
    config: { slackChannel: process.env.ACME_SLACK_CHANNEL, clientEmail: process.env.ACME_CLIENT_EMAIL, spreadsheetId: process.env.ACME_SHEET_ID, kickoffDays: 3 },
  },
  "bluepeak-studio": {
    name: "Bluepeak Studio", userId: "bluepeak-admin",
    installationId: process.env.BLUEPEAK_INSTALLATION_ID,
    config: { slackChannel: process.env.BLUEPEAK_SLACK_CHANNEL, clientEmail: process.env.BLUEPEAK_CLIENT_EMAIL, spreadsheetId: process.env.BLUEPEAK_SHEET_ID, kickoffDays: 5 },
  },
};

const identityHash = (customerId, userId) =>
  crypto.createHmac("sha256", FASTN_IDV_SECRET).update(`${customerId}\n${userId}`).digest("hex");

const tenantHeaders = (id) => ({
  "content-type": "application/json",
  "x-api-key": FASTN_API_KEY,
  "x-org-id": id,
  "x-user-id": COMPANIES[id].userId,
  "x-identity-hmac": identityHash(id, COMPANIES[id].userId),
});

const runHeaders = (id) => process.env.FASTN_RUN_AUTH === "tenant"
  ? { ...tenantHeaders(id), "x-installation-id": COMPANIES[id].installationId }
  : { "content-type": "application/json", "x-api-key": FASTN_API_KEY,
      "x-org-id": FASTN_ORG_ID, "x-installation-id": COMPANIES[id].installationId };

// ---- State: audit log + handoff results, saved to disk so a restart does not lose them ----
const STEPS = ["sheets", "calendar", "slack", "gmail"];
const audit = Object.fromEntries(Object.keys(COMPANIES).map((k) => [k, []]));
const handoffState = {}; // "tenant:dealId" -> { sheets:{...}, ... }

try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  Object.assign(handoffState, saved.handoffState || {});
  for (const k of Object.keys(audit)) audit[k] = (saved.audit?.[k] || []).slice(0, 200);
} catch { /* first run */ }

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify({ handoffState, audit }));
    } catch (e) { console.warn("Could not save state:", e.message); }
  }, 200);
}
const log = (id, event, detail = {}) => {
  audit[id].unshift({ at: new Date().toISOString(), event, ...detail });
  audit[id].length = Math.min(audit[id].length, 200);
  saveSoon();
};

async function runWorkflow(id, workflowId, input) {
  const url = `${base}${prefix}${RUN_PATH.replace("{id}", workflowId)}`;
  const r = await fetch(url, { method: "POST", headers: runHeaders(id), body: JSON.stringify({ input }) });
  const text = await r.text();
  let json = {}; try { json = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`Fastn ${r.status}: ${text.slice(0, 300)}`);
  return json.output ?? json.data ?? json;
}

function kickoffWindow(days) {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + days);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(10, 0, 0, 0);
  const end = new Date(d); end.setUTCHours(11);
  return { kickoffDate: d.toISOString(), endDateTime: end.toISOString() };
}

function extractPromises(body = "") {
  return body
    .replace(/<[^>]+>/g, " ")
    .split(/[\n;,]|\band\b/i)
    .map((s) => s.trim().replace(/^[“”"'\s]+|[“”"'.\s]+$/g, ""))
    .filter((s) => s.length > 3);
}

const DEMO_DEALS = {
  "acme-agency": [{ id: "358147566315", name: "Won", amount: "10000", contactEmail: "client@acme.example", notes: [{ id: "1", body: "Launch by 15 Dec, 2 free revisions, 10% discount" }] }],
  "bluepeak-studio": [{ id: "357872676545", name: "Another Won", amount: "20000", notes: [{ id: "2", body: "Launch by 20 Feb, 2 free revisions, 20% discount" }] }],
};

const dealContacts = {}; // "tenant:dealId" -> client email taken from HubSpot on the last scan (never from the browser)
const norm = (s) => ({ ...s, status: s.status === "success" ? "ok" : s.status });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clip = (v, n) => String(v ?? "").slice(0, n);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "50kb" }));

// ---- Access code (browser shows its own password box; any username works) ----
if (ACCESS_CODE) {
  app.use((req, res, next) => {
    if (req.path === "/healthz") return next();
    const given = Buffer.from((req.headers.authorization || "").replace(/^Basic /, ""), "base64").toString().split(":").slice(1).join(":");
    const a = Buffer.from(given), b = Buffer.from(ACCESS_CODE);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
    res.set("WWW-Authenticate", 'Basic realm="PromiseKeeper demo (use the access code from the README)"').status(401).send("Access code required");
  });
}
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ---- Simple rate limit on actions that touch real accounts ----
const hits = new Map();
const limited = (req, res, next) => {
  const k = req.ip, now = Date.now();
  const arr = (hits.get(k) || []).filter((t) => now - t < 3600_000);
  if (arr.length >= 40) return res.status(429).json({ error: "Too many handoffs from this address. Try again later." });
  arr.push(now); hits.set(k, arr); next();
};

const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));
app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

const tenant = (req, res, next) => {
  if (!COMPANIES[req.params.id]) return res.status(404).json({ error: "Unknown company" });
  next();
};

app.get("/api/companies", (_req, res) =>
  res.json(Object.entries(COMPANIES).map(([id, c]) => ({ id, name: c.name }))));

// ---- Fastn embed ----
app.post("/api/register/:id", tenant, async (req, res) => {
  try {
    const c = COMPANIES[req.params.id];
    const r = await fetch(`${base}${prefix}/orgs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": FASTN_API_KEY },
      body: JSON.stringify({ name: c.name, orgId: req.params.id }),
    });
    res.status(200).json({ upstreamStatus: r.status, body: await r.text() });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/embed/:id", tenant, async (req, res) => {
  try {
    const r = await fetch(`${base}${prefix}/embed/token`, { method: "POST", headers: tenantHeaders(req.params.id), body: "{}" });
    const text = await r.text();
    let j = {}; try { j = JSON.parse(text); } catch {}
    const token = j.token ?? j.data?.token;
    if (!r.ok || !token) return res.status(502).json({ error: "Could not get embed token", upstreamStatus: r.status, body: text });
    res.json({ iframeUrl: `${base}${prefix}/embed/iframe?token=${encodeURIComponent(token)}` });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---- Deals + promises (also marks deals that were already handed off) ----
app.get("/api/deals/:id", tenant, async (req, res) => {
  const id = req.params.id;
  try {
    const out = DEMO_MODE ? { deals: DEMO_DEALS[id] } : await runWorkflow(id, WF_SCAN, { limit: 10 });
    const deals = (out.deals || []).map((d) => {
      if (EMAIL.test(d.contactEmail || "")) dealContacts[`${id}:${d.id}`] = d.contactEmail;
      const st = handoffState[`${id}:${d.id}`] || {};
      const done = STEPS.every((s) => st[s]?.status === "ok");
      return {
        ...d,
        handedOff: done,
        steps: STEPS.map((s) => st[s]).filter(Boolean),
        promises: [...new Map((d.notes || []).flatMap((n) => extractPromises(n.body)).map((p) => [p.toLowerCase(), p])).values()],
      };
    });
    log(id, "deals_scanned", { count: deals.length });
    res.json({ deals });
  } catch (e) { log(id, "scan_failed", { error: e.message }); res.status(502).json({ error: e.message }); }
});

// ---- Approve promises -> run handoff (only runs steps that are not already ok) ----
app.post("/api/handoff/:id", tenant, limited, async (req, res) => {
  const id = req.params.id;
  const body = req.body || {};
  const d = body.deal;
  if (!d || !d.id) return res.status(400).json({ error: "deal required" });
  const deal = { id: clip(d.id, 40), name: clip(d.name, 120), amount: clip(d.amount, 20), contactEmail: dealContacts[`${id}:${clip(d.id, 40)}`] || "" };
  const promises = (Array.isArray(body.promises) ? body.promises : []).slice(0, 12).map((p) => clip(p, 200)).filter(Boolean);
  const only = Array.isArray(body.only) ? body.only.filter((s) => STEPS.includes(s)) : [];

  const key = `${id}:${deal.id}`;
  const prev = handoffState[key] || {};
  const todo = only.length ? only : STEPS.filter((s) => prev[s]?.status !== "ok");
  log(id, only.length ? "retry_requested" : "promises_approved", { deal: deal.id, promises: promises.length, only });

  if (!todo.length) {
    log(id, "duplicate_blocked", { deal: deal.id });
    return res.json({ steps: STEPS.map((s) => prev[s]) });
  }
  try {
    let steps;
    if (DEMO_MODE) {
      steps = STEPS.map((s) => ({ step: s, status: todo.includes(s) ? "ok" : "skipped" }));
    } else {
      const c = COMPANIES[id].config;
      // Prefer the real client email from the HubSpot contact; fall back to the customer's setting.
      const to = deal.contactEmail || c.clientEmail;
      const out = await runWorkflow(id, WF_HANDOFF, {
        dealId: deal.id, dealName: deal.name, amount: deal.amount,
        notes: promises.join("\n"),
        ...(todo.length < STEPS.length ? { steps: todo } : {}),
        ...(c.slackChannel ? { slackChannel: c.slackChannel } : {}),
        ...(to ? { clientEmail: to } : {}),
        ...(c.spreadsheetId ? { spreadsheetId: c.spreadsheetId } : {}),
        ...kickoffWindow(c.kickoffDays),
      });
      steps = (out.steps || []).map(norm);
    }
    steps.forEach((s) => {
      if (s.status !== "skipped") prev[s.step] = s;
      log(id, `step_${s.step}`, { deal: deal.id, status: s.status, error: s.error });
    });
    handoffState[key] = prev;
    saveSoon();
    res.json({ steps: STEPS.map((s) => prev[s] || { step: s, status: "skipped" }) });
  } catch (e) {
    log(id, "handoff_failed", { deal: deal.id, error: e.message });
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/audit/:id", tenant, (req, res) => res.json({ log: audit[req.params.id] }));

app.listen(PORT, () => console.log(`PromiseKeeper on http://localhost:${PORT}${DEMO_MODE ? " (DEMO_MODE)" : ""}${ACCESS_CODE ? " (access code on)" : ""}`));