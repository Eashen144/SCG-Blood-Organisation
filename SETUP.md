# S.C.G Blood Organisation — setup, security and deployment

This repository is a static site (`index.html` + `assets/`) backed by Supabase
(Postgres + Auth + Row Level Security + one Edge Function). Nothing here needs a
build step, a server, or a framework.

> **Status (checked against the live project on 2026-10-29 with the publishable key):**
> * Auth is up (`/auth/v1/health` → 200) and the publishable key now works in the site.
> * **The database is empty** — `donors`, `blood_requests`, `ads` and `admin_users`
>   all return `PGRST205` ("table not found"), no RPC exists, and the
>   `admin-create-user` function is **not deployed**.
> * ⇒ The project needs **step 1 (SQL)** below before any feature can work.
>
> Everything else in this repository is verified locally: 94 database/RLS
> assertions on real PostgreSQL and 84 browser assertions. See
> `docs/VERIFICATION.md`.

---

## 0. What you must do once (4 steps)

| # | Task | Where | Status |
|---|------|-------|--------|
| 1 | Run **`supabase/SETUP-ALL-IN-ONE.sql`** (creates all tables, policies, RPCs) | Supabase SQL Editor → paste → Run | **not done yet** |
| 2 | Turn **off** public sign-ups | Authentication → Providers → Email | to do |
| 3 | Create the first owner (Auth user + `admin_users` row) | Dashboard + SQL Editor | to do |
| 4 | Deploy `admin-create-user` + its secret | Supabase CLI | to do (optional) |

The publishable key is already configured in `assets/config.js` (it is a public
key — safe to commit). Nothing else is pre-filled.

Details follow.

---

## 1. Configure the public key (no secrets in the repo)

1. Open **Supabase Dashboard → your project (`kyueuqzxckjsmgyrrehm`) → Project Settings → API keys**.
2. Copy the **Publishable key** (new projects) or the **anon public** key (legacy projects).
3. Open `assets/config.js` and set:

```js
SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_…',   // ← paste here
```

4. Optionally set `ORG_CONTACT_EMAIL` / `ORG_CONTACT_PHONE`. These are shown in the
   public "যোগাযোগ" section and in the privacy / data-removal dialog. Nothing is
   invented for you — if they are empty, the site shows a neutral placeholder.

**Never** put these in this repository or in any browser file:

* the `service_role` / secret key,
* the database password,
* any admin password.

The publishable key is designed to be public — Row Level Security is what protects
the data. If the key is missing, the site shows a clear banner and does **not**
pretend to work.

---

## 2. Apply the database setup

### Fastest path (recommended for this project — the database is empty)

1. Open **Supabase Dashboard → SQL Editor → New query**.
2. Open `supabase/SETUP-ALL-IN-ONE.sql`, copy **the whole file**, paste it.
3. Press **Run**. Expected: *"Success. No rows returned"*.
4. Verify (still in the SQL Editor):

```sql
select public.public_stats();                                     -- {"donors_approved":0,"donors_available":0}
select tablename from pg_tables where schemaname = 'public';       -- 4 tables
select proname, prosecdef from pg_proc
 where pronamespace = 'public'::regnamespace order by 1;           -- RPCs, all security definer
```

The all-in-one file contains the three migrations in order (schema → hardening →
API). It is for a **fresh, empty database**; if it is already applied, use
`supabase db push` for future changes.

### The three migrations separately (for `supabase db push` or review)

```
supabase/migrations/20261028000000_init.sql        -- tables, grants, base RLS
supabase/migrations/20261029000000_hardening.sql   -- constraints, indexes, RLS fixes
supabase/migrations/20261029000001_public_rpcs.sql -- validated RPC/API layer
```

### Option A — Supabase CLI (recommended, repeatable)

```bash
supabase link --project-ref kyueuqzxckjsmgyrrehm
supabase db push          # applies anything not yet applied, in timestamp order
```

### Option B — SQL Editor (manual)

Open **SQL Editor**, paste **one file at a time**, run it, then move to the next.

Both paths are safe to repeat:

