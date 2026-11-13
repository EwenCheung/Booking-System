# NUS REBOKS booking helper

A local dashboard and deterministic Playwright scheduler for REBOKS. It lets you queue a facility request before the booking window opens, then follows a fixed browser route at the release time:

1. open the saved local REBOKS browser profile;
2. select the activity, venue, and date using stable form IDs;
3. select the requested available timeslot;
4. submit the booking and only continue checkout within the authorised price limit; and
5. record `booked`, `failed`, `needs_attention`, or `payment_required` in the local dashboard.

There is no AI agent or LLM in the booking path. Playwright is used as ordinary deterministic browser automation. Public activity/venue dropdown data is fetched directly because it does not require login; availability and bookings use Playwright and the same persistent browser profile.

## Booking-window rule

The [NUS Sports and Recreation FAQ](https://uci.nus.edu.sg/resources/faqs/campus-services-sports-recreation/) currently says selected facilities can be booked up to 14 days in advance and gives the example that a 14 January slot opens at 12:00 on 1 January. The default queue rule is therefore target date minus 13 calendar days at 12:00 Singapore time. Confirm this rule against current NUS guidance; you can override it per request.

The helper respects REBOKS access controls and booking limits. It does not bypass MFA, CAPTCHA, or payment. It makes one booking attempt at a time and makes at most three short retries after a transient failure.

## Setup

Requirements: Node.js 20+ and Chromium. Background scheduling is supported on macOS.

```bash
npm install
npx playwright install chromium
npm run dashboard
```

The dashboard opens at `http://127.0.0.1:4173`. Click **Refresh NUS login**, complete SSO and MFA in the visible browser window, then create a request. The persistent authenticated profile lives only in git-ignored `data/browser-profile/`; no password is saved.

## Dashboard workflow

1. Choose activity, venue, date, time, and optionally a specific court.
2. Use **Check availability** to inspect the signed-in REBOKS page and select a returned slot.
3. Set the maximum authorised charge (zero means no charge is authorised).
4. Add the request to the queue and use **Validate request** to execute the route without submitting.
5. Install the macOS service to keep the queue running after the dashboard closes.

The background service keeps a small local process alive and checks the queue twice per second. The Mac must be awake, online, and logged in. Actual timing also depends on NUS and network latency, so this is low-latency automation rather than a promise of an exact millisecond.

## Command line

```bash
# Login once (opens a browser for SSO/MFA)
npm run login -- --role student

# Find exact public activity and venue labels
npm run booking -- discover --activity "Badminton"

# Inspect availability using Playwright and the saved profile
npm run availability -- --activity "Badminton" --venue "Kent Ridge - Multi-purpose Sports Hall 5" --date 2026-12-05

# Queue a booking
npm run booking -- queue add --activity "Badminton" --venue "Kent Ridge - Multi-purpose Sports Hall 5" --date 2026-12-05 --start 18:00 --end 19:00 --resource "Court 1" --max-price 0

# Test the fixed route without submitting
npm run booking -- run JOB_ID --dry-run --headed

# Install/remove the background scheduler (macOS)
npm run service:install
npm run service:uninstall
```

Use `--run-at 2026-11-22T12:00` on `queue add` to override the calculated release time. A timestamp with no offset is Singapore time.

## Statuses and recovery

- `pending` / `retry`: waiting for execution.
- `running`: fixed Playwright route is in progress.
- `booked`: REBOKS displayed an explicit booking-success confirmation.
- `payment_required`: a charge exceeded the approved limit or manual payment is needed.
- `needs_attention`: the page did not match a safe, pre-written route; debug artifacts are saved under ignored `output/playwright/`.
- `auth_required`: refresh NUS login, then run the job again.
- `failed`: retries are exhausted; inspect the dashboard message.

GitHub Actions is not the recommended scheduler here: it would require exporting an authenticated NUS session as a repository secret, and hosted runners cannot complete SSO/MFA or guarantee a warm persistent browser profile. Run the local macOS service instead.

Never commit or share `data/browser-profile/` or `output/playwright/`; they can contain authenticated session state and booking details.
