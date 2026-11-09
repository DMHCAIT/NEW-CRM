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

### Troubleshooting production login

Local `.env.local` values are not deployed through Git. Configure the Production
environment in Vercel and redeploy after changes. The public application URL must
match the browser origin; keep the encryption key unchanged when sharing a
database containing encrypted integration credentials.

Database failures during password login return HTTP 503 with a safe reference:
`LOGIN_RATE_LIMIT` (rate-limit function), `LOGIN_PROFILE` (profile lookup),
`LOGIN_CHALLENGE` (pending verification insert), or `LOGIN_CHALLENGE_CLEANUP`
(previous pending verification removal). Vercel runtime logs record that reference
and a sanitized provider error code, without database response details or tokens.
Use these to identify the failing operation before changing keys or migrations.
An invalid password still returns 401, rate limiting returns 429, and failed
verification email delivery returns 503 with an SMTP-specific message. If a generic
500 remains, inspect the failed request's Vercel runtime logs; the browser console
alone does not identify its cause. Never share credentials or request payloads.

### Performance and local preview

Use `npm run build` followed by `npm start` for production-speed serving.
`npm run dev` compiles routes on demand and is not representative of production
loading times. Development output is isolated in `.next-dev`; production uses
`.next`, so building no longer overwrites the running development server's assets.
`NEXT_DIST_DIR` can override either directory; use distinct values if running both.
For routine local use, leave the production server running on the configured
application port; return to `npm run dev` only when editing with hot reload.
Rebuild and restart the production server after changing code. A loading skeleton
does not remove development compilation or database latency.

Lead screens reuse browser-memory responses for up to 30 seconds when revisiting
a page; valid cached data renders immediately instead of flashing a loading screen.
After a 1.5-second startup delay, the sidebar prepares permitted client-rendered
sections in a bounded queue (at most two sections at a time), overlapping full
route preparation with their API reads before a click. The current route is also
prepared for a quick return visit. The queue stops launching work when the tab
is hidden, the shell unmounts, or identity/permissions change. Dashboard and login
activity are excluded from this preparation queue.
Hover, keyboard focus and touch prioritize the selected route immediately.
Explicit full route preparation is deduplicated for 25 seconds; automatic Link
viewport prefetch is disabled so it cannot compete with the bounded queue.
Intended client-rendered sections use Next Link's full prefetch rather than the
automatic mode that can stop at a dynamic route's loading boundary. Dashboard
and login activity are not fully prefetched in the background.
Clicking any internal section link immediately updates the navigation and breadcrumb
and shows a destination-specific skeleton, keeping the previous page hidden and inert
until the route is ready. Existing route layouts remain mounted during the transition.
Modified clicks, downloads, external links and same-page anchors retain native behavior.
A click starts data preparation and one navigation, not a second route prefetch
competing with navigation. Leads
and Pipeline also start their existing 30-second cached data request on intent,
overlapping route loading rather than waiting for the destination to mount.
Operational sections start fresh data reads on hover, focus, touch or click.
The destination consumes that preparation once, even if it finishes before the
route mounts; a completed preparation expires after five seconds. This bounded,
20-entry browser-only handoff is not a reusable financial response cache.
Completed preparations also provide the destination's first render synchronously,
avoiding another loading flash in operational pages, Users, Reports and Settings.
Access settings and administrator integration panels participate in section
preparation. Only authorized section reads are prepared: no background mailbox
sync, provider mutations, or preparation of every lead record is started.
Users and Reports can render a recent display snapshot while their mount read
checks current records, just like operational sections.
Later visits, manual refreshes, polling and post-write refreshes read current
records. Identity changes, authorization failures and writes discard preparations,
including preparations still in flight.
Concurrent reads share one request. Manual refresh always requests fresh
data, and API writes invalidate cached reads before and after the write.
No response cache is persisted or shared between browsers or server requests.
Next's browser route cache retains rendered and prefetched pages for at most
30 seconds, including the first section visited, so returning to that page does
not repeat the route-authentication round trip. A completed API write (including
a failed write that may have partially applied) clears data snapshots and refreshes
the router cache; this refresh does not block the save response. Server-rendered
summary pages may reuse their recently rendered view within this short window.
Invoices, payment status and operational screens continue to request fresh data;
refreshing existing data happens in place rather than blanking the screen.
Operational screens may show a browser-only display snapshot (at most 30 seconds
old, bounded to 50 entries) while checking current records in the background,
with a "Checking latest records..." indicator. Display snapshots never satisfy
a fresh API read or suppress payment polling. Writes, identity changes and
authorization failures discard them, including in-flight results.
Dashboard drill-down filters are read before the Leads workspace mounts, including
query-only navigation and browser history. The first request uses the selected
criteria and role scope; an invalid filter shows an error without requesting all leads.
Operational pages show a section skeleton until their initial response arrives
instead of rendering empty/default records. Responses from a previous URL cannot
replace newer operational data.

