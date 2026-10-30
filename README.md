# DMHCA Admissions CRM

Next.js App Router, TypeScript, Tailwind CSS and Supabase. CRM screens read and
write authenticated database records; missing configuration or failed operations
are reported rather than replaced with demonstration records.

## Setup

1. Install Node.js 20 or newer and run `npm install`.
2. Copy `.env.example` to **`.env.local`**. Set `NEXT_PUBLIC_APP_URL` to the exact
   origin used in your browser, including its port locally (for example,
   `http://localhost:3001` if port 3000 is already occupied). Use HTTPS in production.
3. Set the Supabase URL, public anon key and **server-only service-role key**.
4. Generate `AUTH_ENCRYPTION_KEY` with:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   Keep this secret stable; changing it invalidates pending authentication and
   encrypted integration credentials.
5. Apply every **not-yet-applied** SQL migration in `supabase/migrations` in
   filename order using the Supabase SQL editor or your migration deployment
   process. Do not reset an existing database or rerun already-applied migrations.
   The verified-session migration applies restrictive
   policies to every CRM RLS table, including those created by preceding migrations.
   Any future CRM table must also receive an equivalent restrictive policy.
6. Configure SMTP (below), then provision the first Super Admin (below).
7. Run `npm run dev`. Restart Next.js after changing environment variables.

### Performance and local preview

Use `npm run build` followed by `npm start` for production-speed serving.
`npm run dev` compiles routes on demand and is not representative of production
loading times. Development output is isolated in `.next-dev`; production uses
`.next`, so building no longer overwrites the running development server's assets.
`NEXT_DIST_DIR` can override either directory; use distinct values if running both.

Lead screens reuse browser-memory responses for up to 30 seconds when revisiting
a page; valid cached data renders immediately instead of flashing a loading screen.
Sidebar links fully prefetch permitted destinations, including dynamic routes;
Next's default partial prefetch otherwise stops at the loading boundary.
Sidebar hover, keyboard focus and touch start also prefetch the selected route. Leads
and Pipeline also start their existing 30-second cached data request on intent,
overlapping route loading rather than waiting for the destination to mount.
Meetings and Invoices start a fresh data read on hover, focus or touch, so an
in-flight request can be shared with the destination rather than starting after
route loading. Completed operational responses are not cached: a later visit
still reads current records and payment status.
Concurrent reads share one request. Manual refresh always requests fresh
data, and API writes invalidate cached reads before and after the write.
No response cache is persisted or shared between browsers or server requests.
Invoices, payment status and operational screens continue to request fresh data;
refreshing existing data happens in place rather than blanking the screen.
Protected-page middleware loads verified session, active profile and current
permissions in parallel after authentication. It passes that result to Server
Components through a request-only header, avoiding a second authentication
waterfall during rendering. Middleware removes browser-supplied values of that
header on every matching request, including public and API routes. The result
is not a cookie, response header or cross-request permission cache.
API routes never trust the page header: they authenticate,
refresh cookies and check verified sessions/permissions in their handlers rather
than repeating the same remote checks in middleware first. Public authentication,
invoice-status and webhook handlers retain their own validation; signed-in login
redirects are unchanged. Independent invoice and meeting queries run concurrently,
without caching balances, payment status or permissions.
Lead date formatting reuses a lazily initialized formatter rather than constructing
one for every row. Dashboard chart drill-downs use client-side navigation instead
of reloading the entire document. The credential PDF library loads only when an
administrator requests a credential download, not when the Users page opens.

A complete page load under 1 ms cannot be guaranteed: network, authentication,
database access, JavaScript and browser rendering all contribute to load time.
Measure cold and warm loads in a production build, including the time until data
is usable, rather than treating a cached function call as a full-page benchmark.

#### Large lead datasets (1 lakh to 10 lakh)

Deploy `202610260001_scalable_lead_reads.sql` **before** deploying the matching
application build. The new database functions and indexes are required; there is
no fallback that downloads all leads if the migration is missing. Use
`npm run db:check` to inspect the target and the tracked migration process above.
Index creation takes time and can block writes on a populated database; schedule
this transactional migration in a maintenance window. Never seed scale-test
records into the live database.

- Leads filters execute inside PostgreSQL under the signed-in user's RLS policies.
  Each page returns at most **50 leads**. Next/Previous use a `(created_at, id)`
  cursor instead of skipping an ever-growing number of rows. The next page is
  prefetched after the current page arrives. List counters describe the current
  page; they do not run an expensive exact count on every navigation. Bulk
  selection is page-scoped and cleared when changing pages or filters.
- Search inputs are debounced by 250 ms. Incomplete conditions show validation
  messages rather than being applied. Date filters use the browser's IANA timezone;
  dashboard drill-downs retain their UTC date semantics and reporting scope.
  Search covers stored lead/contact fields, ownership, stage, IDs and timestamps;
  localized display-only date strings are not a searchable database field.
- Pipeline returns at most **25 cards per stage**, with independent Next/Previous
  controls. Search, owner, stage, My Leads and sorting run on the server. All three
  sort modes have stable cursors, including null follow-up dates. This bounds the
  DOM on desktop, tablet and mobile instead of rendering the whole database.
- Dashboard returns aggregate counts, not lead records. Totals remain exact.
  Country/course charts display the top 30 groups by volume; conversion leaders
  rank across all groups; country/course combinations display the top 30 by
  conversion rate. Chart labels make these limits explicit.
