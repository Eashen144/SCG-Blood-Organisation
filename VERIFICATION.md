# S.C.G Blood Organisation — audit, changes and verification

Date of audit: **2026-10-29** · Repository: `Eashen144/scg-blood-organisation` (`main`, HEAD `16d035a`)
Live site checked: `https://eashen144.github.io/scg-blood-organisation/`

The report below is the durable version of the audit. Every claim is labelled:

* **Verified** — executed and observed (tool, test name or command quoted).
* **Partially verified** — code review plus a simulated backend, but not the real service.
* **Not verified** — could not be executed here; reason given.
* **Requires manual action** — needs a Supabase account, CLI or secret I must not hold.

---

## 1. Summary of the existing project (before changes)

Single-page static site, no build step, everything inline in one `index.html`
(41 KB, 50 lines, one `<style>` block and one `<script>` block), plus:

| File | Role |
|------|------|
| `index.html` | Entire app: public site + admin panel + all logic |
| `404.html` | GitHub Pages SPA fallback (`/admin` → `?admin=1`) |
| `SETUP.md` | Setup notes |
| `supabase/migrations/20261028000000_init.sql` | 4 tables, grants, RLS, indexes |
| `supabase/functions/admin-create-user/index.ts` | Deno function creating admin users |

Commissioned state (verified by reading the code and the live HTML):

* **The database was never connected.** `SUPABASE_ANON_KEY = 'YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY'`
  was still the placeholder in both the repository **and** the live page
  (`curl` of the live URL returns the placeholder), so `sb === null` and every
  data feature was inert.
* **Migration status unknown.** The committed migration uses the same filename
  timestamp pattern that a fresh `supabase db push` would use; it was never
  confirmed applied. Its policies were also weaker than the README claimed
  (`status = 'approved'` only — `consent` was ignored; ads were shown while
  `active = true` even outside their schedule window).
* The Edge Function code was sound in shape (owner-only, server-side check) but
  was **never deployed** (no function secrets are referenced anywhere).

## 2. Feature checklist — everything that existed, and where it is now

| Existing feature | Status before | Now |
|------------------|---------------|-----|
| Brand, logo, rose/red palette, Bengali copy, hero, "why", "how it works" | working | **Preserved** (same copy, same visual language, new stylesheet) |
| Public donor directory | rendered from an unconnected DB | **Completed**: paginated DB search, loading/empty/error states |
| Blood-group + area + availability filters | area filter done in the browser over ≤60 rows | **Completed**: all filtering done in the database |
| Donor registration form | wrote `status:'pending'`, no validation, no duplicate check | **Completed**: full validation, duplicates, rate limit, honeypot |
| Blood request form | bare insert | **Completed**: validation, urgency/notes, duplicates, rate limit |
| Contact-a-donor modal | showed `phone` from the directory payload | **Completed**: single-record consent-aware reveal, no bulk exposure |
| Ad / announcement modal with 10-minute dismissal | working (sessionStorage) | **Preserved**, plus a real schedule window check |
| Admin login (Supabase Auth) | prefilled email, no session re-verification | **Completed**: no prefill, re-verified on load/refresh/token change |
| Admin gating on `admin_users.active` | checked once after login | **Completed**: checked on every load and every privileged RPC |
| Dashboard counters | client-side over ≤500 rows | **Completed**: single-RPC real counts (fallback to counts if RPC missing) |
| Donor management (list/edit/approve/reject/delete, admin add) | working, no search, delete by `confirm()` | **Completed**: server-side search/paging, status filter, confirm dialogs, admin notes |
| Blood request management (status change, delete) | list re-fetched on every render | **Completed**: filters (status/group/date/search), detail dialog, paging |
| Ads manager (create, enable/disable, delete, schedule) | duration dropdown only, no edit, no preview | **Completed**: explicit start/end, edit, preview, live/scheduled/expired badges |
| Admin user list + create-via-Edge-Function | triggered by any logged-in admin in the UI | **Completed**: owner-only UI, server still enforces the rule |
| `/admin` path + `?admin=1` + `404.html` redirect | working | **Preserved** (fallback rewritten so other 404s cannot loop) |
| Settings tab | static text | **Completed**: live setup diagnostics |