The top-bar lead search shows up to six matching leads as you type, with a link
to all matching results. Enter is not required. Lead and Pipeline server searches
wait 120 ms after typing pauses to avoid a request for every keystroke.
Local searches (users, courses, invoices, staff and dropdown options) filter
immediately. Lead searches and pagination reuse the initial list's metadata
while its 30-second browser snapshot is valid, requesting only paginated records
instead of reloading profiles, stages and settings on each query. Refresh and
mutations bypass/invalidate that snapshot. Search responses remain permission-
checked on the server; late responses cannot replace a newer query.

Lead-record links prepare the route and overview data on hover, keyboard focus
or touch, not only after navigation has finished. Full route prefetch is used
rather than stopping at the dynamic route's loading boundary. Lead links disable
automatic viewport prefetch to avoid authenticating every visible record route
in competition with the selected page. A direct click starts the API
read alongside navigation. Preparations are bounded and deduplicated; they do
not download every visible record. Detail pages and related tabs reuse fresh
list metadata (stages, profiles and field settings) while requesting current
record-specific data and authenticated identity. Completed preparations render
synchronously. Direct entry and explicit refresh still load complete metadata;
writes, identity changes and authorization failures invalidate browser snapshots.
Opening a lead starts one authorized workspace preparation for Notes, Emails
and both activity timelines without waiting for a related-list click. The first
overview is not blocked by this work. Successful sections share that bounded
30-second response; failed sections show an explicit preparation error and retry
their own endpoint rather than appearing empty. Course and invoice components
and their APIs are also prepared for users with invoice-view permission.
Calls, Courses and Invoices reuse the current overview instead of making another
lead-detail request. Initial detail metadata can also seed subsequent related
reads when entering a lead directly, without first visiting the lead list.
Inline field saves return the database's updated record, including trigger
changes, and update the displayed lead after server confirmation instead of
waiting for PATCH followed by a full detail GET. Writes still invalidate prepared
histories; related data is prepared again after edits and action refreshes.
Lead detail API responses expose `Server-Timing` for authentication, record lookup
and related reads so deployment/database latency can be diagnosed separately.
These changes require rebuilding and deploying the updated code to affect the
live site; pushing source alone does not replace a running production process.
Prepared views can switch without a network wait. Cold visits, expired snapshots
and writes still depend on authentication, database and network latency; a
universal one-second guarantee requires measuring and tuning that deployment.

Protected-page middleware loads verified session, active profile and current
permissions in parallel after authentication. It passes that result to Server
Components through a request-only header. Both the root layout and server-page
guards reuse this verified identity, avoiding a second authentication waterfall
during rendering. Middleware removes browser-supplied values of that
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

#### Record and billing workspaces

Lead records use related-list navigation for Overview, Notes, Emails, Calls,
Invoices and Courses. Overview groups contact information, admissions and
ownership, and additional fields; existing inline-save and permission rules apply.
Notes and Emails show their existing history alongside the composer (stacked on
smaller screens). Read-only users can read history without compose controls.
Call appointments retain local-time scheduling, rescheduling and outcome actions.

The record UI requests `/api/leads/:id?section=overview` initially. Section-specific
reads omit unrelated note/email bodies and do not resolve Gmail until Emails opens.
`history=1` loads record/call activity only for the corresponding Timeline view.
Sidebar note/email counts use RLS-scoped count-only queries. Omitting `section`
retains the complete response for existing consumers. History initially renders
25 entries with an explicit option to show older entries. Invoice and catalog
components load in separate JavaScript chunks when their related lists open.

Search controls share single-row icon/input geometry in tables, Pipeline,
Integrations, attendee selection, column selection and searchable dropdowns.
Inputs shrink within their container rather than wrapping below their icons.
The whole control retains a visible keyboard-focus indicator.

The shared course catalog provides search, availability filters and 25-row pages
in both lead records and the standalone Courses workspace. Billing-company
profiles have a separate view. Catalog prices are references, not enrollment
records; course selection and pricing confirmation still happen in invoice creation.
Invoice views group all invoices, approvals, awaiting payment and paid records.
The register renders 25 rows at a time; filtering and totals cover all fetched
records, including records beyond the first page. Financial data still refreshes
from the server, and payment, approval, reconciliation and tax policies are unchanged.
These changes do not constitute a guaranteed Zoho-equivalent response-time SLA.

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
  Pipeline skips saved-filter, column-preference and lead-configuration reads that
  the board does not use. Stage queries begin as soon as the stage list arrives,
  without waiting for the staff list. Returned IDs are deduplicated and lead
  records are fetched in shared batches of at most 100 IDs, still under the
  caller's RLS policies. Twelve full stages therefore need three record reads,
  not twelve; stage cursors and ordering are preserved. No new migration is needed.