* every new object is created with an `if not exists` / duplicate guard,
* **no** table, column or row is dropped or renamed,
* new `CHECK` constraints are added `NOT VALID` and then validated only if the
  existing rows already satisfy them (a legacy row can never abort the migration).

### Before applying to a database that already holds data

Take a backup first: **Dashboard → Database → Backups → Create backup**, or

```bash
pg_dump "$SUPABASE_DB_URL" --schema=public --data-only > backup-public.sql
```

### What the migrations add (summary)

* `blood_requests.urgency`, `blood_requests.notes`, `donors.admin_notes`, `updated_at` columns.
* Value constraints (blood groups, phone format, date sanity, text lengths, ad window).
* Indexes for the public search and admin filters (including `pg_trgm` if available).
* `public.is_admin()` + `public.admin_role()` as `SECURITY DEFINER` with a pinned
  `search_path` and `EXECUTE` revoked from `PUBLIC`.
* Tighter RLS: public may read only **approved + consenting** donors and **live**
  ads; public inserts can never self-approve or self-verify.
* Column-level grants so `anon` **cannot** `select phone` from `donors` at all.
* RPCs: `public_stats`, `public_donor_search`, `reveal_donor_contact`,
  `submit_donor_registration`, `submit_blood_request`,
  `admin_dashboard_stats`, `admin_list_donors`, `admin_list_requests`.

Verify afterwards in **SQL Editor**:

```sql
select public.public_stats();                                   -- counters
select * from public.public_donor_search(null, null, true, 5, 0); -- public search
select proname, prosecdef from pg_proc
 where pronamespace = 'public'::regnamespace order by 1;         -- all SECURITY DEFINER
select tablename, rowsecurity from pg_tables where schemaname='public';
```

---

### ⚠️ If you pasted a `service_role` key anywhere (chat, email, screenshot)

That key bypasses every security rule and can read all donor phone numbers and
admin records. Treat it as compromised and rotate it once setup is done:

* **Legacy JWT keys:** Dashboard → **Settings → API → JWT Settings → Rotate JWT
  secret**. This invalidates the old `anon` and `service_role` keys; generate/copy
  the new keys afterwards.
* **New API keys:** Dashboard → **Settings → API keys** → rotate/revoke the leaked
  secret key.

After rotating, only update what you actually use: the **publishable** key in
`assets/config.js` (if you rotate the anon key too) and the
`SUPABASE_SERVICE_ROLE_KEY` Edge Function secret. Nothing else changes.
Never put a secret key in this repository, in `assets/`, or in a chat message —
the publishable key is the only one the browser needs.

## 3. Authentication settings (Dashboard)

1. **Authentication → Providers → Email**: enable email/password.
2. **Authentication → Providers → Email → "Allow new users to sign up": OFF.**
   There is no public admin sign-up. Every admin account must be created by you
   (step 4) or by an existing owner through the Edge Function (step 5).
3. **Authentication → URL Configuration**:
   * Site URL: `https://eashen144.github.io/scg-blood-organisation/`
   * Redirect URLs: add the same URL.
4. Recommended: **Authentication → Policies → minimum password length ≥ 10**
   and enable leaked-password protection if available on your plan.

---

## 4. Create the first admin (owner)

1. **Authentication → Users → Add user** → email `eashen4567@gmail.com`,
   a strong password, **Auto Confirm User = ON**.
2. Copy the new user's **UUID**.
3. **SQL Editor**:

```sql
insert into public.admin_users (user_id, email, role, active)
values ('PASTE-USER-UUID-HERE', 'eashen4567@gmail.com', 'owner', true)
on conflict (user_id) do update
  set role = 'owner', active = true, email = excluded.email;
```

4. Open `https://eashen144.github.io/scg-blood-organisation/?admin=1` and sign in.
   The dashboard only renders after the session **and** the `admin_users` row are
   both verified. An inactive or unknown account is signed out immediately.

> Do not create additional admins with SQL unless you mean to; the in-app
> "Admin Users" tab (owner only) uses the Edge Function in step 5.

---

## 5. Deploy the `admin-create-user` Edge Function

