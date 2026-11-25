# FleetDesk on Floci (the team deployment)

This folder deploys the **whole** FleetDesk project (Fleet API, Booking API, the website)
to **Floci**, the AWS emulator from Lab 7. Every team member runs the same command on their own PC.

| Earlier plan (Vercel + Neon) | Floci (what we deploy now) |
|---|---|
| Neon Postgres (Fleet) | **RDS Postgres**: `fleetdesk-fleet-db` (users, cars, maintenance, reports) |
| Neon Postgres (Booking) | **DynamoDB**: table `FleetDeskBookings` (bookings) |
| Vercel runs each Express API | **Lambda**: `fleetdesk-fleet-api`, `fleetdesk-booking-api` (same Express code via `serverless-http`) |
| One Vercel URL per API | **API Gateway** (HTTP API): one per service |
| Fleet ↔ Booking call each other over HTTPS | **Lambda Invoke**: `lambda://fleetdesk-booking-api` and `lambda://fleetdesk-fleet-api` |
| Vercel hosts the website | **S3** bucket `fleetdesk-site` |
| Signed webhooks for booking events | **SNS** `fleetdesk-booking-events` → **SQS** `trip-booking-events` (for the Trip service) |
| Alerts to Discord/Teams | **SNS** `fleetdesk-alerts` → **SQS** `fleetdesk-alerts-inbox` (+ your `ALERT_WEBHOOK_URL` if set in `floci\.env`) |
| Audit trail in Postgres | **DynamoDB** table `FleetDeskBookingEvents` |

The service folders (`fleet-service`, `booking-service`, `frontend`) are **exactly** the GitHub code.
All Floci-only changes happen in `floci/build/` while deploying:

- `db/sql.js` is swapped for `runtime/sql.js` (the standard `pg` driver for RDS; it still uses Neon for neon.tech addresses)
- Booking's `services/bookingService.js` is swapped for `runtime/dynamoBookingService.js`: the same functions and rules,
  stored in DynamoDB. Overlapping approvals are stopped by a per-car lock item and a DynamoDB transaction
  (instead of the Postgres exclusion constraint). To keep bookings in Postgres instead: `$env:BOOKING_STORE="rds"; npm run deploy`
- `lambda.js` (the Lambda handler) and `lambda-fetch.js` (service-to-service Invoke) are added
- the website gets a `config.js` with the Floci API addresses, and a **Bookings** link in Kareem's menu

## Run it (PowerShell)

Needs Docker Desktop running, and Node.js 20+.

```powershell
cd floci                    # inside your clone of the repository
docker compose up -d        # start Floci (stop the Lab 7 Floci first: only one can use port 4566)
npm install                 # once
npm run deploy              # databases, Lambdas, API Gateway, website (takes a few minutes the first time)
```

At the end it prints the website address, `http://localhost:4566/fleetdesk-site/index.html`.
Log in as `sara@fleetdesk.test`, `omar@fleetdesk.test` or `admin@fleetdesk.test`, password `Demo-Pass-2026`.

If the S3 address does not show the site, run `npm run site` and open http://localhost:8080 instead.
The pages still use the APIs on Floci.

Trip estimates: put `ORS_API_KEY=...` in `floci\.env` (or `booking-service\.env`) and run `npm run deploy` again.

## See the data

| What | Where |
|---|---|
| Everything, in the terminal | `npm run db` (or `npm run db -- bookings`, `-- vehicles`, `-- users`) |
| **DynamoDB** bookings in the browser | http://localhost:8001 (no login): click **FleetDeskBookings** |
| **RDS Postgres** (Fleet) in the browser | http://localhost:8081 (Adminer), log in as below |
| What is deployed | `npm run status` |

Adminer login: System **PostgreSQL**, Server **`floci:7001`**, Username **`fleetdesk`**,
Password = the `masterPassword` in `floci\.state.json`, Database **`postgres`**.
Copy the password without showing it: `(Get-Content .state.json | ConvertFrom-Json).masterPassword | Set-Clipboard`

In the DynamoDB viewer you also see one `LOCK#<car id>` item per approved car: that is the approval lock, not a booking.

## Add users