- Lead API responses include `Server-Timing` entries for `auth` and `data` so the
  browser Network panel can distinguish authentication latency from database work.
  Responses stay private/no-store; timings contain no credentials or record data.
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

#### Local development and live deployment

The app and database migrations must use the same Supabase project. A message such
as `column leads.billing_address does not exist` means the database is behind the
application, not that the lead data should be cleared. That column is added by
`202611030002_course_billing_stripe.sql`; Gmail access also needs the Workspace
and mailbox-permission migrations. Apply all pending migrations in filename order.

For local development with the hosted Supabase project:

```sh
npm run db:check
npm run db:migrate
npm run db:check
npm run dev
```

The first check exits unsuccessfully if migrations or required columns are missing.
Local commands load `.env.development.local`, `.env.local`, `.env.development` and
`.env` using Next.js development environment precedence. If a local PostgreSQL
instance has no TLS, explicitly set `DATABASE_SSL_MODE=disable`; this is allowed
only for loopback hosts. Hosted Supabase connections always verify TLS.

On the live server, configure `DATABASE_URL`, `DATABASE_CA_CERT_PATH`, Supabase
API keys, `AUTH_ENCRYPTION_KEY` and `NEXT_PUBLIC_APP_URL` as server environment
variables. Use the same stable encryption key when local and live share encrypted
integration credentials. Set the live build command to:

```sh
npm run build:live
```

This applies pending migrations before building and refuses deployment if they
fail. `npm run db:check:live` and `npm run db:migrate:live` are also available;
live migration commands never load local environment files, so a developer's
`.env.local` cannot silently select a deployment database. Run migrations only
from the controlled deployment step, not from public web requests.

Back up the database before migrations. For shared local/live databases, coordinate
schema changes with the running deployment. If SQL connections time out or reset,
copy the exact **Session pooler** URI from Supabase > Connect and check network
access, the database password and CA certificate. The Supabase API working does
not prove the administrative PostgreSQL connection is reachable.

Lead creation keeps separate country-code and phone inputs, but stores the combined
number in `leads.phone` (for example, `India (+91)` and `9123456789` become
`+919123456789`). Explicit `+` international numbers take precedence over the selected
code. `normalized_phone` stores the same digits without `+` for duplicate checks.
The country-code metadata is retained for input compatibility and filtering, but
is not a separate lead/report column or editable lead-detail field. Migration
`202610300002_combined_lead_phone.sql` formats existing records without changing
their edit history or follow-up state; numbers without a known code are not
assigned a guessed country.

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

Buttons use blue primary actions and bordered secondary actions. Keyboard navigation
has visible focus outlines and a Skip to content link. Form input focus indicators
and the selected navigation marker are retained.
The sidebar uses a thin scrollbar and retains wheel, touch and keyboard
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
Zoom, Razorpay, Stripe, SMTP, Google OAuth, website/chatbot signing and the Meta app.
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
not mark invoices paid. INR online invoices use Razorpay; USD uses Stripe.
Invoice email, CRM and PDF Pay Now buttons go through a random-token checkout
redirect directly to Razorpay (INR) or Stripe (USD), without an intermediate
invoice page. The redirect checks approval, expiry and Paid status before opening
checkout; Stripe sessions are safely reused or renewed when eligible. Provider
return pages use the same branded invoice template as CRM and email and refresh
verified status automatically. They expose only information printed on the invoice.

### Stripe (USD invoices)

