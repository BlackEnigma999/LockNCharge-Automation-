# Chromebook Locker Automation

Google Apps Script bound to a Google Sheet. Uses the Lock N Charge public API
(`https://api.lockncharge.io`, spec at `https://docs.lockncharge.io/publicapi.json`) and the Google Admin SDK.

## Behavior
- **Webhook `BAY_CREDS_CACHED` ("Bay reserved")** = **pickup**: opens a `Checkouts` row (student name and ID from
  the Lock N Charge user's PIN, time from the event).
- **Webhook `BAY_CREDS_CLEARED` ("Bay accessed")** = **return**: only counts if that bay has an open `Out` row and
  the same student scans; Status -> `Returned` with the event time. A different student opening the bay is ignored.
  `BAY_CLOSED` is ignored. Repeated deliveries are de-duplicated (Lock N Charge retries after 5 s).
- **Weekdays ~4:30 PM (`checkOverdue`)**: anything still `Out` since before 4:15 PM is **disabled** in Google
  Admin (matched by Asset ID = bay name), its bay is set **offline**, and the student is added to the `Overdue`
  tab for the front office.
- **Late returns:** the overdue bay is set offline (`CFG.OFFLINE_OVERDUE_BAYS = true`). IT puts the laptop back by
  hand and sets the row's Status on `Overdue` to **Returned (bin)** (re-enables the Chromebook and brings the bay
  online), or brings the bay online so the periodic sync sees it as returned. Set the flag to `false` to leave
  overdue bays online so the student can return the laptop by scanning in (fully automatic).
- Bays are named after each Chromebook's asset tag. Tabs: `Checkouts`, `Overdue` (columns A-G mirror the old
  Sheet 1), `Webhook Log` (raw events), `Log` (every action/decision).

## Setup
1. Spreadsheet > Extensions > Apps Script. Paste `Code.gs`. Add the **Admin SDK API** service (or add it via
   `appsscript.json`). Set the project time zone and `CFG.TZ` (default `America/Los_Angeles`).
2. Script Properties (never commit these): `SHEET_ID`, `LNC_BASE_URL` (`https://api.lockncharge.io`),
   `LNC_CLIENT_ID`, `LNC_CLIENT_SECRET`, `WEBHOOK_KEY` (long random string), optional `HOLIDAYS`
   (`2026-11-26,2026-12-25`).
3. Run `testLncConnection` (read-only), `testSheetSetup`, `testAdminLookup`.
4. Deploy > New deployment > Web app > Execute as **Me**, access **Anyone**. After any code change use
   Manage deployments > pencil > **New version** (the URL stays the same).
5. In Lock N Charge (Integrations > Webhooks) add `<web app URL>?key=<WEBHOOK_KEY>` for the **"Bay reserved"** and **"Bay accessed"** events.
6. Run `installTriggers` once.
7. Keep `CFG.DRY_RUN = true` until verified; set it to `false` to go live.

## Notes
- Web apps have no active spreadsheet, so the sheet is opened by `SHEET_ID`.
- If an event is missed the bay's checkout/return state can flip; fix by setting Status by hand in `Checkouts`.
- The student PIN doubles as the student ID: restrict who can view the sheet.
