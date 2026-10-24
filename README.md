# PromiseKeeper

**Every promise a salesperson makes should reach the team that has to keep it.**

PromiseKeeper turns the commitments buried in a won CRM deal into tracked delivery work inside the customer's own tools. When a HubSpot deal is Closed Won, the app reads the deal notes, uses AI to list the promises made to the client, lets the customer review and approve them, and then creates the handoff automatically: a Google Sheets tracker row, a Google Calendar kickoff meeting, a Slack announcement to the delivery team, and a Gmail message to the client. Every promise is then tracked on a board until it is delivered.

Built solo for the Fastn Online Hackathon, on top of Fastn's embedded integrations, customer organizations (tenants), identity verification and workflows.

| | |
|---|---|
| Live demo | https://peace-keeper.onrender.com/ |
| Demo video | https://drive.google.com/file/d/1DvncrjbkjFzGqOntrWzJXT0COxhPuovH/view?usp=sharing |
| Source code | https://github.com/raoqasim404/Peace-Keeper |
| Fastn workspace | personal_3529c456beb57431d1dd (account: ezipezi54@gmail.com) |

---

## Try it in two minutes

The live demo has two separate customer companies. Open each in its own browser window (or one in a private window) to see that they never share data.

| Company | Username | Password |
|---|---|---|
| Acme Agency | `acme` | `6767` |
| Bluepeak Studio | `bluepeak` | `7788` |

These accounts only protect test data connected to test HubSpot, Slack and Google accounts. No real customer data is used anywhere in this project.

Suggested walkthrough:

1. Sign in as `acme`. Open **Connect tools** to see the embedded Fastn widget with Acme's own connected accounts.
2. Open **New deals** and press **Scan won deals**. Acme's Closed Won deals appear, each with the promises the AI found in the notes.
3. Untick anything that is wrong and press **Approve and create handoff**. Four steps run, each with its own status.
4. Open **Promise board** to see the tracked promises, due dates, and delivery status. Mark a promise delivered, or export the board as CSV.
5. Sign out and sign in as `bluepeak`. Bluepeak sees only its own deals, board, activity log and connections. Nothing from Acme is visible.

The free host sleeps when idle, so the first request can take up to a minute.

---

## The problem

When a sales team closes a deal, the promises made along the way ("launch by 15 December", "two free revisions", "10 percent discount") live in call notes, emails and CRM comments. The delivery team starts work without seeing them. Promises get missed, the client gets frustrated, and the agency loses trust and repeat business.

## Who it is for

Agencies, software houses, consultancies and any B2B service business where the person who sells is not the person who delivers.

## The solution

PromiseKeeper closes the gap between the CRM and the delivery team.

1. **Detect.** Find Closed Won deals and read their notes in the customer's HubSpot.
2. **Extract.** An AI model lists the promises made to the client (type, due date, owner), and ignores internal notes such as margins or guesses.
3. **Approve.** The customer reviews the list and unticks anything wrong. Nothing is sent without approval.
4. **Hand off.** One action creates the work in the customer's own tools, with per-step status and retry.
5. **Track.** A promise board shows what is pending, due soon, overdue and delivered.

---

## Features

- **Embedded customer onboarding.** Each customer connects HubSpot, Slack, Gmail, Google Sheets and Google Calendar with their own accounts, inside the product, using the Fastn embedded widget.
- **One login per company.** Each company signs in with its own credentials. The server decides which company a session belongs to, so a customer cannot reach another customer's data.
- **AI promise extraction.** Google Gemini reads the notes and returns structured promises with type, due date and owner. Relative deadlines such as "within 15 days" become real dates. If the AI is unavailable, a rule-based extractor takes over so the product keeps working, and the screen states which method was used.
- **Human approval.** The customer ticks the promises that are correct before anything leaves the app.
- **Four-step handoff with retry.** Sheets, Calendar, Slack and Gmail each report their own status. If one fails, the other three still complete, and Retry re-runs only the failed step.
- **Duplicate protection.** A deal that has already been handed off is never run twice, so a repeated click cannot send a second email.
- **Promise board.** Totals for promises, delivered and overdue; due-soon highlighting; mark delivered or undo; CSV export.
- **Activity log.** A per-company audit trail of scans, approvals, step results, retries and failures.

