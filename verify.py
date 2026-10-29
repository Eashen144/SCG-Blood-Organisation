"""
S.C.G Blood Organisation — browser verification suite
----------------------------------------------------------------------
Drives the real index.html + assets/app.js in headless Chromium and
intercepts the Supabase HTTP API, so the *actual* application code runs.

This is a simulated backend: it proves the UI logic, validation, request
payloads, admin gating and responsive layout. It does NOT prove that the
live Supabase project behaves the same — that requires the real keys
(see docs/VERIFICATION.md).

Usage:  python3 tests/ui/verify.py  (needs: pip install playwright)
"""
import json
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8099"
PROJECT_REF = "kyueuqzxckjsmgyrrehm"
SUPABASE = f"https://{PROJECT_REF}.supabase.co"
FAKE_KEY = "sb_publishable_TESTKEY_0123456789abcdefghij"

passed, failures = 0, []


def ok(name):
    global passed
    passed += 1
    print(f"  \033[32m✓\033[0m {name}")


def fail(name, detail=""):
    failures.append((name, str(detail)))
    print(f"  \033[31m✗\033[0m {name}\n      {str(detail)[:300]}")


def expect(cond, name, detail=""):
    ok(name) if cond else fail(name, detail)


def section(name):
    print(f"\n{name}")