Nothing was removed. Two cosmetic changes: the hardcoded `২৪/৭` hero stat and the
`—` placeholders were replaced with **real** database counters (the brief forbids
fabricated statistics), and the admin login no longer prefills an email address.

## 3. Problems found and fixed

**Critical — the site could not work at all**
1. Placeholder anon key in the published page → data features dead, with no message.
2. `$('year').textContent` at script parse time (before `body` exists for a
   non-deferred inline script) would throw and abort the rest of the script.
3. `sb.auth.onAuthStateChange(() => routeAdmin())` re-ran the *entire* admin
   bootstrap on every token refresh, re-rendering and re-fetching everything.

**Security**
4. RLS let anyone read every `approved` donor **including `phone`**, consent or not.
5. Because RLS applies to the `authenticated` role too, *any* self-signed-up user
   inherited the public donor feed (phone numbers included).
6. `anon` had `INSERT` on `donors` with no `verified` restriction → a visitor could
   register with `verified = true` and earn a "✓ Verified" badge.
7. Ads were public while `active = true`, regardless of `starts_at`/`ends_at`.
8. Registration/request validation existed only in the browser; the REST endpoint
   accepted any payload that satisfied the two `CHECK`s.
9. No duplicate, rate-limit or honeypot protection → trivial spam.
10. `is_admin()` had no pinned `search_path` and `EXECUTE` left to `PUBLIC`.

**Correctness / reliability**
11. Dashboard "Active Ads" counted rows with `active = true`, not live ads.
12. Two competing donors sources (`donorsCache`, re-fetch in `refreshAdmin`).
13. `deleteRow`/`updateDonor` accepted a **table name from the DOM** — a listener
    crafted from any injected markup could target another table.
14. No pagination anywhere; the admin list silently truncated at 500 rows.
15. Submit buttons were never disabled → double submissions were possible.
16. Errors surfaced raw Postgres messages to visitors.

## 4. What was built

```
index.html                 semantic shell, admin auth gate, all panels (no inline JS/CSS)
assets/config.js           public config (URL, publishable key, contact, page sizes)
assets/styles.css          design system, responsive rules, states, a11y focus styles
assets/app.js              the whole app (no framework), sections 1–6
assets/vendor/supabase-js.min.js   vendored @supabase/supabase-js 2.57.4
supabase/migrations/20261029000000_hardening.sql
supabase/migrations/20261029000001_public_rpcs.sql
supabase/functions/admin-create-user/index.ts   hardened
tests/db/verify.mjs        94 database/RLS assertions on real PostgreSQL
tests/ui/verify.py         84 browser assertions on the real UI
404.html                   safe fallback (no redirect loop)
SETUP.md                   exact manual steps
docs/VERIFICATION.md       this report
```

### Design
Kept: logo, `♥` mark, rose/red palette (`#be123c` family), Hind Siliguri + Inter,
rounded glass cards, hero drop illustration, all Bengali copy, section order.
Improved: sticky header with a working mobile menu, one type/spacing scale,
focus-visible rings, skip link, `[hidden]` guaranteed, mobile card layout for every
admin table, `aria-live` counters, skeleton loaders, empty/error/retry states,
busy buttons, and `prefers-reduced-motion` support. No new UI library or web font.

## 5. Database and RLS results

Run: `node tests/db/verify.mjs` → **“All 94 database/RLS checks passed.”**
Environment: PGlite (PostgreSQL 18.6 compiled to WASM) with Supabase-like roles
`anon` / `authenticated` / `service_role`, `auth.uid()` from a JWT `sub` claim, and
Supabase's default `GRANT ALL` on new tables so every `REVOKE` is exercised.