- Reports loads only saved-report/filter metadata. Counts execute as database
  counts, previews fetch one page, and complete lists paginate 50 rows at a time.
  CSV exports still include all matching results, streamed from 100-row database
  batches. The browser currently receives a download Blob, so very large exports
  still require browser memory and transfer time; they are not instant. Exports
  are live reads, not a transactionally frozen snapshot during concurrent edits.
- Lead creation/import loads configuration and staff only, not lead records.
  Existing detail, invoice, meeting, authentication and financial workflows are
  unchanged; financial responses are not added to a shared cache.
- Database indexes cover active lead chronology, owner/stage chronology, name,
  follow-up ordering and country/course equality. Lead hierarchy/session checks
  are evaluated once per SQL statement, not recursively for every lead.

Next.js already separates browser components from server routes. Moving them
into separate frontend/backend projects would not reduce database work and is
not required here. Redis is deliberately not required: first remove unbounded
reads, then measure production traffic before adding a shared cache with correct
user/permission scoping and cross-process invalidation. Browser snapshots remain
limited to 30 entries and 30 seconds and are cleared by writes or identity changes.

Validation uses disposable local PGlite databases and never production records:

```powershell
node --test tests\live-leads-database.test.cjs
# Optional 10-lakh scale check; allow extra memory and execution time.
$env:CRM_SCALE_LEADS = "1000000"
node --test --test-name-pattern="large lead volumes" tests\live-leads-database.test.cjs
Remove-Item Env:\CRM_SCALE_LEADS
```

The scale check verifies a 50-ID response below 5 KB, stable cursor boundaries and
use of the composite chronology index. Its local SQL timing is **not** full-page
latency. Exact dashboard/report counts and broad substring/negative filters still
scan matching records; database sizing, geographic latency and concurrent load
must be measured on the production deployment. This is not a guarantee of zero
loading time on every device or network.

Do not put credentials in source control or chat. Only variables prefixed
`NEXT_PUBLIC_` are safe to expose in the browser. All other example variables
belong in server-side deployment environment settings.

### Direct database connection for migrations

`DATABASE_URL` is an optional, server-only PostgreSQL connection string for
database administration and migration tools. In Supabase, open the project and
select **Connect**, then copy the **Direct connection** URI. If your network
cannot reach the direct endpoint over IPv6, use **Session pooler** instead.
Use the host, port and username supplied by Supabase, not guessed values.

Paste the URI into `DATABASE_URL` in `.env.local`, replacing the password
placeholder with your database password (not your Supabase login password or API
key). URL-encode special characters in the password and require SSL, for example:

```env
DATABASE_URL="postgresql://postgres:URL_ENCODED_DATABASE_PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres?sslmode=require"
```

This connection can be used to inspect the schema and apply the existing SQL
migrations. Adding the variable alone does **not** automatically connect, create
tables or run migrations on app startup. Inspect the target database and determine
which migrations have already been applied before executing any changes; never
reset an existing database or blindly rerun migrations.

The website continues using Supabase's API clients and Row Level Security;
`DATABASE_URL` does not replace the existing Supabase environment variables.
Keep this administrative connection secret and never prefix it with `NEXT_PUBLIC_`.

Download the database CA certificate from Supabase **Database > Settings > SSL
Configuration** and save it as `supabase-ca.crt` in the project root, or set
`DATABASE_CA_CERT_PATH` to its location. The migration tool verifies both the
certificate chain and server hostname; it never disables TLS verification.

- `npm run db:check` inspects tables and reports missing migrations without writes.
- `npm run db:migrate` applies missing migrations in one transaction and stores
  file checksums in the private `crm_migrations.history` table. It refuses to
  initialize an existing untracked application schema or changed/out-of-order
  migration history. It does not reset the database or create demo users.
- Repeat `npm run db:check` after migration to confirm no pending files remain.

These commands use the administrative database connection, not application RLS.
Run them only against the intended project; application startup never runs them.

### First Super Admin

Create a confirmed email/password user in **Supabase Authentication > Users**.
Then run this SQL, replacing the email and display name:

```sql
insert into public.profiles(id, full_name, email, role, status)
select id, 'Your Name', email, 'super_admin', 'active'
from auth.users
where lower(email) = lower('you@your-company.com')
on conflict (id) do update
set full_name = excluded.full_name, email = excluded.email,
    role = 'super_admin', status = 'active', deleted_at = null
returning id, email, role;
```

The statement must return exactly one account. An Auth user without an active CRM
profile cannot enter the workspace. Disable public signups in Supabase Auth if
accounts are provisioned only by administrators. Subsequent accounts are created
from Users by a Super Admin, who sets their initial password directly.
Users > Change password lets only a Super Admin set a replacement password (12 to
128 characters), including their own. No password setup/reset email is sent;
previous email reset links are disabled. Share initial/replacement passwords
through a secure channel, never in CRM notes or email templates.
Password changes revoke existing verified CRM sessions,
pending sign-ins and old setup tokens, and record a password-free audit event.
Changing your own password returns you to sign in. Email-code verification remains
mandatory on the next login. User-management controls are restricted to Super Admin even
if a different role is accidentally granted `users.manage`.