Use the organization's Stripe merchant account enabled for USD payments.
In Stripe developer settings, obtain a **secret API key** (start in test mode).
In Workbench/Webhooks, add
`https://www.ibmpcrm.xyz/api/webhooks/stripe` and subscribe to
`checkout.session.completed` and `checkout.session.async_payment_succeeded`.
Copy this endpoint's signing secret, not the secret from a local CLI forwarder.
Save `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in **Integrations > Stripe**
or server-only environment variables. Never use a publishable key as the secret
key, mix test/live credentials, or expose either secret to browser code.
Test connection reads the account balance; it does not charge a customer.

A signed event must report a fully paid USD Checkout session with the exact
saved invoice/session IDs and amount. Unpaid asynchronous sessions remain pending.
Replayed events cannot create duplicate payments. A successful browser redirect
is never payment evidence. Keep webhook retries enabled and inspect failed
delivery attempts if payment is complete in Stripe but pending in CRM.

### Courses and company setup

Before deploying this billing build, apply
`202611030002_course_billing_stripe.sql` with the tracked migration process:
`npm run db:check`, then `npm run db:migrate`. Back up first and coordinate
migration and application deployment in a maintenance window: the new creation
function requires catalog inputs that older application builds do not send.
Do not rerun or edit an already-applied migration. This migration adds tables and
columns without deleting existing invoices, leads, payments or approvals.

Open **Courses** as an Admin/Super Admin with `settings.manage`:

1. Add each course's standard **INR and USD prices separately**. There is no
   automatic currency conversion. Staff with `invoices.view` can read prices;
   only administrators can change them or deactivate courses.
2. Complete DMHCA and IBMP's real legal billing names, addresses and applicable
   tax registration IDs. Issuance is blocked until the company address is set;
   no legal/tax details are fabricated.
3. Invoice PDFs and invoice delivery emails use the supplied logos and their
   palettes: DMHCA navy/red (`#1c1d4e` / `#a91e2c`), IBMP navy/teal
   (`#091b3c` / `#188574`). CRM, email and public status use one shared invoice
   template with the same company palette. Legal billing details remain snapshotted.

Invoice PDFs follow the reference's angled header/footer, bill-to and invoice
details, course table, totals, payment schedule and payment details sections.
The DMHCA PDF embeds `public/DMHCA-invoice-logo.png`, a lossless PNG conversion
of `public/DMHCA-Logo.webp` (PDF does not support WebP); IBMP embeds
`public/IBMP-logo.png`. Both assets are included in server output tracing.
Approved, unexpired online invoices have a clickable **Pay Now** PDF annotation
and email button. Both open the selected provider directly through the stable
checkout redirect, which creates/reuses an eligible Stripe session when needed.
Pending approval, tax review, paid, expired and financing invoices do not expose
a payable PDF button. Downloading a PDF never creates a payment link or sends mail.
Bank account details are not invented; payment details describe the configured
secure provider or finance arrangement instead.

Set each lead's billing address in Overview, or edit the prefilled invoice
address. Users with `leads.edit` can save the edited address back to the lead;
otherwise it is invoice-only. Issuing snapshots the billing name/email/address,
company details/colors, course item and price. Later catalog, company or lead
edits do not rewrite issued invoices.

### Invoice workspace

The main Invoices page and each lead's **Invoices** section share one register,
searchable status filters, billing form, itemized preview and PDF, approval,
email and payment actions. The lead section requires `invoices.view`;
its API checks access to the lead before loading records in 200-record batches.
The register loads all accessible invoices, not just the latest 200. Admin and
Super Admin can see every invoice, including archived-lead invoices; other staff
remain scoped by database row-level security.
Creation requires `invoices.create`; discount approval and external-financing
verification require `invoices.approve` (Admin/Super Admin by default). Invoices
support one-shot, installment, EMI and loan modes. Discounts use a percentage and
mandatory reason; discounted invoices await approval, while un-discounted
invoices issue immediately and automatically create a Razorpay Payment Link for
INR or Stripe Checkout for USD (full payment/installments). The lead is the
recipient; both the invoice creator and assigned lead owner are copied,
deduplicated case-insensitively. A valid lead email, billing address and active
assigned owner with an email are required. Discounted invoices are delivered
only after approval.
Apply `202611050001_invoice_installment_workflow.sql` with `npm run db:migrate`
before running this workflow. The full catalog price, course discount and course
tax are calculated once for the enrollment. Enter the **tax-inclusive amount
actually payable** for installment one; the discount is not applied a second time
to that payment. Later installments automatically continue the matching lead,
course, company and currency enrollment, retaining approved pricing. Their maximum
is the full course total minus paid, unpaid and scheduled reservations. Final-payment rounding
reconciles the itemized discount and tax across the enrollment. A discounted
enrollment requires approval once; its unchanged subsequent installments inherit
that approval. Existing historical totals are not recalculated.
Each installment is a separate numbered invoice linked to its course invoice. The
database serializes enrollment creation and prevents over-allocation,
including attempts to bypass the parent selection, and amounts beyond the unallocated
course balance. Existing enrollments retain their original total even after
catalog price changes/deactivation. Historical pre-catalog DMHCA/INR enrollments
can continue by selecting their original invoice in installment mode without
inventing a course mapping or changing historical invoices.

#### Dated installment plans and automatic delivery

