-- FleetDesk: tables owned by the Booking service (Youssef).
-- Run once in the Neon SQL Editor of the Booking database, using the owner role.
-- Users and cars live in the Fleet service. We keep their ids and a copy of the name / plate,
-- so the booking history still reads correctly if a car is later retired or renamed.

CREATE TABLE IF NOT EXISTS bookings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL,
  user_name           TEXT NOT NULL,
  vehicle_id          UUID NOT NULL,
  vehicle_plate       TEXT NOT NULL,
  vehicle_label       TEXT NOT NULL,
  purpose             TEXT NOT NULL,
  destination         TEXT NOT NULL,
  passengers          INTEGER NOT NULL CHECK (passengers BETWEEN 1 AND 15),
  start_at            TIMESTAMPTZ NOT NULL,
  end_at              TIMESTAMPTZ NOT NULL,
  status              TEXT NOT NULL DEFAULT 'Pending'
                      CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Cancelled', 'Completed')),
  estimated_km        NUMERIC(7, 1),
  estimated_minutes   INTEGER,
  decided_by          UUID,
  decided_by_name     TEXT,
  decision_reason     TEXT,
  decided_at          TIMESTAMPTZ,
  cancelled_by        UUID,
  cancel_reason       TEXT,
  cancelled_at        TIMESTAMPTZ,
  actual_km           NUMERIC(8, 1),
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_at > start_at)
);
CREATE INDEX IF NOT EXISTS bookings_vehicle_idx ON bookings (vehicle_id, start_at);
CREATE INDEX IF NOT EXISTS bookings_user_idx ON bookings (user_id, start_at);
CREATE INDEX IF NOT EXISTS bookings_status_idx ON bookings (status, created_at);

-- Audit trail and event log (who changed what, when), also used for monitoring and alerts.
-- Booking events: booking.created, booking.updated, booking.approved, booking.rejected, booking.cancelled, booking.completed
-- Security events: security.unauthenticated, security.forbidden, security.rate_limited, fleet.unavailable, alert.sent
-- Rows are only ever added (and their delivery status updated): the history cannot be edited through the API.
CREATE TABLE IF NOT EXISTS booking_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          TEXT NOT NULL,
  booking_id    UUID,
  actor_id      UUID,
  actor_role    TEXT,
  from_status   TEXT,
  to_status     TEXT,
  details       TEXT NOT NULL DEFAULT '{}',
  delivery      TEXT NOT NULL DEFAULT 'none' CHECK (delivery IN ('none', 'sent', 'failed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_events_booking_idx ON booking_events (booking_id, created_at);
CREATE INDEX IF NOT EXISTS booking_events_type_idx ON booking_events (type, created_at);

-- @neon-only (the in-memory test database cannot run the lines below)
-- The database itself refuses two APPROVED bookings of the same car whose times overlap,
-- even if two admins click Approve at the same moment (threat: double booking).
CREATE EXTENSION IF NOT EXISTS btree_gist;
DO $$ BEGIN
  ALTER TABLE bookings ADD CONSTRAINT no_double_approved_booking
    EXCLUDE USING gist (vehicle_id WITH =, tstzrange(start_at, end_at) WITH &&)
    WHERE (status = 'Approved');
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;  -- already added on an earlier run
END $$;

-- Least privilege (section 6.2): the API connects with this role, not the owner.
-- Run these lines once as the owner, after choosing a strong password:
--   CREATE ROLE booking_api LOGIN PASSWORD 'choose-a-long-random-password';
--   GRANT SELECT, INSERT, UPDATE ON bookings TO booking_api;
--   GRANT SELECT, INSERT, UPDATE (delivery) ON booking_events TO booking_api;
-- The API never deletes bookings (cancelling keeps the record), so it gets no DELETE.
-- On booking_events it can only change the "delivery" column, so the audit trail cannot be rewritten.
-- Then build DATABASE_URL with booking_api instead of the owner user.