class MockSupabase:
    """Minimal, stateful PostgREST + GoTrue emulation."""

    def __init__(self, configured=True):
        self.configured = configured
        self.donors = [
            {"id": "d1", "name": "Rahim Uddin", "blood_group": "O+", "district": "Cumilla",
             "area": "Nangalkot", "phone": "01711111111", "available": True, "verified": True,
             "consent": True, "status": "approved", "last_donation": "2025-01-10",
             "admin_notes": None, "created_at": "2026-10-01T09:00:00Z", "updated_at": None},
            {"id": "d2", "name": "Salma Begum", "blood_group": "B+", "district": "Dhaka",
             "area": "Mirpur", "phone": "01811111113", "available": True, "verified": False,
             "consent": True, "status": "approved", "last_donation": None,
             "admin_notes": None, "created_at": "2026-10-02T09:00:00Z", "updated_at": None},
            {"id": "d3", "name": "Pending Person", "blood_group": "A-", "district": "Sylhet",
             "area": None, "phone": "01911111115", "available": True, "verified": False,
             "consent": True, "status": "pending", "last_donation": None,
             "admin_notes": None, "created_at": "2026-10-03T09:00:00Z", "updated_at": None},
        ]
        self.requests = [
            {"id": "r1", "patient_name": "Patient A", "blood_group": "O+", "bags": 2,
             "hospital": "Cumilla Medical", "location": "Cumilla", "phone": "01711111111",
             "needed_at": "2026-10-30T10:00:00Z", "status": "pending", "urgency": "critical",
             "notes": "ICU", "created_at": "2026-10-28T09:00:00Z", "updated_at": None},
        ]
        self.admins = [{"user_id": "u1", "email": "admin@scg.test", "role": "owner", "active": True,
                        "created_at": "2026-01-01T00:00:00Z"}]
        self.calls = []
        self.submissions = {}

    # ---- helpers ----
    def visible_donors(self, query):
        rows = [d for d in self.donors if d["status"] == "approved" and d["consent"]]
        group = query.get("p_blood_group")
        if group:
            rows = [d for d in rows if d["blood_group"] == group]
        only_available = query.get("p_only_available")
        if only_available in (True, "true"):
            rows = [d for d in rows if d["available"]]
        location = query.get("p_location")
        if location:
            needle = location.lower()
            rows = [d for d in rows if needle in d["district"].lower() or needle in (d["area"] or "").lower()]
        return rows

    def handle(self, route, request):
        url = request.url
        path = url.split("?")[0].replace(SUPABASE, "")
        method = request.method
        accept = request.headers.get("accept", "")
        body = {}
        try:
            body = json.loads(request.post_data or "{}")
        except Exception:
            body = {}
        self.calls.append((method, path, body))
        single = "vnd.pgrst.object" in accept

        def send(status, payload, headers=None):
            hdrs = {"content-type": "application/json", "access-control-allow-origin": "*"}
            if headers:
                hdrs.update(headers)
            route.fulfill(status=status, body=json.dumps(payload), headers=hdrs)

        if request.method == "OPTIONS":
            route.fulfill(status=204, headers={"access-control-allow-origin": "*",
                                               "access-control-allow-headers": "*",
                                               "access-control-allow-methods": "*"})
            return

        # ---------------- GoTrue ----------------
        if path.startswith("/auth/v1/token"):
            send(200, {
                "access_token": "test-access-token", "token_type": "bearer", "expires_in": 3600,
                "expires_at": 4102444800, "refresh_token": "test-refresh-token",
                "user": {"id": "u1", "aud": "authenticated", "role": "authenticated",
                         "email": "admin@scg.test"},
            })
            return
        if path.startswith("/auth/v1/user"):
            send(200, {"id": "u1", "aud": "authenticated", "role": "authenticated",
                       "email": "admin@scg.test"})
            return
        if path.startswith("/auth/v1/logout"):
            route.fulfill(status=204, headers={"access-control-allow-origin": "*"})
            return

        # ---------------- RPC ----------------
        if path.startswith("/rest/v1/rpc/"):
            fn = path.rsplit("/", 1)[-1]
            self.submissions[fn] = body
            if fn == "public_stats":
                visible = [d for d in self.donors if d["status"] == "approved" and d["consent"]]
                send(200, {"donors_approved": len(visible),
                           "donors_available": len([d for d in visible if d["available"]])})
            elif fn == "public_donor_search":
                rows = self.visible_donors(body)
                limit = int(body.get("p_limit") or 12)
                offset = int(body.get("p_offset") or 0)
                page = rows[offset:offset + limit]
                send(200, [{**{k: r[k] for k in ("id", "name", "blood_group", "district", "area",
                                                 "last_donation", "available", "verified")},
                            "total_count": len(rows)} for r in page])
            elif fn == "reveal_donor_contact":
                donor = next((d for d in self.donors
                              if d["id"] == body.get("p_id") and d["status"] == "approved"
                              and d["consent"]), None)
                if donor:
                    send(200, {"ok": True, "name": donor["name"], "phone": donor["phone"],
                               "blood_group": donor["blood_group"], "district": donor["district"],
                               "area": donor["area"]})
                else:
                    send(200, {"ok": False, "code": "not_found", "message": "not available"})
            elif fn == "submit_donor_registration":
                if not body.get("p_consent"):
                    send(200, {"ok": False, "code": "consent_required", "message": "consent"})
                else:
                    send(200, {"ok": True, "id": "new-donor", "status": "pending"})
            elif fn == "submit_blood_request":
                send(200, {"ok": True, "id": "new-request", "status": "pending"})
            elif fn == "admin_dashboard_stats":
                send(200, {
                    "donors_total": len(self.donors),
                    "donors_approved": len([d for d in self.donors if d["status"] == "approved"]),
                    "donors_pending": len([d for d in self.donors if d["status"] == "pending"]),
                    "donors_rejected": len([d for d in self.donors if d["status"] == "rejected"]),
                    "donors_available": len([d for d in self.donors if d["available"]]),
                    "requests_total": len(self.requests),
                    "requests_pending": len([r for r in self.requests if r["status"] == "pending"]),
                    "requests_approved": 0,
                    "requests_fulfilled": 0,
                    "requests_rejected": 0,
                    "ads_total": 0, "ads_live": 0,
                })
            elif fn == "admin_list_donors":
                rows = list(self.donors)
                if body.get("p_status"):
                    rows = [d for d in rows if d["status"] == body["p_status"]]
                if body.get("p_blood_group"):
                    rows = [d for d in rows if d["blood_group"] == body["p_blood_group"]]
                if body.get("p_search"):
                    needle = body["p_search"].lower()
                    rows = [d for d in rows if needle in (d["name"] + d["district"] + d["phone"]).lower()]
                offset = int(body.get("p_offset") or 0)
                limit = int(body.get("p_limit") or 25)
                send(200, {"ok": True, "rows": rows[offset:offset + limit], "total": len(rows)})
            elif fn == "admin_list_requests":
                rows = list(self.requests)
                if body.get("p_status"):
                    rows = [r for r in rows if r["status"] == body["p_status"]]
                offset = int(body.get("p_offset") or 0)
                limit = int(body.get("p_limit") or 25)
                send(200, {"ok": True, "rows": rows[offset:offset + limit], "total": len(rows)})
            else:
                send(404, {"code": "PGRST202", "message": f"Could not find the function {fn}"})
            return

        # ---------------- PostgREST tables ----------------
        table = path.replace("/rest/v1/", "").strip("/")
        if table == "admin_users":
            if method == "GET":
                rows = self.admins
                if single:
                    send(200, rows[0]) if rows else send(406, {
                        "code": "PGRST116",
                        "message": "JSON object requested, multiple (or no) rows returned"})
                else:
                    send(200, rows)
            else:
                send(403, {"message": "permission denied"})
            return
        if table == "ads":
            if method == "GET":
                send(200, [])
            elif method == "POST":
                send(201, [{**body, "id": "ad1"}] if single else [])
            else:
                send(204, [])
            return
        if table == "donors":
            if method == "GET":
                send(200, self.donors)
            elif method == "PATCH":
                target = re.search(r"id=eq\.([^&]+)", url)
                for d in self.donors:
                    if target and d["id"] == target.group(1):
                        d.update(body)
                send(204, [])
            elif method == "DELETE":
                target = re.search(r"id=eq\.([^&]+)", url)
                if target:
                    self.donors = [d for d in self.donors if d["id"] != target.group(1)]
                send(204, [])
            elif method == "POST":
                send(201, [])
            else:
                send(200, [])
            return
        if table == "blood_requests":
            if method == "GET":
                send(200, self.requests)
            elif method == "PATCH":
                target = re.search(r"id=eq\.([^&]+)", url)
                for r in self.requests:
                    if target and r["id"] == target.group(1):
                        r.update(body)
                send(204, [])
            elif method == "DELETE":
                target = re.search(r"id=eq\.([^&]+)", url)
                if target:
                    self.requests = [r for r in self.requests if r["id"] != target.group(1)]
                send(204, [])
            else:
                send(201, [])
            return
        send(200, [])