| Area | Result | Status |
|------|--------|--------|
| All three migrations apply in order | ✓ | Verified (local PG) |
| Migrations are re-runnable, no rows lost | ✓ | Verified (local PG) |
| Original columns preserved; new columns added | ✓ | Verified |
| Public sees only approved **and** consenting donors | ✓ | Verified |
| Pending / rejected donors hidden from public | ✓ | Verified |
| `anon` cannot `select phone` (column privilege) | ✓ | Verified |
| `anon` cannot self-approve / self-verify / skip consent | ✓ | Verified |
| `anon` cannot read `blood_requests`, `admin_users` | ✓ | Verified |
| Public sees only **live** ads | ✓ | Verified |
| Non-admin signed-in user gets zero donor rows | ✓ | Verified |
| Non-admin cannot update donors or insert itself into `admin_users` | ✓ | Verified |
| Inactive admin refused by `is_admin()` and every admin RPC | ✓ | Verified |
| Active owner sees all rows incl. phone and can approve | ✓ | Verified |
| `admin_dashboard_stats` counts (incl. live vs total ads) | ✓ | Verified |
| `admin_list_donors` filter/paging/private fields | ✓ | Verified |
| `admin_list_requests` filter by status | ✓ | Verified |
| Search: group, area (case-insensitive), consent, clamp to 50, offset paging | ✓ | Verified |
| Search payload contains no phone/notes/consent columns | ✓ | Verified |
| `reveal_donor_contact` only for approved + consenting | ✓ | Verified |
| Registration: validation, consent, duplicate, `+880` normalisation | ✓ | Verified |
| Registration limited to 3 attempts/hour/number | ✓ | Verified |
| Request: bags, notes length, urgency fallback, duplicate 20 min, 5/day | ✓ | Verified |
| All RPCs `SECURITY DEFINER` with pinned `search_path` | ✓ | Verified |
| Migration applied to your live project | — | **Requires manual action** (step 2 of `SETUP.md`) |
| Behaviour of the live project's Data API | — | **Not verified** — no key/dashboard access here |

## 6. Migration reality vs the repository

* `20261028000000_init.sql` — committed; **cannot confirm** it was ever applied.
  Regardless of that, the two new migrations are written to be applied on top of
  it *or* on top of a hand-made equivalent (they use `if not exists`, guarded
  `CHECK`s and `drop policy if exists`).
* `20261029000000_hardening.sql` and `20261029000001_public_rpcs.sql` — new; the
  app detects their absence at runtime (`PGRST202`) and falls back to
  schema-compatible queries while telling the admin that the upgrade is pending.

## 7. Admin authentication & authorisation

| Test | Result | Status |
|------|--------|--------|
| Unauthenticated visitor sees only the login card | ✓ | Verified (headless Chromium) |
| No dashboard widget or data table visible before auth | ✓ | Verified |
| Inactive admin: signed out, denial message, no dashboard | ✓ | Verified |
| Unknown (non-admin) account: denial message, no dashboard | ✓ | Verified |
| Active owner: dashboard, real counters, email shown | ✓ | Verified |
| Logout hides the dashboard and clears cached rows | ✓ | Verified |
| Misconfigured project: setup message, never a dashboard | ✓ | Verified |
| Privileged RPCs refused without an active admin row | ✓ | Verified (local PG) |
| Access re-checked on load, token refresh and each RPC | code review | Partially verified |
| Edge Function authorisation | code review + `deno check` | Partially verified |

## 8. Edge Function

`deno check` → clean (exit 0, Deno 2.9.6). Behaviour verified by code review:
bearer-token requirement, active-owner lookup with the service client, 10–72 char
password rule, 4 KB body cap, Auth-user rollback when the grant fails, CORS
limited by an optional `APP_ALLOWED_ORIGINS` secret, no secrets in responses,
`503` when unset.

**Requires manual action:** `supabase functions deploy admin-create-user` and
`supabase secrets set SUPABASE_SERVICE_ROLE_KEY=…`. Deployment status: **not
verified** (no CLI session or project credentials in this environment).

## 9. Browser verification

Run: `python3 tests/ui/verify.py` → **“All 84 browser checks passed.”**
The real `index.html` + `assets/app.js` run in headless Chromium against a
**mocked** Supabase API (stateful PostgREST/GoTrue emulation) — so this proves the
client logic, not the live backend.

Covered: setup banner when the key is missing, real counters rendering, donor cards,
phone absent from the directory payload, contact reveal, blood-group filter payload,
no-results state, inline validation (name, phone, consent), successful registration
payload (and that no `status` field is sent), blood request payload with urgency,
privacy + removal dialogs, Escape-to-close, focus trap, **zero horizontal overflow
at 390 / 820 / 1280 px**, mobile menu behaviour, full admin flow (login → approve →
delete with confirmation → cancel, search round-trip, request status change, detail
dialog, ad creation, admin list, diagnostics, logout), and no console/page errors.

Screens reviewed: public home, registration modal, mobile home, mobile menu, admin
login, admin overview, admin donors, admin donors on mobile. Two defects were found
and fixed this way: banners ignoring the `hidden` attribute, and the admin route
ending up in a `display:none` container after logout/denial.

