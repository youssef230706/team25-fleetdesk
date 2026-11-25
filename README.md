# FleetDesk: Company Fleet Booking (Team 25)

Cloud Computing & Cloud Security (26CSCN29H), BUE. One website, three separately deployed services,
running on **Floci** (the local AWS emulator from Lab 7).

| Service | Folder | Owner | Stores data in | Talks to |
|---|---|---|---|---|
| Fleet & Maintenance + shared login | `fleet-service/` | Kareem | RDS Postgres | Booking (clash check before maintenance) |
| Booking | `booking-service/` | Youssef | DynamoDB (+ audit trail) | Fleet (car availability), OpenRouteService (trip estimate), SNS events |
| Trip, Fuel & Reporting | `trip-service/` | Ziad | RDS / DynamoDB | Booking (estimate vs actual), Fleet (mileage) |
| Website | `frontend/` | shared (each owns their pages) | S3 | the three APIs |
| Deployment | `floci/` | Youssef | | Lambda, API Gateway, RDS, DynamoDB, SNS/SQS, S3 |

```
Browser ── S3 website ──► API Gateway ──► Lambda: Fleet ───► RDS Postgres
                      │                      ▲   │ Lambda Invoke (clash check)
                      │                      │   ▼
                      └──► API Gateway ──► Lambda: Booking ──► DynamoDB (bookings, events)
                      │                      │   ├─► SNS booking events ──► SQS (Trip)
                      │                      │   ├─► SNS alerts ──► SQS
                      │                      │   └─► OpenRouteService (internet)
                      └──► API Gateway ──► Lambda: Trip ──► its database
```

## Run everything (Docker Desktop + Node.js 20+)

```powershell
git clone <this repository>
cd team25-fleetdesk\floci
docker compose up -d
npm install
npm run deploy
```

Then open http://localhost:4566/fleetdesk-site/index.html. Details: [`floci/README.md`](floci/README.md).
How we work together (branches, pull requests, reviews): [`docs/team-guide.md`](docs/team-guide.md).

## Security at a glance

- One login (bcrypt + lockout) in Fleet; a signed JWT checked by every service; roles Employee / FleetAdmin
- Ownership checks on every record, validation on every field, parameterised queries, JSON-only, size limits
- Least-privilege database roles (no DELETE), secrets only in environment variables (never in Git)
- Security logs, an admin monitoring panel and alerts; signed events between services
- Tests in every service, plus `npm run security-tests` against the running deployment