Passwords are stored only as bcrypt hashes, so add users with this command (not by typing a row in Adminer):

```powershell
npm run add-user -- "Mona Hassan" mona@fleetdesk.test Employee "Mona-Pass-2026"
npm run add-user -- "Second Admin" admin2@fleetdesk.test FleetAdmin "Admin2-Pass-2026"
```

Role is `Employee` or `FleetAdmin`. Running it again for the same email changes that user's name, role or password
(and unlocks the account). Users are wiped with everything else on `docker compose down`.

## Events, audit trail and alerts

Every booking change (created, edited, approved, rejected, cancelled, completed) is saved in
`FleetDeskBookingEvents` and published to SNS, which fans it out to the `trip-booking-events` SQS queue
(where Ziad's Trip service would read it). Denied requests (401/403), rate limits and Fleet failures are
counted too; when they spike, an alert goes to the `fleetdesk-alerts` topic.

```powershell
npm run events                 # messages waiting in both queues (add -- --clear to remove them)
npm run db -- events           # the audit trail / event log
```

On the website: **History** on each booking shows its audit trail; admins see the **Monitoring** panel.
To get alerts in Discord: put `ALERT_WEBHOOK_URL=<your Discord webhook>` in `floci\.env` and run `npm run deploy`.

## Security tests

From `booking-service` (in this copy), with the Floci addresses from `npm run deploy`:

```powershell
$env:BOOKING_API_URL="http://<booking-id>.execute-api.localhost.floci.io:4566"
$env:FLEET_API_URL="http://<fleet-id>.execute-api.localhost.floci.io:4566"
$env:EMPLOYEE_EMAIL="sara@fleetdesk.test"; $env:EMPLOYEE_PASSWORD="Demo-Pass-2026"
$env:EMPLOYEE2_EMAIL="omar@fleetdesk.test"; $env:EMPLOYEE2_PASSWORD="Demo-Pass-2026"
$env:ADMIN_EMAIL="admin@fleetdesk.test"; $env:ADMIN_PASSWORD="Demo-Pass-2026"
npm install; npm run security-tests
```

## Useful commands

```powershell
npm run logs -- booking     # recent Lambda logs (or: fleet)
npm run deploy              # after changing code: rebuilds and updates the Lambdas (safe to repeat)
docker compose down         # stop Floci; everything deployed is wiped, so run deploy again next time
```

To see what is deployed, with the AWS CLI from Lab 7:

```powershell
aws --endpoint-url http://localhost:4566 lambda list-functions --query "Functions[].FunctionName"
aws --endpoint-url http://localhost:4566 dynamodb scan --table-name FleetDeskBookings
aws --endpoint-url http://localhost:4566 rds describe-db-instances --query "DBInstances[].[DBInstanceIdentifier,Endpoint.Port]"
aws --endpoint-url http://localhost:4566 apigatewayv2 get-apis --query "Items[].[Name,ApiId]"
aws --endpoint-url http://localhost:4566 s3 ls s3://fleetdesk-site
```

## Security, same as the real setup

- Each Lambda connects with its own **least-privilege** database role (`fleet_api`, `booking_api`): SELECT, INSERT, UPDATE only.
- One `JWT_SECRET` shared by both Lambdas, generated once into `.state.json` (never commit that file).
- Fleet and Booking call each other with **Lambda Invoke** inside Floci, not over the internet,
  and they still forward the user's own token, so each service applies its own role rules.

## If something goes wrong

| Message | Fix |
|---|---|
| `Cannot reach Floci at http://localhost:4566` | `docker compose up -d`, wait 20 seconds, try again |
| `port is already allocated` on `docker compose up` | another Floci (Lab 7) is running: stop it with `docker compose down` in that folder |
| Timed out waiting for `Postgres on port 70xx` | Docker is still downloading `postgres:16-alpine`; run `npm run deploy` again |
| The site loads but login says `Cannot reach the server` | first Lambda call starts a container: wait 30 s and retry; then check `npm run logs -- fleet` |
| Booking says `Could not check the car with the Fleet service` | check `npm run logs -- booking`: Lambda containers must reach `http://floci:4566` (the compose file sets this up) |