Before deploying the new editor, apply
`202611060001_scheduled_invoice_status.sql` and
`202611060002_installment_plans.sql`, then
`202611060003_external_installment_payments.sql`, in that order. The enum migration must commit
before the plan migration runs. These migrations do not send customer emails.

Selecting **Installment** opens a numbered schedule with amounts (including tax),
invoice/email dates and read-only due dates. Create one installment for part of the
unallocated balance, or save several installments for part or all of that balance.
Use **Add next installment** in the register or course invoice details to return
to the existing enrollment with its course, company and currency preselected.
Existing numbered installments, amounts, dates and statuses stay visible below
the payment type. Later installments never create a fresh course balance.
Each save supports up to 36 rows; there is no lifetime installment-count limit,
provided the course has enough unallocated balance and each payment is at least
one currency unit. Fully paid courses cannot silently reopen through installment creation.
Other courses have independent enrollment totals and balances. New full-payment
invoices remain separate agreements.
Dates must be chronological, today or later, and within five years. Each invoice's
due date is four days after its selected invoice date. Its payment window runs
from **9:00 AM Asia/Kolkata on that date through 96 hours later**, not from the
time the plan was entered. Existing non-scheduled invoices retain creation-based
terms. PDFs, emails, public invoice pages and the register use the selected date.

Plans are persisted atomically with a retry-safe request ID. Scheduled/unpaid
amounts reserve the course balance without being counted as received money.
Later invoices retain the enrollment price, tax and discount; only the first
discount request needs an admin decision. Pending approval blocks scheduled
delivery. Rejection cancels the scheduled children. Once approved, each due
installment is sent independently of earlier payments. Approval never extends
an expired payment window; reconcile expired invoices rather than backdating or
silently extending them.

Invoice creation includes a company-branded preview and shows the lead and owner
email recipients before save. The email body and saved CRM preview share the same
invoice layout: logo header, billing details, course items, discount/tax totals,
payment schedule and company footer. DMHCA uses its navy/red logo palette; IBMP
uses navy/teal. Emails embed the company logo and attach the matching PDF.
Save automatically sends non-discounted invoices to the lead, copying the current
lead owner and original invoice creator. Discounted invoices stay in CRM awaiting
approval; approval automatically sends eligible invoices without a second send
action. Future-dated installments retain their selected schedule. An assigned
owner with a valid email is required for delivery. Delivery resolves the owner
at send time, so reassignment never sends a copy to a stale owner.
SMTP failures remain visible on the saved invoice and as warnings, not success
notifications. Provider/SMTP leases prevent duplicate sends; uncertain delivery
requires reconciliation before retrying.
Ready online-payment invoices include a clickable **Pay Now** button in the CRM
register, saved invoice, email and PDF. Each button opens Razorpay (INR) or Stripe
(USD) directly for the exact full-payment or installment amount, never the full
course total for a partial installment. No second invoice design is displayed.
PDFs use the configured public invoice origin.
Verified Razorpay `payment_link.paid` and Stripe `checkout.session.completed` /
`checkout.session.async_payment_succeeded` webhooks persist Paid status and send
the receipt. Configure those events and webhook secrets with the providers;
the public invoice and CRM refresh automatically to show Paid and remove Pay Now.
Email/PDF copies already delivered remain static; the checkout redirect rejects
already-paid invoices and prevents another payment. Older copies with invoice-page
links display the same shared branded template; newly delivered copies open checkout.

Invoice details show the selected course's complete installment schedule and
course total, paid, outstanding and unallocated amounts. The invoice's remaining
course balance deducts all created installments (including unpaid installments),
excluding cancelled or rejected invoices. Outstanding still deducts confirmed
payments only. Search also matches the
course name. **Record payment** opens visible fields for an external payment.
The creator, current lead owner (with `invoices.create`) or an administrator can
paste a company Razorpay/Stripe URL and choose **Verify link & mark paid**.
The server checks the configured merchant account, customer/invoice binding,
currency, exact amount and captured/paid provider state before changing status.
Payments cannot be reused across invoices. Approved scheduled or expired invoices
can be settled without waiting for the email scheduler; pending discount/tax
approval and cancelled/rejected invoices cannot bypass approval this way.
Other bank/UPI payments require Admin/Super Admin finance confirmation with a
unique reference and receipt link or verification evidence. A pasted URL alone
is never proof of payment. Paid records update the course balance on refresh and
are excluded from scheduled invoice delivery.