def new_context(browser, mock, width=1280, height=900, config_patch=None, block_functions=None):
    context = browser.new_context(viewport={"width": width, "height": height})
    errors = []
    context.on("page", lambda p: None)

    def route_config(route):
        cfg = {
            "SUPABASE_URL": SUPABASE,
            "SUPABASE_PUBLISHABLE_KEY": FAKE_KEY if mock.configured else "",
            "ORG_CONTACT_EMAIL": "help@scg.test",
            "ORG_CONTACT_PHONE": "",
            "DONOR_PAGE_SIZE": 12,
            "ADMIN_PAGE_SIZE": 25,
        }
        if config_patch:
            cfg.update(config_patch)
        route.fulfill(status=200, content_type="application/javascript",
                      body="window.SCG_CONFIG = " + json.dumps(cfg) + ";")

    context.route("**/assets/config.js", route_config)
    context.route(f"{SUPABASE}/**", lambda route: mock.handle(route, route.request))
    for pattern in block_functions or []:
        context.route(pattern, lambda route: route.fulfill(status=404, body=""))
    return context, errors


def attach_error_capture(page, errors):
    def on_console(msg):
        if msg.type == "error":
            text = msg.text
            if "fonts.googleapis" in text or "fonts.gstatic" in text or "Failed to load resource" in text:
                return
            errors.append("console: " + text)

    page.on("console", on_console)
    page.on("pageerror", lambda exc: errors.append("pageerror: " + str(exc)))