---

## How Fastn is used

| Fastn capability | How PromiseKeeper uses it |
|---|---|
| Embedded widget | Customers connect their own tools inside our UI. No Fastn screens are exposed outside the iframe. |
| Customer organizations (tenants) | `acme-agency` and `bluepeak-studio` are separate Fastn customers with separate connections and installations. |
| Identity verification (Enforce) | Our backend signs every Fastn request with an HMAC of the customer id and user id. Unsigned or mismatched calls are rejected by Fastn. |
| Workflows | `scan-won-deals` reads Closed Won deals, their notes and the associated contact email from HubSpot. `create-handoff` performs the four delivery steps, with up to three attempts per step and a separate result for each. |
| Connectors | HubSpot, Slack, Gmail, Google Sheets and Google Calendar, all connected through OAuth. |
| Per-customer settings | Each customer has its own Slack channel, tracker sheet, client email fallback and kickoff delay. |

### Workflows

| Workflow | Id | Purpose |
|---|---|---|
| scan-won-deals | `wf_08faba4491b0` | HubSpot: Closed Won deals, deal notes (cleaned of HTML), contact email |
| create-handoff | `wf_6b32495fd82a` | Sheets row, Calendar kickoff event, Slack message, Gmail message, per-step retry |

---

## Architecture

```
Browser (single page app)
   |
   |  signed session cookie (HttpOnly)
   v
Node / Express backend
   |-- Login and session: company is decided server-side
   |-- AI extraction: Gemini, with rule-based fallback
   |-- Per-company state: deals, promises, handoff results, audit log
   |
   |  x-api-key, x-org-id, x-user-id, x-identity-hmac, x-installation-id
   v
Fastn
   |-- Embedded widget (connect tools)
   |-- Workflows: scan-won-deals, create-handoff
   v
HubSpot, Google Sheets, Google Calendar, Slack, Gmail
(the customer's own accounts)
```

## Tenant isolation

Isolation is enforced in layers, not only in the interface.

1. **Separate Fastn customers.** Each company is its own Fastn organization with its own installation and its own OAuth connections.
2. **Server-decided identity.** After login, the company is stored in a signed, HttpOnly session cookie. No endpoint accepts a company id from the browser.
3. **Server-side deal cache.** The server remembers which deals each company scanned. A handoff request can only reference a deal id from the caller's own scan, so a forged request for another company's deal is rejected.
4. **Scoped state.** Promises, handoff results and the audit log are keyed by company. The board, CSV export and activity log only return the signed-in company's records.
5. **Identity verification.** Fastn verifies a signed identity on every request.
6. **Server-side recipients.** The client email address comes from the HubSpot contact on the deal, read by the server. The browser cannot choose who receives an email.

## Reliability

- Each handoff step returns its own status. A failure in one step never blocks the others.
- Retry re-runs only the failed step, so completed steps are not duplicated.
- The workflow retries each step up to three times before reporting failure.
- A handoff that already completed is blocked from running twice.
- If the AI service fails or is not configured, the rule-based extractor is used and the interface says so.
- Login attempts and handoffs are rate limited.
- State is written to disk so the audit log and results survive a restart on a persistent disk.

---

## Run it locally

Requirements: Node.js 18 or newer, and a Fastn workspace with the two workflows and the widget configured as described above.

```
git clone https://github.com/raoqasim404/Peace-Keeper.git
cd Peace-Keeper
cp .env.example .env      # fill in the values; never commit .env
npm install
npm start                 # http://localhost:3000
```