Saving a plan immediately attempts delivery of today's approved installments.
Approval also attempts delivery of today's installments in that enrollment.
If issued before 9:00 AM, the four-day window starts at immediate issuance instead.
Each email includes the PDF and a **Pay Now** button, addressed to the lead with
the lead owner and invoice creator copied. Saved future dates are not sent early.
For local previews, set server-only `INVOICE_PUBLIC_URL` to the public HTTPS CRM
origin serving the same database and invoice-status routes. This changes invoice
and payment-return URLs without changing the local login/request origin.
Apply `202611060004_immediate_installment_delivery.sql` before deploying this flow.
Delivery failures are reported after saving and persisted for reconciliation.

Automatic future-date delivery needs a deployed scheduler; leaving a browser open is not
sufficient. No live scheduler or database is activated by a build.

1. Configure an independent server-only `INVOICE_CRON_SECRET` of at least 32
   random characters. Never put it in client code or a URL.
2. Configure a trusted external scheduler to call `GET /api/cron/invoices`
   on the deployed HTTPS origin **every minute**, with the header
   `Authorization: Bearer <INVOICE_CRON_SECRET>`. Do not enable HTTP response
   caching. The hosting platform must allow the route's 300-second execution
   budget; adjust batch size/scheduler cadence for deployment limits.
3. Configure finance SMTP and the relevant payment provider in Integrations.
   The job processes up to five eligible invoices per invocation. Delivery is
   at or after 9:00 AM, subject to scheduler cadence, backlog and provider latency.
4. Monitor the response's `processed` and `failed` counts and the register's
   **Delivery needs attention** notices. Details show the persisted failure.
   Safe pre-send failures retry after 15 minutes. Provider/SMTP uncertainty
   retains existing delivery locks for reconciliation instead of risking duplicate
   charges or messages. Do not clear locks without checking provider records.
   Accepted SMTP messages are not proof of inbox delivery.

The worker uses service-role-only, row-locked claims; concurrent invocations do
not claim the same attempt. Already accepted emails are excluded. Undelivered
scheduled invoices whose four-day window has elapsed become expired with an
explicit error instead of being emailed with stale payment links.

#### Fixed tax, approvals and four-day payment terms

Apply `202611050002_invoice_tax_deadline.sql` before deploying this policy.
New agreements use **18% GST for INR and 0% tax for USD**, calculated on the
discounted course price. Tax and due date are read-only; the database ignores
browser-supplied rates/amounts and sets the deadline to **creation + 96 hours**
for immediate invoices, or **scheduled issue time + 96 hours** for dated installments.
Discount percentage remains editable for new agreements, with a mandatory reason;
Admin/Super Admin approval is required before any invoice/payment email is sent.
Existing installment discount agreements remain locked to the original approval.
Approval does not restart or extend the payment window.

Wholly unpaid existing agreements with different tax rates are flagged for
**Review & recalculate tax** in invoice details. An admin must reconcile/cancel
old provider links first; recalculated totals then require **Approve & send
invoice**, even with no discount. Paid invoices and agreements with confirmed
installments are not rewritten. Their historic tax agreement is identified in
the form. The old payment token is invalidated on revision and new provider
references/idempotency keys distinguish revised invoices.
Admin and Super Admin with invoice approval permission can use **Approve & send
invoice** directly in the register's Actions column or in invoice details.
Invoices needing tax correction show **Review tax before approval** instead,
which opens the details for review; expired and already-decided invoices cannot
be approved from the register. Approval always requires confirmation.

New Razorpay links include the exact provider `expire_by` deadline. **Pay Now**
in the CRM, public invoice, email and PDF opens the validated saved Razorpay link
directly for INR. This does not depend on a public CRM redirect being deployed.
USD uses the stable CRM payment redirect to Stripe Checkout. Browser payment buttons
open a separate tab so the standard invoice remains available to show confirmation.
Stripe reuses an
open Checkout session or creates a new one after verified expiry. Stripe supports
only 30-minute to 24-hour sessions, so each session has its own provider expiry
and database history. A final session opened near the deadline may run **up to
30 minutes after the four-day deadline**, as approved for this workflow. No new
session is opened after the invoice deadline. Old-session webhook confirmations
remain valid, and checkout is not renewed when a payment is complete/processing.
Ambiguous provider creation/cancellation retains a lease for finance reconciliation.

The CRM and public page show **Expired** after the deadline and remove payment
actions. The public page remains available to display verified receipts. Finance
can **Reconcile & close expired invoice** (after any Stripe grace period) to
cancel outstanding provider links and unblock a replacement installment.
Historical links already issued before this policy need provider reconciliation:
the migration does not call external merchant APIs or revoke old email links.

Each lead also has **Invoices | Timeline** tabs. Invoice history uses persisted
creation, approval decisions, SMTP acceptance and verified payment timestamps.
Actor names are shown where permitted; historical names that cannot be resolved
are explicitly marked unavailable. Service-generated events identify the service.
Lead timelines use dated activity cards with actors and recorded field changes;
they do not invent changes for legacy records.