## 9b. Live Supabase project — checked with the real publishable key

The publishable key was configured in `assets/config.js` and used to query the
project directly (public key only; no secret was used or stored).

| Check | Result | Status |
|-------|--------|--------|
| `GET /auth/v1/health` | 200 | Verified |
| `GET /rest/v1/donors` | `404 PGRST205` — table does not exist | Verified (project is empty) |
| `GET /rest/v1/blood_requests` | `404 PGRST205` | Verified |
| `GET /rest/v1/ads` | `404 PGRST205` | Verified |
| `GET /rest/v1/admin_users` | `404 PGRST205` | Verified |
| `POST /rest/v1/rpc/public_stats` | `404 PGRST202` — function missing | Verified |
| `POST /functions/v1/admin-create-user` | `404 NOT_FOUND` — not deployed | Verified |
| Site with the real key | setup banner gone, counters render `0`, no JS errors | Verified |
| Visitor view with no tables | friendly "ডাটাবেস সেটআপ এখনো সম্পূর্ণ হয়নি" state instead of a raw Postgres error | Verified (fixed after this check) |
| Admin route with no tables | login card only, dashboard hidden | Verified |

**Conclusion (verified):** the committed `20261028000000_init.sql` was **never
applied** — the project has no tables at all, so nothing existed to migrate. The
three migrations and the all-in-one setup file must be run once.
DDL cannot be executed with an anon/publishable key (and the `service_role` key
only opens the Data API, not SQL), so this step needs the SQL Editor or the
Supabase CLI.

`supabase/SETUP-ALL-IN-ONE.sql` was verified by applying it as a **single batch**
to PostgreSQL (PGlite) and then asserting: 4 tables created, 12 functions (9
`SECURITY DEFINER`), 17 policies, `public_stats` / `public_donor_search` /
registration / request work as `anon`, `select phone from donors` is denied for
`anon`, `admin_dashboard_stats` is denied for a non-admin and works for an owner.

## 10. Live deployment

* The live page still serves the **old** build (placeholder key, inline script) —
  the repository changes in this work are **not deployed**.
* The work is committed **locally** as `6d437f8` ("Complete, secure and harden
  the S.C.G Blood Organisation site") on top of `16d035a`. No GitHub connection was
  available in this environment, so nothing was pushed. Apply it with
  `git push origin main` from the repository (or `git am scg-blood-organisation.patch`),
  then hard-refresh the live site.
* Once pushed, GitHub Pages updates automatically; no workflow file, build step or
  action is required.
* **Deployment status: not verified** — I could not push (no GitHub credentials)
  and could not confirm the resulting live build.
* After deploying, confirm: hard refresh, then the setup banner disappears once the
  key is in place, donor search returns rows, `?admin=1` shows the login card.

## 11. Remaining manual steps

1. Paste the publishable key into `assets/config.js` (**Dashboard → Project
   Settings → API keys**).
2. Run the three migrations (**SQL Editor**, in order) — back up first.
3. **Authentication → Providers → Email → Allow new users to sign up = OFF**;
   set **URL Configuration → Site URL** to the Pages URL.
4. Create the first `owner` (Auth user + `admin_users` row) with the snippet in
   `SETUP.md` §4.
5. Deploy `admin-create-user` and set `SUPABASE_SERVICE_ROLE_KEY`
   (`supabase functions deploy` / `supabase secrets set`).
6. Fill `ORG_CONTACT_EMAIL` / `ORG_CONTACT_PHONE` so the privacy and removal paths
   are usable by the public.
7. Optional: custom domain, and a CSP `<meta>` tag if you want one (GitHub Pages
   cannot send headers).

## 12. Could not be tested here, and why

| Item | Reason |
|------|--------|
| Live Supabase Data API / RLS | no publishable key and no dashboard access; the project rejects unauthenticated requests (`401`) |
| Applying the migrations to the real database | requires your project credentials; I must not hold them |
| Edge Function deployment and its runtime behaviour | requires a Supabase CLI session with your project |
| GitHub push / Pages redeploy | no GitHub connection available in this environment |
| Real email/password sign-in | depends on the two items above |
| Multi-device real-device testing | Chromium viewports emulated, not physical devices |