New-user forms enable **Download email and password as a PDF when saved** by
default. Uncheck it to skip the download. The PDF is prepared in browser memory
and downloaded only after successful creation; it contains only the email and
password, not other profile details. Credentials are not stored for later export.
The PDF is not encrypted: protect it and delete it after securely sharing it.

**Users > Delete user** permanently removes the Supabase Auth login account,
requires typing the user's email, and cannot target your own account. Migration
`202610210010_delete_login_preserve_history.sql` preserves a retired profile for
CRM foreign keys and historical attribution, revokes CRM sessions and removes
stored Gmail credentials. Leads, invoices and audit/login history are not deleted.
Reassign leads and reporting relationships where appropriate before deletion.
Apply the migration with `npm run db:migrate` before using deletion.

### SMTP and required verification

Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` and
`SMTP_FROM` for the first login; afterwards Admin/Super Admin can manage these in
**Integrations > SMTP**. The sender must be authorized by your provider. Use port 465
with `SMTP_SECURE=true`, or port 587/2525 with `SMTP_SECURE=false` for STARTTLS.
Only public SMTP hostnames are supported; private/loopback destinations are
rejected, DNS is resolved and pinned, and STARTTLS is always required on
non-implicit-TLS connections. Configure SPF,
DKIM and DMARC with your provider for delivery.

Login is always **email + password, then a six-digit emailed code**:

The responsive sign-in page keeps these as two distinct steps, with password
visibility controls, paste/autofill support for the verification code, and explicit
loading/error states. Requesting another code returns to password authentication.

- Password authentication does not set browser Auth cookies or grant CRM access.
- Pending Supabase tokens are encrypted server-side with AES-256-GCM.
- A code expires after 10 minutes and permits at most five incorrect guesses.
  Requesting a replacement requires entering the password again.
- Persistent rate limits restrict password attempts per email (8 per 15 minutes).
- Verification is single-use and bound to the exact Supabase Auth session.
  Successful verification records the login before authenticated cookies are set.
- Both server authorization and database RLS reject password-only Supabase tokens,
  including direct REST access outside the website.
- Verified CRM access expires after 12 hours. Logout immediately revokes that CRM
  session; inactive/deleted profiles cannot continue using existing tokens.

Email verification is an additional email-based step, not Supabase authenticator
`aal2`. Protect users' email accounts with strong authentication as well.
Authentication is deliberately unavailable when Supabase, migrations or SMTP
are not correctly configured; there is no demo-login bypass.

### Login activity and last used

Admins and Super Admins see device activity at `/admin/login-activity`, not on
the dashboard. Users shows each person's latest recorded use.
History stores verified sign-in time, last-used time, sign-out/expiry, email and
an approximate device label (for example, Windows computer or iPhone). Browser
names/versions and raw user-agent strings are not retained. IP and location
columns are removed from CRM login sessions and pending challenges by migration
`202610210011_device_only_login_history.sql`. This does not change Supabase's own
infrastructure/Auth logs, which are managed by Supabase.

Only Super Admin can use **Login activity > Sign out device** to revoke an
individual active CRM session, including their own. Other sessions stay active.
The Login activity device list shows only sessions that are not signed out and
have not expired. Signing out removes that session from this view on refresh;
historical database records and audit entries are retained. Users' last-used
timestamps remain historical activity, not an indication of current sign-in.
Revocation immediately blocks subsequent CRM/API/database requests from that
session; visible tabs return to login on their next activity check (within a
minute). Signing in again requires the password and a fresh email code.
Device labels are inferred from the request and are not unique hardware IDs.
Migration `202610210012_same_device_sessions.sql` adds an opaque device identifier.
A persistent HttpOnly, SameSite cookie identifies a browser installation; only
its keyed hash is stored with the challenge and verified session. After a fresh
email code succeeds, a new login atomically signs out the previous session for
that account and device, leaving one active entry. Other devices and accounts
are unaffected, and unsuccessful verification never replaces a session.
Different browsers, private windows or cleared cookies count as separate devices.
Older sessions without this identifier cannot be matched retroactively; sign
them out once or let them expire. No additional environment variables are needed.
Last used updates on authenticated requests and once per minute while
the workspace tab is visible; it is not a precise keyboard/mouse activity log.
Apply your organization's retention/privacy policy to stored login and lead data.

## Live CRM behavior

- Dashboard counts and stage distribution use accessible database leads, not
  hard-coded metrics. Daily dashboard counts use UTC and are labelled accordingly.
- Leads, detail edits, stage changes, transfers, archives, notes, activity history,
  email delivery records, CSV imports and pipeline actions persist in Supabase.
  Database policies and server routes enforce permissions and hierarchy.
- Lead merges require `leads.merge`, a matching normalized phone **or** email, and
  both records in the caller's merge bucket: counselors' own assignments,
  Team Lead/Manager recursive teams, or all assignments for Admin/Super Admin.
  A `users.view` override does not expand the merge bucket. Counselors receive
  merge permission by default; explicit permission denials remain respected.
  These rules are rechecked in the locked database transaction, not only the UI.
  The destination's
  fields are retained, related records are moved transactionally, and the source
  is archived with a link to the destination rather than deleted.
- Settings persists stages, custom fields and duplicate rules. Removed stages are
  deactivated so historical lead references survive.
- Saved filters, column preferences and reports are database-backed and private
  to their owner. Reports store filter/column configuration, not a frozen lead
  snapshot; results reflect currently accessible records.
- Lead CSV exports require Admin/Super Admin. Report downloads require
  Manager/Admin/Super Admin and the export permission. Export checks run on the
  server, not only by hiding buttons.
- Users and reporting hierarchy are real accounts. Hierarchy cycles and disabling
  the last active Super Admin are rejected. Role grants and individual exceptions
  persist with audit history; they do not replace hierarchy scoping.
- Meetings can be internal or Zoom-hosted. Invoices persist discount approvals,
  installment/course balances, Payment Link and email state, and verified payments.
- Automations execute supported manual or overdue-follow-up batches with
  notification/follow-up actions and transactional logs. They are **not** an
  unattended scheduler; use the Run action. Notifications shows real recorded
  notifications.
- Integration screens show configuration status and supported real actions.
  Configuration presence alone does not prove provider credentials are valid.

### Filtering conventions

Dashboard is available to all default roles and uses the authenticated database
client (RLS remains enforced). Counselors see assigned leads only; team leads
and managers see their own and active recursive reportees' assigned leads.
Admin and Super Admin see all RLS-accessible leads, including unassigned leads.
Maintain the Reporting to hierarchy in Users for team dashboards.

New lead opens a dedicated `/leads/new` page instead of expanding the list.
The page retains configured fields, assignment permissions and duplicate-policy
confirmation. Saving opens the created lead; Back to leads returns to the list.
Legacy `/leads?create=1` links redirect to the new page.

Buttons and navigation use ring-free hover, pressed and focus states throughout
the site. Keyboard focus remains visible through tonal changes rather than
an outer border. Form input focus indicators and the selected navigation
marker are retained.
The sidebar hides its scrollbar while retaining wheel, touch and keyboard
scrolling. Compact-height layouts reduce menu spacing; mobile navigation uses
a viewport-sized drawer. Help & support is no longer shown in the sidebar.
The shared sidebar uses compact muted-navy navigation, consistent icons, a
single profile divider and a readable role label. Menu visibility still follows
the signed-in user's permissions for every role; empty groups are omitted.
Touch devices retain larger navigation targets.

Lead activity is the first chart below the KPI cards. Course and country
charts share a muted palette with the stage distribution; conversion charts
consistently use soft teal. Dashboard colors do not change configured stage
colors elsewhere in the CRM. Course and country
panels show stacked column charts with axes, gridlines, clickable stage segments
and legends; category labels open all leads in the group. Conversion rankings
and country/course combinations use percentage column charts on a fixed 0-100%
axis. Empty panels retain chart axes without inventing bars. Charts scroll
horizontally for additional categories; hovering shows full names and values.
Overall conversion uses a clickable donut, and follow-ups use due-today
and overdue bars. No individual-lead tables are shown on Dashboard.
Country + course conversion adds a bar for every observed pair, including 0%
conversions. Its denominator is total leads in that same pair, not the country
or course total. Pair labels/counts open all matching leads; conversion bars
open only converted leads matching both values. Role scoping is unchanged.
Course and country panels show totals and current-stage counts. Conversion
means a current stage of **Closed Won** or **Already Enrolled**, not every
terminal stage. Conversion rate is converted leads divided by total leads,
all time. Rankings sort by rate, then converted count; groups without a
conversion do not appear in rankings. Missing course/country values appear
as Not specified. Counts, stage chips, conversion rankings, daily activity
and KPI cards open matching, role-scoped Leads views. Daily/new-today and
due-date dashboard drilldowns use UTC dates consistently with the dashboard.

The live Leads page uses a unified CRM workspace: search, views, conditions and
saved filters in the left panel; the current view, record count, results search
and column preferences above the table. Export CSV and New lead remain in the
page action bar, subject to permissions. Refresh and Import CSV are not shown
in this action bar; the separate Import navigation entry remains available.
The Columns dropdown floats over the page without moving the table and provides
a searchable, scrollable list with one column per row. Each checkbox change is
saved automatically to your account; at least one column must remain visible.
Failed saves show an error without changing the previous selection.
Field, operator and choice-value menus reuse the searchable demo dropdown,
including multi-select choices, field-specific date operators and inline
validation. Stage and assignee choices include the active configuration even
when there are no leads. Saved filters and columns persist to the signed-in
account, not demo/local storage. On smaller screens the panel stacks above
the results to keep controls usable.

Authenticated pages reuse the retained demo design system (Inter typography,
navy navigation, compact cards, tables, badges and form controls). The dashboard
chart uses actual seven-day lead counts, the pipeline journey uses configured
stages, lead details use overview/notes/activity/email tabs, and internal meetings
use the calendar/agenda layout with staff attendees, Zoom join links, and
email/ICS invitations. Only managers and administrators can schedule meetings.
Reports, invoices, users, integrations, import and
settings share the same styling with live data and existing permission checks.

Pipeline uses a unified Kanban workspace with configured stage columns, record
counts, owner and stage filters, My leads only, and search across lead contact,
course, country and owner information. Sort cards by newest, next follow-up
(unscheduled last), or name. Clear filters restores all accessible records.
The admissions journey is available in an expandable guide rather than a
second permanently visible stage track. Cards retain lead details, owner,
follow-up and stage menus; drag-and-drop and menus save through the same
permission-checked stage update. Concurrent moves are blocked while saving,
errors are displayed, and read-only users cannot move cards. Leads without a
currently configured stage appear in No active stage.
Empty states are genuine; sample leads, fabricated chart trends and simulated
provider actions are never substituted for missing database/provider data.

Choice fields use anchored searchable menus with internal scrolling. Arrow keys
navigate, Enter selects and Escape closes. Multi-select filters remain open.

Leads filters support field-specific text, choices and dates, including On/Not on,
Before/After, inclusive boundaries/ranges, calendar weeks/months and relative day
counts. Weeks start Monday; relative day counts include today. Filter date
comparisons use the browser's local timezone. Invalid conditions cannot be saved.

Last Modified filters the editor, while Modified filters the edit date. Untouched
means never edited since creation, not never contacted. Unknown edit history
matches neither untouched nor edited. Untouched date conditions use creation
eligibility plus the absence of edits in the requested interval. Legacy names
load automatically. All edit timestamps are recorded; when earlier history is
unknown, results are conservative rather than invented.

Most Recent Visits requires a website-origin source and a real recorded visit.
Manual, Referral, Google Ads, WhatsApp and Chatbot dates do not count as website
visits. Live visit telemetry requires your website integration to supply real
events; a lead's mere existence is not a website visit.

## Provider setup

### Credentials managed in CRM

The Integrations workspace has a searchable, category-filtered app catalog.
Opening **Configure** replaces the catalog with that provider's guided workspace:
prerequisites, numbered external/CRM steps, field-level credential guidance,
verification and troubleshooting. Return with **All integrations** or switch
providers in the setup header; unsaved settings require discard confirmation.
SMTP port/encryption and Zoom host mode use labeled choices rather than raw
boolean text. Existing secret values remain write-only.

The **Website / chatbot** guide includes a developer handoff with website-server
environment mappings and a signed Node.js request example. It is a backend
integration contract, not an embeddable public browser form. Contact forms and
chatbots should have separate source keys; the website must persist the enquiry
ID for safe retries. The Facebook guide explains app credentials, Page tokens,
subscriptions, form IDs and exact/fallback routes as distinct setup tasks.
Workspace links lead directly to Page connections, source routing and the user's
mailbox. Long guides remain scrollable rather than clipping instructions.

Page connections and the personal inbox show a compact empty state instead of
an empty table header. Source creation uses an aligned two-column form (one
column on mobile), with optional Origin restrictions collapsed under Advanced
and Save/Cancel actions grouped in its footer. Inbox privacy details remain
available in an expandable disclosure.
Source creation validation and server errors appear beside the source form.
On success, a focused credential receipt displays the Source ID and one-time API
key in selectable fields. Save them before dismissing or leaving the page; keys
are not persisted in browser storage and cannot be read back from CRM. Facebook
routes explicitly explain that they use Page tokens rather than website keys.

Apply migrations `202610230005_integration_credentials.sql` and
`202610230006_multi_source_connections.sql` before deploying this feature, using
the checksum-tracked migration process above. Open **Integrations** to configure
Zoom, Razorpay, SMTP, Google OAuth, website/chatbot signing and the Meta app.
Only an **Admin or Super Admin** with `integrations.manage` can read configuration
metadata or change shared credentials, Page tokens, source assignments and form routes.
Other authorized viewers get setup guidance, not credential metadata.

Credentials are AES-256-GCM encrypted in service-only tables with no direct
anonymous/authenticated access. The UI never retrieves saved secret values:
blank secret fields preserve the existing value; enter a replacement to change it.
Updates detect stale revisions rather than overwriting another administrator.
Keep `AUTH_ENCRYPTION_KEY` stable and backed up separately. Losing it makes stored
credentials unusable. Saving a provider replaces its entire environment fallback,
and all runtime consumers read the saved configuration without a restart.
Environment defaults apply only if that provider has no saved CRM record; database
failures never silently switch back to environment credentials.

Server bootstrap still requires `NEXT_PUBLIC_APP_URL`, Supabase URL/anon/service
keys, `AUTH_ENCRYPTION_KEY` and a deployed schema. `DATABASE_URL` and its CA are
needed only for the migration tool. SMTP environment defaults are needed to receive
the first login code before CRM configuration is available.

**Configured** means required values exist, not that external access was proven.
Save, run the saved-settings check, complete provider-console permissions and
subscriptions, then exercise a real workflow. Unsaved edits disable testing.
Zoom checks authentication/host lookup; Razorpay reads the Payment Links API without creating
a link or charge; SMTP verifies authentication and optionally sends to the current admin's
login email (acceptance is not delivery). Gmail setup and intake HMAC checks are
local only: Google consent and an actual signed website request prove connectivity.
Meta app identity and per-Page forms/subscription checks do not prove lead retrieval.
No check creates a meeting, charge or lead.

Incorrect SMTP settings can prevent future sign-ins: verify authentication and
test delivery immediately, and retain administrative server/database recovery
access. Changing the Google OAuth client requires existing users to reconnect.
CRM cannot grant Google/Meta app approvals, activate provider accounts or register
remote webhooks automatically. Provider webhooks need a publicly reachable HTTPS
URL; localhost alone cannot receive them.

### Zoom

Configure and activate a Server-to-Server OAuth application with meeting and user
read access. Save the account ID, client ID/secret, webhook secret and host in
**Integrations > Zoom**. Register `/api/webhooks/zoom` for `meeting.started` and
`meeting.ended` with the same webhook secret token. The integration uses the configured Zoom host or (when explicitly
enabled) the CRM host email. No Zoom credentials are sent to the browser.

### Razorpay

Save the Razorpay key ID, key secret and separate webhook signing secret in
**Integrations > Razorpay**. Enable Payment Links and register
`/api/webhooks/razorpay` for `payment_link.paid`. The endpoint verifies the raw
signature, invoice/link reference, payment ID, amount, currency and captured state.
Verified payment recording is idempotent; link existence and browser redirects do
not mark invoices paid. A random-token public invoice status URL is emailed beside
each short payment URL and reveals only invoice/course, amount and status.

### Invoice workspace

The main Invoices page and each lead's **Invoices** section share one register,
searchable status filters, billing form, itemized preview and PDF, approval,
email and payment actions. The lead section requires `invoices.view`;
its API checks access to the lead and filters by lead **before** the 200-record
limit. The main register remains scoped by database row-level security.
Creation requires `invoices.create`; discount approval and external-financing
verification require `invoices.approve` (Admin/Super Admin by default). Invoices
support one-shot, installment, EMI and loan modes. Discounts use a percentage and
mandatory reason; discounted invoices await approval, while un-discounted
invoices issue immediately and automatically create a Razorpay Payment Link
(one-shot/installments) and email the lead plus invoice creator when available.
Each later installment is a separate invoice linked to its course invoice. The
database prevents overlapping unpaid installments and amounts beyond the remaining
course balance.

Each lead also has **Invoices | Timeline** tabs. Invoice history uses persisted
creation, approval decisions, SMTP acceptance and verified payment timestamps.
Actor names are shown where permitted; historical names that cannot be resolved
are explicitly marked unavailable. Service-generated events identify the service.
Lead timelines use dated activity cards with actors and recorded field changes;
they do not invent changes for legacy records.

Invoice and receipt emails use the existing configured **finance SMTP** sender;
this is separate from personal Gmail in the lead Emails section. SMTP acceptance
does not guarantee inbox delivery. EMI/loan installments are tracked externally;
only a verified Razorpay webhook or an authorized staff confirmation with a
reference and evidence can mark an invoice paid. Missing provider configuration
is reported, and ambiguous provider/email operations remain locked for reconciliation.
Apply the new `202610240001_invoice_payment_links.sql` migration before rollout.

### Lead workspace and personal Gmail

The website uses a borderless visual theme: panels, tables, forms and tabs are
separated by spacing and subtle surface colors rather than decorative outlines.
Inputs keep a soft fill, selected tabs use a tinted background, and validation
messages remain visible. Keyboard-only focus indicators are retained for
accessibility; dropdowns and dialogs retain soft elevation. The email composer
places sender, recipient and Gmail connection controls together without nested
framed cards. These presentation changes do not alter permissions or delivery.

On desktop screens (1100px and wider), lead details use a compact header and
one continuous three-column field grid without section headings or divided panels.
Custom fields appear alongside the standard fields. The standard overview, including
two custom fields, fits at 1280x720 without page scrolling. Narrow screens stack
the fields for readability. Longer custom-field configurations, validation
errors and expanded related records can still require scrolling; content is
never clipped or hidden to force a fit. Inline autosave behavior is unchanged.

Lead detail headers include **Click to call** and **Schedule a call** for users
with `leads.edit`. The Send email shortcut, Archive and Refresh header actions
are omitted; the Emails workspace remains available.
**View duplicates** and **Merge duplicates** appear only when another active,
unmerged lead matches either normalized phone or email, independently of the
creation-time duplicate policy. All lead viewers can view duplicate assignee
names across buckets; no hidden lead IDs, contact data or links are exposed.
Merge is disabled unless an eligible destination is in the caller's merge bucket.
Apply `202610230001_lead_duplicate_actions.sql` before deploying this UI/API
change. No environment variables are added.

Click to call opens a `tel:` link using the
lead's phone and selected country calling code. It requires a configured phone
handler on the device; it does not simulate a provider call, record a call outcome,
or charge an IVR provider. Invalid phone numbers disable the action.

Schedule a call saves a future date/time in the existing `scheduled_calls` table
under the signed-in user. Browser-local time is converted to UTC for storage and
shown in local time, including after refresh. The lead header area shows just
the next upcoming call and upcoming/past-due counts, regardless of appointment
count. **View all calls** opens the dedicated **Calls** workspace, also available
in the left section navigation. The right pane has only the selected section,
not a duplicate section navigation bar. Selecting Overview on the left opens two
local tabs: **Overview** for the inline lead fields and **Timeline** for that
lead's change history. Only the selected tab's content is shown; returning to
Overview from the left resets to the fields. Notes, Emails and Calls also have
their own main tab and **Timeline** tab; composers/appointments and history are
never displayed together. Each timeline contains only its section's history,
including call events only in Calls (not Overview). Left navigation resets to
the selected section's main view, preserving unsent drafts. Successful note/email
submission opens that section's Timeline. Read-only users can still view all
authorized timelines. The local tabs support arrow keys, Home and End.
Every scheduled appointment is retained:
upcoming calls sort earliest first, past-due calls newest first, in a bounded
scrollable list with a light scrollbar. Due indicators refresh every 30 seconds
while the page is open. A past-due appointment is not assumed completed.

An overdue **lead follow-up** is handled automatically when a lead field actually
changes: if the old follow-up timestamp has passed and is left unchanged by the
edit, it is cleared. A newly chosen follow-up timestamp is preserved, including
an explicitly chosen past date. Future follow-ups, no-op saves, notes, emails and
call-status-only changes are unaffected. The old date and the clearing edit are
retained in the Overview timeline. Dashboard counts, lead filters and overdue
automation batches all use the persisted date, so handled leads stop matching
those overdue queues on reload. Scheduled call appointments are separate.

Apply `202610230004_handle_overdue_followup_on_edit.sql`. It also repairs existing
overdue follow-ups only where the latest detailed lead-edit log proves that a
field was changed after the follow-up fell due without deliberately replacing
the follow-up date. Legacy records without that evidence are not guessed.

After scheduling, another appointment is blocked until an actual lead field
change or an existing call is rescheduled, marked completed or cancelled. Time
passing, notes/email additions and no-op saves do not unlock it. The database
serializes scheduling on the lead row, so concurrent submissions cannot bypass
this rule. Calls provides Reschedule, Complete and Cancel call actions.

Apply `202610230002_lead_call_workflow.sql` and
`202610230003_merged_call_schedule_revision.sql` before deploying. Merging
appointments reconciles the destination's scheduling revision so moved calls do
not leave it incorrectly locked. New lead change
logs retain the actor name and before/after field values; call changes have their
own timeline. Each timeline shows the actor, action and local date/time. Legacy
records without detailed field values are labelled rather than inventing history.
This is a CRM appointment only: no automatic dialing, external calendar event,
or scheduled reminder is implied. Scheduling does not change the lead's existing
next-follow-up field. No additional migration or dialer credentials are required.

Lead details use inline editing: text fields save on blur or Enter, and dropdowns
save on selection. There is no separate Edit or Save button. Each field reports
saving, saved, or a retryable error. Escape discards an unsaved text change.
Assignment still requires `leads.assign` and confirmation; viewers remain read-only.
Selecting leads shows right-aligned **Update status**, **Transfer**, and **Delete**
actions according to access. Transfer requires lead editing/assignment permissions
and a Team Lead, Manager, Admin or Super Admin role. Its dialog asks for an active
assignee and an updated stage. Both dropdowns support text search, keyboard
navigation and scrollable options.
Dropdown menus stay inside the modal's top layer so they remain visible and interactive.
**Keep current stage** is selected by default and preserves each selected lead's
stage. Choosing another CRM stage updates it in the
same request as the assignee. Delete requires `leads.delete` and an Admin or Super
Admin role, with server-side enforcement. Delete retains the existing soft-delete
behavior: leads are archived from active views, with history preserved.
Overview has a separate record-change/activity timeline, Notes has a note timeline,
and Emails has an incoming/outgoing message timeline with sender and status.

Enable Gmail API in Google Cloud, configure the OAuth consent screen and its
test users or approved production audience, and save `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI` in **Integrations > Gmail mailbox**.
Register the exact redirect URI:

```text
https://your-crm-host/api/auth/gmail/callback
```

The redirect must match `NEXT_PUBLIC_APP_URL` plus that path. Connect the mailbox
from Integrations or the lead's Emails tab. Users with `leads.edit` can connect
their own mailbox without integration-management permission. OAuth uses Gmail
read-only and send scopes, PKCE and browser/session-bound,
single-use state; credentials are stored encrypted in service-only tables.
Google may require app verification before external users can authorize access.

Sync is a **manual pull** with durable page queues and Gmail history cursors.
Continue syncing until caught up; no scheduler is implied. Expired Gmail history
requires the explicit reset action. Attachments are not downloaded.
Lead email is sent through the Gmail API using only the **signed-in user's**
encrypted mailbox credentials, never the lead owner's credentials or shared SMTP.
The connected Google Workspace mailbox must match the authenticated CRM login
email (case-insensitive). OAuth suggests that address, rejects a different
mailbox before saving credentials, and sending rechecks existing connections.
For example, a user logged in as `guneswari@dmhca.in` sends from that address;
another counselor authorizes and sends from their own login address.
Click **Connect Gmail** in the lead's Emails tab and approve Google's read/send
consent using your company account. CRM password login does not authorize Gmail.
Existing read-only connections must reconnect and grant both scopes before sending.
No connected mailbox or insufficient consent blocks sending explicitly.
The email timeline records the actual From address and Gmail message ID.
Provider acceptance is not recipient delivery confirmation. If a request times out
or logging fails after acceptance, check Gmail's Sent folder before retrying.
SMTP remains required for login verification and existing invoice delivery.
Local disconnect retains CRM email
history; revoke remote access in Google Account settings if required.

### Website and chatbot lead intake

Generate a separate random `LEAD_INTAKE_SIGNING_KEY` of at least 32 characters
and save it in **Integrations > Website / chatbot**. Create as many named sources
as needed (one per website/chatbot),
select its active assignee/stage and securely store the source UUID and API key.
The per-source key is displayed once and only its hash is retained.

Your **trusted backend**, not browser JavaScript, sends:

```http
POST /api/webhooks/lead-intake
Content-Type: application/json
Authorization: Bearer SOURCE_API_KEY
x-crm-source: SOURCE_UUID
x-crm-timestamp: UNIX_SECONDS
x-crm-signature: v1=HEX_HMAC_SHA256
```

```json
{
  "event_id": "your-durable-submission-id",
  "lead": {
    "name": "Person",
    "phone": "+919876543210",
    "email": "person@example.com"
  }
}
```

Calculate the hexadecimal HMAC-SHA256 using `LEAD_INTAKE_SIGNING_KEY` over the exact
string `TIMESTAMP + "." + RAW_JSON`. Sign the same raw bytes you transmit.
Optional lead fields are `country`, `course`, `qualification` and `message`.
Map the contact form's textarea to `lead.message` (maximum 10,000 characters).
A non-blank message automatically creates a note labeled with the source name,
on either the new lead or the existing matched lead. External notes are attributed
to System, not a counselor, and appear in the Notes timeline with their timestamp.
Blank or absent messages create no note. Notes, events and lead creation commit
atomically; retries using the same source/event ID do not duplicate notes.
Apply migration `202610230007_intake_message_notes.sql` before using this field.
Chatbot requests
may include `transcript: [{ "role": "user", "content": "..." }]` with roles
`user`, `assistant` or `agent`.

The signature has a five-minute acceptance window. Payloads are limited to 512 KB
and sources to 60 requests/minute using persistent rate limits. Reuse the same
`event_id` when retrying a submission; retries are idempotent. Client-supplied
assignment fields are rejected. With duplicate block/warn policies, intake attaches
the event to a matching existing lead without overwriting/reassigning it. The
allow policy creates a separate lead. Never embed source/signing keys in public
forms or chatbot frontend bundles.

### Facebook Lead Ads

In **Integrations > Facebook Lead Ads**, save `FACEBOOK_APP_ID`,
`FACEBOOK_APP_SECRET`, `FACEBOOK_WEBHOOK_VERIFY_TOKEN` and `FACEBOOK_GRAPH_VERSION`
(a supported version for your Meta application). Configure this webhook:

```text
https://your-crm-host/api/webhooks/facebook
```

Use the same verify token, subscribe the Page's `leadgen` events, and ensure the
Page token/app has reviewed `leads_retrieval` access and appropriate Page/lead access.
In **Facebook Pages**, add each numeric Page ID and its own Page access token.
Tokens are encrypted and never returned; replace, pause or remove each connection
independently. **Check Page** verifies identity, lists readable forms and checks
whether this app is subscribed. Truncated results are explicitly marked and do not
prove a missing subscription. Page tokens still require reviewed permissions,
lead access and renewal when expired/revoked.

Create a Facebook source for each Page/form with its assignment/stage. Enter a
Form ID for an exact route; leave it blank for one Page-wide fallback. Exact form
routes take precedence, including disabled exact routes (they do not silently
fall through). Multiple Pages and multiple forms per Page are supported under
one Meta app. Lead forms must collect name and phone. Signed events retrieve
actual lead fields from Graph API; durable events prevent duplicate retry imports.
The old single-Page environment defaults remain supported when no corresponding
saved Page connection exists. Deleting that connection may reactivate a matching
legacy fallback; remove the environment defaults if that is not intended.

### Integration boundaries

IVR calling needs a selected provider, its API contract and webhook signing
configuration. No provider was specified, so calling is explicitly unavailable;
entering an IVR extension alone does not enable telephony.

Provider calls and database transactions cannot form one atomic transaction. A
process interruption during email delivery, Payment Link creation or external meeting
creation may require reconciliation with the provider. Do not blindly retry an
operation whose delivery/result is uncertain.

## Validation

### Live-page presentation

Authenticated pages use the DMHCA navy/blue design shared by the earlier demo:
consistent form controls, feedback, tables, panels and responsive settings
navigation. Dashboard stage bars and follow-up cards use accessible live leads;
the meeting calendar counts only the loaded accessible meetings. No sample
records, demo role switching or authentication bypass are enabled in the app.

`tests/live-ui.test.cjs` renders page and form states with isolated test records,
including the authenticated shell, dashboard, leads, pipeline, reports, calendar,
invoices, automations, integrations, users and settings. These fixtures are test
data only, not a substitute for reviewing your signed-in workspace.

- `npm test`: filter, authentication, provider-validation and live-data regression
  tests, plus actual PostgreSQL migration/RLS/workflow tests using PGlite.
  The test database bootstraps Supabase's Auth schema/claims and roles;
  production migrations run unchanged apart from omitting the pgcrypto extension
  declaration because PostgreSQL's built-in UUID generator is available in PGlite.
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm audit --omit=dev`

The PostCSS npm override keeps Next.js's transitive PostCSS copy on the same
patched 8.x version as the project, without an unrelated framework-major upgrade.
Existing development-tool dependency advisories are separate from the production
dependency audit and should be reviewed during toolchain maintenance.

Do not run a build beside a dev server using the same output directory. For an
isolated check in PowerShell:
`$env:NEXT_DIST_DIR='.next-validation'; npm run build`.

Tests do not replace deployment checks. Before launch, configure real credentials,
apply migrations to the target Supabase project, test SMTP delivery and expired/
incorrect codes, test multiple roles and direct REST denial before verification,
and exercise each configured provider with its test account/webhooks. A local
build cannot certify live email delivery, provider approvals, DNS, network access,
payment settlement or your deployment's network configuration.