Invoice and receipt emails use the existing configured **finance SMTP** sender;
this is separate from personal Gmail in the lead Emails section. SMTP acceptance
does not guarantee inbox delivery. EMI/loan installments are tracked externally;
only a verified Razorpay/Stripe webhook, authenticated provider verification, or
an Admin/Super Admin confirmation with a reference and evidence can mark an invoice
paid. The CRM register refreshes every 15 seconds while invoices await payment or
approval. **Check payment status** reconciles the saved provider payment if a webhook
was missed. **Verify payment URL** verifies a pasted Razorpay link (INR) or Stripe
Checkout/Payment Link (USD) against the configured company merchant account.
Verification requires a paid/captured payment of the exact invoice amount/currency,
bound to the invoice or matching billing email. Pasting an unpaid or arbitrary URL
never marks an invoice paid. Reused payments cannot settle a different invoice.
Link searches cover the latest 1,000 provider links; ambiguous, split or older
payments require finance reconciliation. Unpaid pasted URLs are not attached or
polled; use the existing webhook flow, retry verification after payment, or have
finance verify evidence. Other external payments (including loans) require admin
confirmation after independently checking funds received. Finance must reconcile
any other outstanding payment links to avoid collecting twice.
Missing provider configuration
is reported, and ambiguous provider/email operations remain locked for reconciliation.
The public link refreshes every ten seconds while awaiting confirmation, including
expired invoices that may receive a late verified confirmation. Transient refresh
failures retry automatically with a visible error. The CRM and public invoice
refresh when their tab regains focus, show **Paid** after verification and remove
the payment button. Payment never becomes Paid merely because checkout was opened
or the customer returned from checkout.
IBMP and DMHCA use one standard invoice layout, with their respective logo and
brand colors, across creation preview, saved CRM preview, public invoice, email,
paid email and PDF. Payment updates the existing invoice number, not a new invoice.
The header uses a prominent bold company name beside the logo and only the
**INVOICE** title on the right; the invoice number remains in Invoice Details.
Bill To and Invoice Details use clearly spaced bordered panels, prominent customer
and invoice identifiers, and a text-labelled payment-status badge.
The saved invoice preview contains only the standard document, without delivery
messages, a duplicate installment summary or approval history beneath it. Delivery
status remains in the register; installment balances and approval events remain
in the CRM schedule and timeline. Review warnings and external verification
evidence appear separately from the invoice document.
Paid copies show the verified payment date and amount paid instead of a payment
deadline or Pay Now button. Previously downloaded PDFs and sent emails are static;
the public invoice, CRM, new PDF downloads and paid email reflect the updated state.
CRM PDF buttons fetch the authenticated invoice endpoint, check the PDF content
type and file signature, and download the file without leaving the workspace.
Failed downloads show an error rather than opening or saving a JSON/HTML response.
`INVOICE_PUBLIC_URL` must serve the current CRM build and invoice-status routes;
host reachability alone does not prove that those routes have been deployed.
Invoice/receipt email
acceptance is recorded; SMTP acceptance is not a guarantee of inbox delivery.
Configure the finance sender to be authorized for both company identities.
Company choice changes branding, not merchant accounts or settlement currency;
each currency currently uses the single configured provider account.

Stripe Checkout sessions expire within 24 hours. Normal, confirmed session expiry
is renewed through the stable public payment page within the invoice deadline;
finance must reconcile uncertain provider operations before replacing a checkout.
Never clear locks or retry blindly. Existing payment/email/receipt locks prevent
duplicate creation or delivery after ambiguous timeouts. Test INR/USD payments,
discount approval, installment balances and Loan/EMI evidence in provider test mode
before accepting live payments.

### Lead workspace and personal Gmail

The shared workspace uses a compact Zoho-style sidebar, blue primary actions,
subtle panel and table boundaries, and consistent bordered form controls.
Selected tabs use a tinted background and validation messages remain visible.
Broad border/focus suppression is not applied. Keyboard-only focus indicators are retained for
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

#### Automatic organization Gmail access (Workspace-managed)

This mode authorizes each active CRM user's own primary Google Workspace mailbox
without requiring employee OAuth consent. It supports Gmail-hosted mailboxes,
not Outlook/Yahoo, aliases, groups or arbitrary addresses. CRM lead permissions
still apply; users cannot select a different sender or impersonate another user.

1. Apply `202611030001_workspace_gmail.sql` using the tracked migration process
   **before deploying this build**. Existing OAuth connections are preserved.
