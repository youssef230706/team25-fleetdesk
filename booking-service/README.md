# Booking service (Youssef)

Part of FleetDesk: one website, three separately deployed APIs. This one handles car bookings:
search free cars, request, approve or reject, cancel, complete, and the trip estimate (OpenRouteService).
Contract for the other services: [`docs/booking-api.md`](../docs/booking-api.md).

```
booking-service/
├── server.js                 Express app (helmet, CORS allow-list, rate limit, JSON only), exported for Vercel
├── routes/bookings.js        URLs and who may call them
├── controllers/bookings.js   input checks (dates, lengths, numbers), then calls the service
├── services/bookingService.js  booking rules and the SQL (parameterised)
├── clients/fleetClient.js    calls Kareem's Fleet API (availability, cars), fails closed with 503
├── clients/routeClient.js    calls OpenRouteService (geocode + route), cached 24 h
├── clients/eventPublisher.js signed webhooks (HMAC-SHA256) to other services; SNS on Floci
├── clients/alertClient.js    alerts to a Discord/Slack/Teams webhook (or SNS on Floci)
├── services/events.js        records every booking change (audit trail) and publishes it
├── services/eventStore.js    the booking_events table (history, metrics, alert history)
├── services/monitor.js       counts 401/403/429/503, admin metrics, alert rules with cooldown
├── middleware/               auth.js + requireRole.js copied unchanged from fleet-service, plus logging,
│                             error handling, JSON-only and rate limits
├── db/schema.sql             bookings table, the "no double approval" constraint, least-privilege role
├── db/sql.js                 Neon connection
├── tests/                    Jest + Supertest on an in-memory Postgres (pg-mem); no secrets needed
├── scripts/demo.js, demo-all.js   local demo without Neon
├── scripts/security-tests.js controlled security tests against a running deployment -> results table
└── scripts/secret-scan.js    secret exposure review of the repository
```

## Run it on your PC

Needs Node.js 20 or newer.

```powershell
cd fleet-service ; npm install ; cd ..      # once, for Kareem's API
cd booking-service ; npm install            # once
npm test                                    # 102 tests
npm run secret-scan                         # secret exposure review of the whole repository
npm run demo:all                            # Fleet API :3001 + Booking API :3002 + website :8080
```

Open http://localhost:8080 and log in as `sara@fleetdesk.test` or `admin@fleetdesk.test`
(password `Demo-Pass-2026`), then click **Bookings**. Everything is in memory and is lost on Ctrl+C.
For trip estimates, put a free OpenRouteService key in `booking-service/.env` as `ORS_API_KEY`.

## Security tests against a deployment

With the demo running (`npm run demo:all`) just run `npm run security-tests`. Against the live site:

```powershell
$env:BOOKING_API_URL="https://<booking-api>.vercel.app"; $env:FLEET_API_URL="https://fleetdesk-fleet-api.vercel.app"
$env:EMPLOYEE_EMAIL="..."; $env:EMPLOYEE_PASSWORD="..."      # employee A
$env:EMPLOYEE2_EMAIL="..."; $env:EMPLOYEE2_PASSWORD="..."    # employee B
$env:ADMIN_EMAIL="..."; $env:ADMIN_PASSWORD="..."            # a FleetAdmin
npm run security-tests
```

It runs 23+ controlled tests (unauthenticated access, wrong role, ownership, invalid input, mass assignment,
double approval, headers, CORS, secret exposure, logging) and writes `scripts/security-test-results.md`
(the table for the report). Its test bookings are far in the future and are cancelled at the end.

## Neon (once)

1. Create a Neon project (or a separate database) for Booking.
2. In the Neon SQL Editor, run all of `db/schema.sql`.
3. Create the `booking_api` role with the commented lines at the end of `schema.sql`
   (SELECT, INSERT, UPDATE on bookings; on booking_events only the delivery column can change,
   so the audit trail cannot be rewritten or deleted).
4. Build `DATABASE_URL` with `booking_api` and send it to Kareem **privately**. Never commit it.

## Vercel (Kareem deploys)

Root Directory `booking-service`. Environment variables:

| Name | Value |
|---|---|
| `DATABASE_URL` | Neon connection string (booking_api role) |
| `JWT_SECRET` | the same secret as the Fleet API |
| `NODE_ENV` | `production` |
| `CORS_ORIGINS` | `https://fleetdesk-frontend-eta.vercel.app,http://localhost:8080` |
| `FLEET_API_URL` | `https://fleetdesk-fleet-api.vercel.app` |
| `ORS_API_KEY` | OpenRouteService key |
| `COMPANY_ORIGIN` | optional, `longitude,latitude` of the company (default New Cairo) |
| `EVENT_WEBHOOK_URLS` + `WEBHOOK_SECRET` | optional: where to send signed booking events (e.g. the Trip service) |
| `ALERT_WEBHOOK_URL` | optional: Discord/Slack/Teams webhook for monitoring alerts |

On the Fleet project, `BOOKING_API_URL` must be set to this API's URL, so maintenance checks booking clashes.

## Security controls in this service

- Login token checked on every route (HS256 only, issuer `fleetdesk`, expiry); the user comes from `req.user` only.
- Roles: only a FleetAdmin can approve, reject or call `/conflicts`; an admin cannot approve their own booking.
- IDOR: employees only ever see their own bookings (`403` otherwise, logged as `idor_blocked`).
- Mass assignment: only whitelisted body fields are read; status and owner are always set by the server.
- Double booking: checked in code, with conditional updates (`WHERE status = 'Pending'`), and finally refused
  by the database itself (`no_double_approved_booking` exclusion constraint).
- Fail closed: if the Fleet API cannot be reached, no booking is created or approved (`503`).
- Validation on every field, 10 kb body limit, JSON only, parameterised SQL, rate limits (100/min per IP,
  10 estimates/min per user), helmet headers, CORS allow-list, structured security logs.
- Secrets only in environment variables; `.env` is in `.gitignore`; `npm run secret-scan` checks the repository.
- Audit trail: every change is an event (who, when, from/to); the API role cannot edit or delete events.
- Signed events: HMAC-SHA256 with a timestamp, so other services can reject forged or replayed events.
- Monitoring: 401/403/429/503 are counted; an admin panel shows them; alerts fire on spikes (with a cooldown).