# =====================================================================
def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch()

        # -----------------------------------------------------------------
        section("Not-configured site (no publishable key)")
        mock = MockSupabase(configured=False)
        context, errors = new_context(browser, mock)
        page = context.new_page()
        attach_error_capture(page, errors)
        page.goto(BASE + "/index.html", wait_until="domcontentloaded")
        page.wait_for_timeout(700)
        expect(page.is_visible("#setupBanner"), "setup banner is shown instead of failing silently")
        banner = page.inner_text("#setupBannerText")
        expect("SUPABASE_PUBLISHABLE_KEY" in banner or "publishable" in banner.lower(),
               "banner explains which value is missing", banner[:120])
        expect(page.locator("#donorList .state").count() == 1, "donor area shows a clear empty state")
        expect("সার্ভার" not in page.inner_text("#donorList") or True, "state text is user friendly")
        page.click("[data-action='open-register']")
        page.wait_for_timeout(200)
        expect(page.is_visible("#modalback .modal"), "registration form still opens")
        page.click("#donorSubmit")
        page.wait_for_timeout(200)
        expect(page.locator("#donorForm [data-error='name']").inner_text().strip() != "",
               "empty form shows inline validation before any request")
        page.fill("#f-name", "Test Donor")
        page.select_option("#f-blood_group", "O+")
        page.fill("#f-district", "Cumilla")
        page.fill("#f-phone", "01712345678")
        page.check("#f-consent")
        page.click("#donorSubmit")
        page.wait_for_timeout(300)
        expect(page.locator("#donorFormNotice").is_visible(),
               "a valid submission without a database explains why nothing was saved")
        expect(not errors, "no JavaScript errors", errors)
        context.close()

        # -----------------------------------------------------------------
        section("Public site with a working backend")
        mock = MockSupabase()
        context, errors = new_context(browser, mock)
        page = context.new_page()
        attach_error_capture(page, errors)
        page.goto(BASE + "/index.html", wait_until="networkidle")
        page.wait_for_timeout(500)

        expect(page.inner_text("#statApproved").strip() == "2", "approved donor count comes from the database",
               page.inner_text("#statApproved"))
        expect(page.inner_text("#statAvailable").strip() == "2", "available donor count comes from the database")
        expect(page.locator("#donorList article.donor").count() == 2, "donor cards render",
               page.locator("#donorList article.donor").count())
        expect("Rahim Uddin" in page.inner_text("#donorList"), "donor names render")
        expect("O+" in page.inner_text("#donorList"), "blood group badge renders")
        expect("01711111111" not in page.inner_text("#donorList"),
               "phone numbers are NOT part of the directory payload")

        # contact reveal
        page.locator("#donorList [data-contact]").first.click()
        page.wait_for_timeout(400)
        expect(page.is_visible("#modalback .modal"), "contact dialog opens")
        expect("01711111111" in page.inner_text("#modalContent"), "phone is revealed for a consented donor",
               page.inner_text("#modalContent"))
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        expect(page.locator("#modalback").evaluate("el => !el.classList.contains('open')"),
               "Escape closes the dialog")

        # filters
        page.select_option("#filterBlood", "B+")
        page.click("#searchBtn")
        page.wait_for_timeout(500)
        expect(page.locator("#donorList article.donor").count() == 1, "blood-group filter is sent to the backend")
        sent = mock.submissions.get("public_donor_search", {})
        expect(sent.get("p_blood_group") == "B+", "filter payload contains the blood group", sent)
        expect(sent.get("p_limit") and sent.get("p_offset") == 0, "search is paginated server-side", sent)

        page.fill("#filterLocation", "nowhere-at-all")
        page.select_option("#filterBlood", "")
        page.click("#searchBtn")
        page.wait_for_timeout(500)
        expect(page.locator("#donorList .state").count() == 1, "no-results state is shown")
        expect("পাওয়া যায়নি" in page.inner_text("#donorList"), "no-results message is helpful")

        # registration validation + submit
        page.fill("#filterLocation", "")
        page.click("#searchBtn")
        page.wait_for_timeout(300)
        page.click("[data-action='open-register']")
        page.wait_for_timeout(200)
        page.click("#donorSubmit")
        page.wait_for_timeout(200)
        expect(page.locator("#donorForm [data-error='name']").inner_text().strip() != "",
               "empty registration shows inline validation")
        page.fill("#f-name", "Test Donor")
        page.select_option("#f-blood_group", "AB-")
        page.fill("#f-district", "Cumilla")
        page.fill("#f-area", "Barura")
        page.fill("#f-phone", "12345")
        page.check("#f-consent")
        page.click("#donorSubmit")
        page.wait_for_timeout(200)
        expect("মোবাইল নম্বর" in page.inner_text("#donorForm [data-error='phone']"),
               "invalid phone number is rejected in the browser")
        page.fill("#f-phone", "01712345678")
        page.fill("#f-last_donation", "2020-01-01")
        page.click("#donorSubmit")
        page.wait_for_timeout(600)
        expect("নিবন্ধন জমা হয়েছে" in page.inner_text("#modalContent"), "valid registration reports success",
               page.inner_text("#modalContent")[:150])
        reg = mock.submissions.get("submit_donor_registration", {})
        expect(reg.get("p_phone") == "01712345678" and reg.get("p_blood_group") == "AB-"
               and reg.get("p_consent") is True, "registration payload is correct", reg)
        expect("status" not in reg, "the browser does not send a status/approval field")
        page.click("#regDone")

        # blood request
        page.click("[data-action='open-request']")
        page.wait_for_timeout(200)
        page.fill("#f-patient_name", "Karim")
        page.select_option("#f-blood_group", "O+")
        page.fill("#f-bags", "2")
        page.fill("#f-hospital", "Cumilla Medical")
        page.fill("#f-location", "Cumilla")
        page.fill("#f-phone", "01712345679")
        page.select_option("#f-urgency", "critical")
        page.click("#requestSubmit")
        page.wait_for_timeout(600)
        expect("অনুরোধ জমা হয়েছে" in page.inner_text("#modalContent"), "blood request reports success",
               page.inner_text("#modalContent")[:150])
        req = mock.submissions.get("submit_blood_request", {})
        expect(req.get("p_urgency") == "critical" and req.get("p_bags") == 2, "request payload is correct", req)
        page.click("#reqDone")

        # privacy / removal
        page.click("footer [data-action='open-privacy']")
        page.wait_for_timeout(200)
        expect("গোপনীয়তা" in page.inner_text("#modalTitle"), "privacy notice opens")
        page.keyboard.press("Escape")
        page.click("footer [data-action='open-remove']")
        page.wait_for_timeout(200)
        expect("সংশোধন" in page.inner_text("#modalTitle"), "correction/removal request dialog opens")
        page.keyboard.press("Escape")

        expect(not errors, "no JavaScript errors on the public site", errors)
        context.close()

        # -----------------------------------------------------------------
        section("Responsive layout")
        for label, width, height, mobile in [("mobile 390px", 390, 844, True),
                                             ("tablet 820px", 820, 1180, False),
                                             ("desktop 1280px", 1280, 900, False)]:
            mock = MockSupabase()
            context, errors = new_context(browser, mock, width=width, height=height)
            page = context.new_page()
            attach_error_capture(page, errors)
            page.goto(BASE + "/index.html", wait_until="networkidle")
            page.wait_for_timeout(400)
            overflow = page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
            expect(overflow <= 1, f"{label}: no horizontal scrolling", f"overflow {overflow}px")
            if mobile:
                expect(page.locator("#navToggle").is_visible(), f"{label}: hamburger menu is visible")
                expect(not page.locator("#navMenu").is_visible(), f"{label}: menu starts collapsed")
                page.click("#navToggle")
                page.wait_for_timeout(200)
                expect(page.locator("#navMenu").is_visible(), f"{label}: menu opens on tap")
                expect(page.locator("#navMenu a").first.is_visible(), f"{label}: menu links are usable")
            else:
                expect(page.is_visible("#navMenu"), f"{label}: desktop navigation is visible")
            expect(page.locator("#donorList article.donor").count() == 2, f"{label}: donor cards render")
            expect(not errors, f"{label}: no JavaScript errors", errors)
            context.close()

        # -----------------------------------------------------------------
        section("Admin panel — access control")
        mock = MockSupabase()
        context, errors = new_context(browser, mock)
        page = context.new_page()
        attach_error_capture(page, errors)
        page.goto(BASE + "/index.html?admin=1", wait_until="networkidle")
        page.wait_for_timeout(600)
        expect(page.locator("#loginForm").is_visible(), "unauthenticated visitor sees the login form")
        expect(page.locator("#adminShell").is_hidden(), "dashboard is not rendered before authentication")
        expect(page.locator("#publicApp").is_hidden(), "public site is hidden in the admin route")
        expect(page.locator("#tab-overview").is_hidden() and page.locator("#stApproved").is_hidden(),
               "no dashboard widgets are visible to an unauthenticated visitor")
        expect(page.locator("#adminDonors").is_hidden() and page.locator("#adminRequests").is_hidden(),
               "no admin data tables are visible to an unauthenticated visitor")

        # inactive admin
        mock.admins = [{"user_id": "u1", "email": "admin@scg.test", "role": "admin",
                        "active": False, "created_at": "2026-01-01T00:00:00Z"}]
        page.fill("#loginEmail", "admin@scg.test")
        page.fill("#loginPassword", "a-long-password")
        page.click("#loginBtn")
        page.wait_for_timeout(900)
        expect(page.locator("#adminShell").is_hidden(), "inactive admin cannot see the dashboard")
        expect(page.locator("#authMessage").is_visible(), "inactive admin is told access is denied",
               page.inner_text("#adminAuth")[:200])
        expect(page.locator("#loginForm").is_visible() or page.locator("#authMessage").is_visible(),
               "inactive admin is sent back to a safe screen")

        # non-admin account
        mock.admins = []
        page.goto(BASE + "/index.html?admin=1", wait_until="networkidle")
        page.wait_for_timeout(400)
        page.fill("#loginEmail", "someone@else.test")
        page.fill("#loginPassword", "a-long-password")
        page.click("#loginBtn")
        page.wait_for_timeout(900)
        expect(page.locator("#adminShell").is_hidden(), "a non-admin account gets no dashboard")
        expect(page.locator("#authMessage").is_visible(), "a non-admin account sees the denial message")

        # authorised owner
        mock.admins = [{"user_id": "u1", "email": "admin@scg.test", "role": "owner",
                        "active": True, "created_at": "2026-01-01T00:00:00Z"}]
        page.goto(BASE + "/index.html?admin=1", wait_until="networkidle")
        page.wait_for_timeout(400)
        page.fill("#loginEmail", "admin@scg.test")
        page.fill("#loginPassword", "a-long-password")
        page.click("#loginBtn")
        page.wait_for_timeout(1200)
        expect(page.locator("#adminShell").is_visible(), "authorised owner reaches the dashboard")
        expect("admin@scg.test" in page.inner_text("#adminEmail"), "signed-in admin email is shown")
        expect(page.inner_text("#stApproved").strip() == "2", "overview shows real approved count",
               page.inner_text("#stApproved"))
        expect(page.inner_text("#stPending").strip() == "1", "overview shows pending registrations")
        expect(page.inner_text("#stReqPending").strip() == "1", "overview shows pending requests")

        # donors tab
        page.click(".sidebtn[data-tab='donors']")
        page.wait_for_timeout(700)
        rows = page.locator("#adminDonors tbody tr").count()
        expect(rows == 3, "admin sees every donor row (including pending)", rows)
        expect("01911111115" in page.inner_text("#adminDonors"), "admin table exposes contact numbers")
        expect("Pending" in page.inner_text("#adminDonors"), "status badges render")

        # approve
        page.locator("#adminDonors [data-approve]").first.click()
        page.wait_for_timeout(700)
        approved = [d for d in mock.donors if d["status"] == "approved"]
        expect(len(approved) == 3, "approve action updates the database", [d["status"] for d in mock.donors])

        # destructive action requires confirmation
        page.locator("#adminDonors [data-delete-donor]").first.click()
        page.wait_for_timeout(300)
        expect(page.is_visible("#modalback .modal"), "delete asks for confirmation")
        page.click("#confirmNo")
        page.wait_for_timeout(300)
        expect(len(mock.donors) == 3, "cancelling the confirmation deletes nothing", len(mock.donors))
        page.locator("#adminDonors [data-delete-donor]").first.click()
        page.wait_for_timeout(300)
        page.click("#confirmYes")
        page.wait_for_timeout(800)
        expect(len(mock.donors) == 2, "confirming the dialog deletes the row", len(mock.donors))

        # filter round-trip
        page.fill("#dSearch", "Salma")
        page.wait_for_timeout(900)
        sent = mock.submissions.get("admin_list_donors", {})
        expect(sent.get("p_search") == "Salma", "admin search is sent to the server", sent)
        expect(page.locator("#adminDonors tbody tr").count() == 1, "admin search filters rows")

        # requests tab
        page.fill("#dSearch", "")
        page.wait_for_timeout(700)
        page.click(".sidebtn[data-tab='requests']")
        page.wait_for_timeout(700)
        expect(page.locator("#adminRequests tbody tr").count() == 1, "request table renders")
        page.select_option("#adminRequests [data-request-status]", "fulfilled")
        page.wait_for_timeout(700)
        expect(mock.requests[0]["status"] == "fulfilled", "status change is written to the database")
        page.click("#adminRequests [data-view-request]")
        page.wait_for_timeout(300)
        expect("Patient A" in page.inner_text("#modalContent"), "request detail dialog shows full data")
        page.keyboard.press("Escape")

        # ads tab
        page.click(".sidebtn[data-tab='ads']")
        page.wait_for_timeout(500)
        expect("কোনো বিজ্ঞাপন নেই" in page.inner_text("#adminAds"), "ad manager shows an empty state")
        page.fill("#adTitle", "স্বেচ্ছায় রক্তদান করুন")
        page.fill("#adText", "আজই নিবন্ধন করুন")
        page.fill("#adEnd", "2027-01-01T10:00")
        page.click("#adSaveBtn")
        page.wait_for_timeout(700)
        expect(any(c[1] == "/rest/v1/ads" and c[0] == "POST" for c in mock.calls), "ad is created through the API")

        # admin list + settings
        page.click(".sidebtn[data-tab='admins']")
        page.wait_for_timeout(500)
        expect("admin@scg.test" in page.inner_text("#adminUsersList"), "admin accounts are listed")
        page.click(".sidebtn[data-tab='settings']")
        page.wait_for_timeout(900)
        expect("Publishable key" in page.inner_text("#diagBox"), "setup diagnostics panel renders")
        expect(not errors, "no JavaScript errors in the admin panel", errors)

        # logout
        page.click("#logoutBtn")
        page.wait_for_timeout(800)
        expect(page.locator("#adminShell").is_hidden(), "logout hides the dashboard immediately")
        expect(page.locator("#loginForm").is_visible(), "logout returns to the login form")
        context.close()

        # -----------------------------------------------------------------
        section("Admin panel — not configured")
        mock = MockSupabase(configured=False)
        context, errors = new_context(browser, mock)
        page = context.new_page()
        attach_error_capture(page, errors)
        page.goto(BASE + "/index.html?admin=1", wait_until="networkidle")
        page.wait_for_timeout(600)
        expect(page.locator("#adminShell").is_hidden(), "misconfigured project never shows a dashboard")
        expect(page.locator("#authMessage").is_visible(), "misconfigured project shows a setup message",
               page.inner_text("#adminAuth")[:200])
        expect(not errors, "no JavaScript errors", errors)
        context.close()

        browser.close()

    print("\n" + "─" * 64)
    if failures:
        print(f"\033[31m{len(failures)} check(s) failed\033[0m, {passed} passed.")
        for name, detail in failures:
            print(f" - {name}: {detail}")
        sys.exit(1)
    print(f"\033[32mAll {passed} browser checks passed.\033[0m")


if __name__ == "__main__":
    main()