2. In your organization's Google Cloud project, enable **Gmail API**. Create a
   dedicated **service account**, enable Google Workspace domain-wide delegation,
   and download a JSON key under its Keys tab. It does not need Google Cloud
   IAM Owner/Editor roles. If organization policy blocks service account keys,
   consult your administrator; do not weaken that policy without approval.
3. A Google Workspace **super administrator** opens Admin console > Security >
   Access and data control > API controls > Manage Domain Wide Delegation.
   Add the service account's **numeric client_id** (from the JSON, not its email,
   project ID or Web OAuth client) with these exact scopes:

   ```text
   https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.send
   ```

   Complete additional administrator approval if your organization requires it.
   Propagation can take up to 24 hours.
4. As a CRM Admin/Super Admin with integration management access, open
   **Integrations > Gmail mailbox**, choose **Workspace-managed**, enter
   `dmhca.in` as the domain and paste the complete JSON into the service account
   field. Save credentials. The key is encrypted with the existing
   `AUTH_ENCRYPTION_KEY`, write-only, and never returned through settings reads.
   Keep that encryption key stable across production instances. A Web OAuth
   client, client secret and callback registration are not needed in this mode.
5. Run **Check saved setup**, signed in with your primary `@dmhca.in` mailbox.
   This requests delegated authorization and verifies your Gmail profile, without
   reading messages or sending email. Then verify lead sending and inbox sync
   with two employee CRM accounts. Every user must have an enabled/licensed Gmail
   mailbox matching their CRM login. No individual **Connect Gmail** is needed.

Automatic authorization occurs when sending or syncing, not as a Google network
call on every CRM login. Inbox import remains manual and paginated. Users with
`integrations.view` can sync/reset **their own** inbox; lead sending still
requires `leads.edit`. Domain mismatch, disabled Gmail, revoked delegation,
invalid keys and provider failures are reported explicitly, never replaced with
shared SMTP or another user's credentials. Workspace access is checked afresh
against the saved configuration and Google when requesting a token.

**Authority and revocation:** Google grants the service account organization-wide
authority for these scopes, even though CRM limits use to the signed-in login
mailbox and configured exact domain. Protect the JSON key like an organization
administrator credential. Do not commit it, put it in `NEXT_PUBLIC_*`, or share it
with employees. Revoke the grant in Google Admin and disable/delete the key to
remove Google access; already-issued Google tokens may remain valid until expiry.
Changing CRM back to OAuth stops new managed requests but is not Google-side
revocation. Existing OAuth users retain their grants; managed-only users must
connect individually after switching back. Stored inbox copies and linked lead
email history are not automatically deleted by changing the mode.

See Google's [domain-wide delegation documentation](https://developers.google.com/identity/protocols/oauth2/service-account#delegatingauthority).

#### Per-user Gmail OAuth (default)

All Google-hosted `@dmhca.in` mailboxes are eligible without an individual CRM
allowlist, including newly created addresses. Each user must sign in to CRM
with that same address and authorize their own mailbox. Other domains,
subdomains and mismatched addresses are rejected before OAuth connection,
token storage, sending or synchronization. Existing out-of-domain OAuth
connections are not usable. Recipient addresses are not restricted.

The client ID and secret can be supplied later; until configured, Gmail
connection, sending and synchronization remain unavailable with setup errors.
This does not provision mailboxes or bypass Google's authorization.
For organization-only access, configure the Google OAuth audience as Internal
for the Workspace organization; External apps in Testing still require Google
test users even though CRM has no individual address allowlist.

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

When local and live share a database, register both
`http://localhost:3000/api/auth/gmail/callback` and the live HTTPS callback on the
Google OAuth client. Set `NEXT_PUBLIC_APP_URL` and `GOOGLE_REDIRECT_URI` separately
in each environment. The server's `GOOGLE_REDIRECT_URI` overrides the callback in
saved CRM Gmail settings, without replacing shared OAuth client credentials.
Workspace-managed access does not use an OAuth callback. Public provider webhooks
cannot reach localhost directly; use a public development tunnel or the provider's
local forwarding tool, with that environment's webhook signing secrets.

Sync is a **manual pull** with durable page queues and Gmail history cursors.
Continue syncing until caught up; no scheduler is implied. Expired Gmail history
requires the explicit reset action. Users with `leads.edit` or `integrations.view`
can view and sync only their own inbox; database row-level security enforces this
user boundary. Attachments are not downloaded.
Lead email is sent through the Gmail API using only the **signed-in user's**
encrypted OAuth credentials or administrator-authorized delegated access, never
the lead owner's credentials or shared SMTP.
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