Set `DEMO_MODE=true` to run the whole interface with sample data and without calling Fastn or any AI service.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `FASTN_API_BASE` | yes | Fastn API host, for example `https://api.fastn.dev` |
| `FASTN_API_PREFIX` | no | API path prefix, default `/v1` |
| `FASTN_API_KEY` | yes | Fastn API key (secret) |
| `FASTN_IDV_SECRET` | yes | Fastn identity verification secret (secret) |
| `FASTN_ORG_ID` | yes, unless demo mode | Fastn workspace id |
| `FASTN_RUN_AUTH` | no | Set to `tenant` to run workflows with per-customer identity headers |
| `ACME_INSTALLATION_ID`, `BLUEPEAK_INSTALLATION_ID` | yes | Fastn installation id for each customer |
| `ACME_PASSWORD`, `BLUEPEAK_PASSWORD` | yes | Login password for each company |
| `SESSION_SECRET` | recommended | Key used to sign session cookies |
| `ACME_SLACK_CHANNEL`, `BLUEPEAK_SLACK_CHANNEL` | no | Per-customer Slack channel |
| `ACME_SHEET_ID`, `BLUEPEAK_SHEET_ID` | no | Per-customer tracker spreadsheet |
| `ACME_CLIENT_EMAIL`, `BLUEPEAK_CLIENT_EMAIL` | no | Fallback client email when the deal has no contact |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | no | Enables AI extraction with Gemini, for example model `gemini-2.5-flash` |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | no | Alternative AI provider, used only when no Gemini key is set |
| `SCAN_LIMIT` | no | Maximum deals per scan, default 20, maximum 50 |
| `WF_SCAN`, `WF_HANDOFF` | no | Override the workflow ids |
| `PROMISE_ROWS` | no | Send one entry per promise to the workflow (requires the matching workflow update) |
| `DEMO_MODE` | no | `true` runs with sample data |
| `DATA_FILE`, `PORT` | no | State file path and server port |

### API summary

All routes except login and health require a signed-in session.

| Route | Purpose |
|---|---|
| `POST /api/login`, `POST /api/logout`, `GET /api/me` | Session management |
| `GET /api/embed` | Embedded widget address for the signed-in company |
| `GET /api/deals` | Scan Closed Won deals and extract promises |
| `POST /api/handoff` | Approve promises and run (or retry) the handoff |
| `GET /api/board`, `PATCH /api/board/:dealId/:promiseId` | Promise board and delivery status |
| `GET /api/board.csv` | CSV export of the company's promises |
| `GET /api/audit` | Company activity log |
| `GET /healthz` | Health check |

---

## Security notes

- Secrets are read from environment variables. `.env` and the `data/` folder are excluded from the repository.
- Session cookies are HttpOnly, signed with HMAC, and expire after 12 hours.
- Passwords are compared in constant time.
- The AI prompt treats deal notes as data and ignores instructions embedded in them.
- CSV export neutralizes spreadsheet formula injection.
- The demo passwords above protect test accounts only and are published deliberately for judging. Use strong, private values for any real deployment.

## Known limitations

- The Fastn Slack and HubSpot catalog entries are marked as test status, and the Slack app is not yet reviewed in Slack's directory. Slack shows an "unreviewed app" notice when connecting. It works for our test workspaces.
- AI extraction depends on an external model. When it is unavailable the rule-based extractor is used, which is simpler and may miss unusual phrasing.
- The hosted demo runs on a free plan: it sleeps when idle, and saved state may reset when the service redeploys.
- Deal scanning is started by the user. Automatic detection of new Closed Won deals is not included in this version.
- Each handoff writes one tracker row per deal. One row and one calendar event per promise is supported by the app (`PROMISE_ROWS`) and needs the matching workflow update.
- Only Closed Won deals are scanned, up to the configured limit per scan.

## Roadmap

- Automatic detection of newly won deals with a scheduled trigger.
- One tracker row and one calendar deadline per promise.
- Editing promise wording and due dates before approval.
- Reminders for promises that are due soon or overdue.
- Additional CRMs through Fastn's unified connectors.

---

## Project structure

```
server.js            Express backend: auth, AI extraction, Fastn calls, state
public/index.html    Single page interface: login, board, deals, connect, activity
package.json         Dependencies and start script
.env.example         Environment variable template (no secrets)
```

## Built with

Node.js, Express, Fastn (embedded widget, tenants, identity verification, workflows, connectors), HubSpot, Google Sheets, Google Calendar, Gmail, Slack, and Google Gemini.
