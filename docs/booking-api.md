# Booking API: contract for the other two services

Owner: Youssef. Base URL: `https://<booking-api>.vercel.app`, or `http://localhost:3002` locally.
Same rules as the Fleet API: JSON bodies, the shared login token as `Authorization: Bearer <token>`,
and every error as `{ "error": { "code": "SOME_CODE", "message": "Readable text" } }`.

A car is free only when **both** services agree:
- Fleet: the car is in service and has no maintenance in that period.
- Booking: no **Approved** booking overlaps.

## For Kareem (Fleet)

### Does an approved booking overlap?
`GET /api/bookings/conflicts?vehicleId={id}&from=2026-12-01T09:00:00Z&to=2026-12-01T17:00:00Z`

- **Who can call it:** FleetAdmin token only (Fleet forwards the admin's own token). An Employee gets `403`.
- **Returns:** `200 { "conflict": true | false }`. `true` means an Approved booking overlaps the period.
  Pending, Rejected, Cancelled and Completed bookings never count.
  Periods that only touch do not clash (one ends at 17:00, the other starts at 17:00).
- **Errors:** `400` (missing vehicleId or bad dates), `401`, `403`

What Booking calls on Fleet (always with the user's own token; if Fleet cannot be reached,
Booking answers `503 FLEET_SERVICE_UNAVAILABLE` and creates or approves nothing):
- `GET /api/vehicles?status=Available` for the car search
- `GET /api/vehicles/{id}` for the seats, plate and name of the chosen car
- `GET /api/vehicles/{id}/availability?from=&to=` before **creating** and again before **approving**

## For Ziad (Trip, Fuel & Reporting)

### Read one booking (the estimate for "estimate vs actual")
`GET /api/bookings/{id}`

- **Who can call it:** the employee who made the booking, or a FleetAdmin. Anyone else gets `403`.
- **Returns** (the fields Trip needs):

```json
{
  "id": "…", "userId": "…", "userName": "Sara Employee",
  "vehicleId": "…", "vehiclePlate": "ABC 123", "vehicleLabel": "Toyota Corolla (2022)",
  "destination": "Smart Village, Giza", "passengers": 2,
  "startAt": "2026-12-01T09:00:00.000Z", "endAt": "2026-12-01T13:00:00.000Z",
  "status": "Approved",
  "estimate": { "distanceKm": 31.4, "durationMinutes": 38, "source": "OpenRouteService" },
  "actualKm": null
}
```

`estimate` is `null` when OpenRouteService was not reachable at booking time.
**Booking owns the OpenRouteService call**: the estimate is saved with the booking, so Trip never calls ORS.

### List bookings
`GET /api/bookings?status=Approved&vehicleId={id}&mine=true`

Employees always get only their own. A FleetAdmin gets everyone's, or only their own with `mine=true`.

### Close the trip at check-in
`PATCH /api/bookings/{id}/status` with `{ "status": "Completed", "actualKm": 43.6 }`

- **Who:** the employee who made the booking, or a FleetAdmin.
- **Only when** the booking is Approved and its start time has passed. Otherwise `409`.
- `actualKm` is optional (0 to 5000). Trip remains the owner of the odometer readings and fuel logs.

## Events (audit trail and notifications)

Every change is recorded as an event in `booking_events` (who, when, from/to status) and, when configured,
sent to the other services:

| Event | When |
|---|---|
| `booking.created` | an employee requests a car (status Pending) |
| `booking.updated` | the owner edits a Pending booking |
| `booking.approved` / `booking.rejected` | a FleetAdmin decides |
| `booking.cancelled` | the owner, or an admin with a reason, cancels |
| `booking.completed` | the car is returned (Trip check-in) |

**Push (webhook).** Booking POSTs to each address in its `EVENT_WEBHOOK_URLS`:

```json
{ "id": "…", "type": "booking.approved", "at": "2026-12-01T08:00:00.000Z",
  "actor": { "id": "…", "role": "FleetAdmin" },
  "booking": { "id": "…", "userId": "…", "vehicleId": "…", "status": "Approved",
               "startAt": "…", "endAt": "…", "estimate": { "distanceKm": 31.4, "durationMinutes": 38 }, "actualKm": null } }
```

Headers: `X-FleetDesk-Event: booking.approved` and `X-FleetDesk-Signature: t=<unix seconds>,v1=<hex>`.
**Verify it before trusting the event**: `v1` must equal HMAC-SHA256(`WEBHOOK_SECRET`, `"<t>.<raw body>"`) and
`t` must be less than 5 minutes old (see `verify()` in `booking-service/clients/eventPublisher.js`).
The payload never contains the purpose, the reasons or any free text. Answer with any 2xx.

**Pull (feed).** `GET /api/bookings/events?since=<ISO date>&type=booking.approved` (FleetAdmin token):
the newest 100 booking events, useful if a webhook was missed.

**History.** `GET /api/bookings/{id}/history` (the owner or a FleetAdmin): the booking's audit trail, oldest first.

## Monitoring

`GET /api/bookings/metrics` (FleetAdmin): bookings by status; last 24 hours of requests, decisions,
401/403/429 and Fleet failures; the two alert rules with their current count; recent alerts and security events.
Alerts go to `ALERT_WEBHOOK_URL` (Discord/Slack/Teams) when 401+403 reach `ALERT_DENIED_THRESHOLD` (default 10)
or Fleet failures reach `ALERT_FLEET_THRESHOLD` (default 3) within 15 minutes, at most once per rule per 15 minutes.

## Booking life cycle (one flow)

```
Pending ──(admin approves)──► Approved ──(car returned, Trip check-in)──► Completed
   │                              │
   ├──(admin rejects + reason)──► Rejected
   └──(owner cancels)───────────► Cancelled ◄──(owner, or admin + reason, before the start)
```

| Change | Who | Rule |
|---|---|---|
| create (`POST /api/bookings`) | any logged-in user | always starts `Pending`; up to 14 days long, at most 90 days ahead, not in the past |
| edit (`PATCH /api/bookings/{id}`) | owner | only while `Pending` |
| `Approved` / `Rejected` | FleetAdmin | only from `Pending`; never their own booking; a reason is needed to reject |
| `Cancelled` | owner, or FleetAdmin with a reason | from `Pending`, or from `Approved` before the start |
| `Completed` | owner or FleetAdmin | from `Approved`, after the start |

Other endpoints used by the bookings page: `GET /api/bookings/availability?from=&to=&seats=`
and `GET /api/bookings/estimate?destination=` (10 per minute per user).
