# Tests

Two suites. Neither touches your live Supabase project.

## `db/verify.mjs` — database, grants, RLS and RPCs

Applies the three real migration files, in order, to PGlite (PostgreSQL 18 compiled
to WASM) with Supabase's roles (`anon`, `authenticated`, `service_role`),
`auth.uid()` from a JWT `sub` claim, and Supabase's default `GRANT ALL` on new
tables. Then it asserts allowed **and** denied operations for four identities:
anonymous, signed-in non-admin, inactive admin, active owner.

```bash
npm i --no-save @electric-sql/pglite
node tests/db/verify.mjs        # → All 94 database/RLS checks passed.
```

## `ui/verify.py` — the real UI in a real browser

Serves nothing itself: start a static server on port 8099 first
(`python3 -m http.server 8099`). The suite loads `index.html` + `assets/app.js` in
headless Chromium, replaces `assets/config.js` with a test configuration and
intercepts the Supabase HTTP API with a small stateful mock (PostgREST + GoTrue).

```bash
pip install playwright && python3 -m playwright install chromium
python3 tests/ui/verify.py      # → All 84 browser checks passed.
```

Covered: setup banner, counters, donor cards, contact reveal, filters, empty and
error states, form validation and payloads, privacy/removal dialogs, responsive
layout at 390/820/1280 px (no horizontal overflow), the whole admin flow
(gating, inactive/non-admin denial, approve, delete-with-confirmation, search,
request status, ads, diagnostics, logout) and "no console errors".

Because the backend is mocked, these tests prove the client logic only. Live
backend behaviour must be confirmed once the migrations are applied —
see `docs/VERIFICATION.md` §11.