```bash
supabase functions deploy admin-create-user --project-ref kyueuqzxckjsmgyrrehm
```

Set the one privileged secret (**server side only** — never in `index.html`,
`assets/`, or git):

```bash
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
  --project-ref kyueuqzxckjsmgyrrehm
```

Optional, to lock CORS to your site:

```bash
supabase secrets set APP_ALLOWED_ORIGINS="https://eashen144.github.io,http://localhost:8099" \
  --project-ref kyueuqzxckjsmgyrrehm
```

What the function enforces (server-side, independent of the UI):

* requires a valid `Authorization: Bearer <access token>`,
* the caller must have an **active `owner`** row in `admin_users`,
* validates email/password (10–72 chars), limits the body to 4 KB,
* creates the Auth user, then the `admin_users` row (`role = 'admin'`),
* **rolls back** (deletes the Auth user) if the grant fails,
* returns generic messages — no tokens, keys or stack traces,
* returns `503 not_configured` if its secrets are missing.

The "Setup & Settings" tab in the admin panel runs a live diagnostic
(key present → session → RPCs → tables → function reachable).

---

## 6. Deployment (GitHub Pages)

* Publish from the **repository root** of `main` (Settings → Pages → Deploy from a
  branch → `main` / `/ (root)`). `index.html` is the entry point.
* `404.html` handles unknown paths: `/admin` → `?admin=1`, everything else → the
  site root. Because it redirects to a real page, a mistyped URL cannot loop.
* The Supabase library is vendored at `assets/vendor/supabase-js.min.js`
  (v2.57.4) instead of being fetched from a CDN on every visit: one less
  third-party origin, no CDN outage, faster repeat loads.
* After deploying, hard-refresh (`Ctrl/Cmd+Shift+R`) so the new `assets/*` files
  are not served from an old cache, then check the browser console.

### GitHub Pages limitations (no action needed today)

* Static hosting only: no server-side rendering, no HTTP headers. Share links
  cannot have per-donor previews, and a strict CSP must be delivered by a
  `<meta>` tag (not configured, so the site keeps working with the vendored
  library).
* Custom headers/CSP, IP rate limiting and server logs would need Cloudflare
  Pages, Netlify or Vercel. **This project has not been migrated** — all
  server-side security decisions that matter live in Supabase (RLS + RPCs), and
  the app works unchanged on GitHub Pages.

---

## 7. Local development and tests

```bash
# serve the static site (any static server works)
python3 -m http.server 8099

# database / RLS suite — runs the real migrations on PostgreSQL (WASM)
npm i --no-save @electric-sql/pglite
node tests/db/verify.mjs

# browser suite — drives the real UI against a mocked Supabase API
pip install playwright && python3 -m playwright install chromium
python3 tests/ui/verify.py
```

`assets/config.js` is read by the site, so for local work point
`SUPABASE_URL`/`SUPABASE_PUBLISHABLE_KEY` at your project — the key is public.

---

## 8. Security & privacy checklist (already implemented)

* **Approval workflow** — new registrations are always `pending`; public search
  only returns `approved` **and** consenting donors.
* **Phone numbers** — `anon` has no `SELECT` privilege on `donors.phone`. Numbers
  are returned one record at a time by `reveal_donor_contact()` for approved,
  consenting donors only, so the directory cannot be bulk-scraped in one request.
* **No client-side trust** — role checks are re-done in the database. Hiding a
  button is never the only protection.
* **Spam controls** — duplicate detection, per-number rate limits and a honeypot
  field; all enforced server-side.
* **Sessions** — access is re-verified on load, on token refresh, and on every
  admin RPC; logout clears state and re-renders the login gate.
* **Privacy** — a privacy notice plus a correction/removal request path are linked
  in the footer.
* **Medical caution** — the site never claims a donor is eligible to donate.

## 9. Things that still need you

* The publishable key (step 1) — without it the site intentionally shows a setup banner.
* The three migrations (step 2) — without them the site falls back to limited
  schema-compatible queries and tells the admin so in the dashboard notice.
* Auth hardening (step 3) and the first owner (step 4).
* The Edge Function + secret (step 5) if you want in-app admin creation.
