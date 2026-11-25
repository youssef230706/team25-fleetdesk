// Bookings page (Youssef). Talks only to the Booking API (BOOKING_API_URL);
// the Booking API asks the Fleet API which cars are free.
// Every text from the server goes through el() / textContent, never innerHTML.

const user = requireLogin();
const isAdmin = Session.isAdmin();
const booking = (path, options = {}) => api(path, { ...options, base: BOOKING_API_URL });

let search = null;        // the period and passengers of the last search
let chosenCar = null;     // the car picked from the results

// ---------- pictures: car side views and Egyptian number plates ----------
// Built with createElementNS (no innerHTML), so the CSP and the XSS rule still hold.

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(viewBox, parts) {
  const root = document.createElementNS(SVG_NS, 'svg');
  root.setAttribute('viewBox', viewBox);
  root.setAttribute('aria-hidden', 'true');
  parts.forEach(([tag, attrs]) => {
    const node = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
    root.append(node);
  });
  return root;
}

// One side view per car type in the Fleet service (Sedan, Hatchback, SUV, Van, Pickup).
const CAR_SHAPES = {
  sedan: {
    body: 'M7 40l3-9.6C12 25 15.4 22.6 21 22l22-1.6L54 11.6C57 9 60 8 64 8h17c4 0 7 1.4 9.4 4l8.6 9.6 9 1.6c4.4.8 6 3.6 6 7.6V40z',
    glass: 'M47.6 20.2l8.6-7c2-1.6 4-2.4 7-2.4h6.8v9.4zM73.6 10.8H81c3 0 5.2 1 7 3l6 6.4H73.6z'
  },
  hatchback: {
    body: 'M8 40l1-12c.4-4 2.6-7 6-8.4L26 11c2.6-2.2 5.6-3.2 9-3.2h36c4 0 7 1.4 9.4 4l8.6 9.6 11 2c4 .8 6 3.6 6 7.6V40z',
    glass: 'M30 19.6l6-7c1.6-1.6 3.4-2.2 6-2.2h14v9.2zM60 10.4h11c3 0 5.2 1 7 3l6 6.2H60z'
  },
  suv: {
    body: 'M7 40l1.6-12.5C9.4 22 12 19.5 18 19l17-1.4 7.6-9.4C44.4 6 47 5 51 5h40c4 0 6.6 1.4 8.6 4.4L106 19c5.6 1.4 8 4.6 8 9.6V40z',
    glass: 'M41 17.5l6.6-8C49 8 50.6 7.6 53 7.6h15.5v10zM72 7.6h18c2.6 0 4.4 1 5.6 3l4.6 7H72z'
  },
  van: {
    body: 'M6 40V15c0-5 3-8 8-8h68c4 0 7 1.6 9.6 4.4L104 24c6 1.4 10 4.6 10 10v6z',
    glass: 'M68 11h13c2.6 0 4.6 1 6.4 3L96 23H68zM14 13h22v9H14zM42 13h20v9H42z'
  },
  pickup: {
    body: 'M6 40V24h56V12c0-3 2-5 5-5h17c3 0 5 1.2 6.6 3.6L98 22l10 2.2c4 .9 6 3.4 6 7.4V40z',
    glass: 'M67 10h14c2 0 3.4.6 4.6 2.2L92 21H67z'
  }
};

function carPicture(type) {
  const shape = CAR_SHAPES[(type || '').toLowerCase()] || CAR_SHAPES.sedan;
  return svg('0 0 120 56', [
    ['ellipse', { cx: '60', cy: '50', rx: '52', ry: '3', fill: 'currentColor', opacity: '0.12' }],
    ['path', { d: shape.body, fill: 'currentColor' }],
    ['path', { d: shape.glass, fill: '#ffffff', opacity: '0.85' }],
    ['rect', { x: '6', y: '33', width: '108', height: '2.2', fill: '#ffffff', opacity: '0.25' }],
    ['circle', { cx: '30', cy: '41', r: '8.5', fill: '#1c2c4c' }],
    ['circle', { cx: '30', cy: '41', r: '3.6', fill: '#dfe6f1' }],
    ['circle', { cx: '91', cy: '41', r: '8.5', fill: '#1c2c4c' }],
    ['circle', { cx: '91', cy: '41', r: '3.6', fill: '#dfe6f1' }]
  ]);
}

// Egyptian-style plate: blue band with EGYPT / مصر on top, the plate number below.
function plate(number, small = false) {
  const box = el('span', null, small ? 'plate small-plate' : 'plate');
  box.title = `Plate ${number}`;
  const band = el('span', null, 'plate-band');
  band.append(el('span', 'EGYPT'), el('span', 'مصر'));
  box.append(band, el('span', number || '-', 'plate-number'));
  return box;
}

// Plate + car name, used in the two tables.
function carCell(b) {
  const cell = el('td', null, 'car-cell');
  cell.append(plate(b.vehiclePlate, true), el('span', b.vehicleLabel, 'car-label'));
  return cell;
}

function setStep(n) {
  [1, 2, 3].forEach((i) => {
    const step = document.getElementById(`step-${i}`);
    step.classList.toggle('is-active', i === n);
    step.classList.toggle('is-done', i < n);
  });
}

// ---------- small helpers ----------

// Date -> the value a datetime-local input expects (local time, no seconds)
function toInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function periodText(b) {
  const start = new Date(b.startAt);
  const end = new Date(b.endAt);
  const sameDay = start.toDateString() === end.toDateString();
  const endText = sameDay ? end.toLocaleTimeString('en-GB', { timeStyle: 'short' }) : formatDate(b.endAt);
  return `${formatDate(b.startAt)} to ${endText}`;
}

function estimateText(estimate) {
  if (!estimate) return 'No estimate';
  return `${estimate.distanceKm} km, about ${estimate.durationMinutes} min`;
}

function tripCell(b) {
  const cell = el('td');
  cell.append(el('span', b.purpose, 'trip-purpose'), el('span', `To ${b.destination} · ${b.passengers} passenger(s)`, 'trip-destination'));
  return cell;
}

function setBusy(button, busy, text) {
  button.disabled = busy;
  if (text) button.textContent = text;
}

// ---------- 1. search ----------

function setDefaultDates() {
  const start = new Date();
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() + 2);
  const end = new Date(start.getTime() + 3 * 60 * 60 * 1000);
  document.getElementById('from').value = toInputValue(start);
  document.getElementById('to').value = toInputValue(end);
  document.getElementById('from').min = toInputValue(new Date());
}

function clearResults() {
  search = null;
  chooseCar(null);
  setStep(1);
  document.getElementById('car-results').replaceChildren();
}

async function findCars(event) {
  if (event) event.preventDefault();
  const fromValue = document.getElementById('from').value;
  const toValue = document.getElementById('to').value;
  const seats = Number(document.getElementById('seats').value);
  if (!fromValue || !toValue) return showMessage('page-message', 'Choose both a start and an end time.');
  if (new Date(toValue) <= new Date(fromValue)) return showMessage('page-message', 'The end time must be after the start time.');
  if (!Number.isInteger(seats) || seats < 1 || seats > 15) return showMessage('page-message', 'Passengers must be between 1 and 15.');

  const button = document.getElementById('search-button');
  setBusy(button, true, 'Searching...');
  showMessage('page-message', '');
  try {
    const query = new URLSearchParams({ from: toIso(fromValue), to: toIso(toValue), seats: String(seats) });
    const result = await booking(`/api/bookings/availability?${query}`);
    search = { startAt: toIso(fromValue), endAt: toIso(toValue), passengers: seats };
    showCars(result.cars);
  } catch (error) {
    clearResults();
    showMessage('page-message', error.message);
  } finally {
    setBusy(button, false, 'Find free cars');
  }
}

function showCars(cars) {
  const box = document.getElementById('car-results');
  box.replaceChildren();
  chooseCar(null);
  if (cars.length === 0) {
    setStep(1);
    box.append(el('p', 'No car is free for that whole period. Try other times or fewer passengers.', 'muted'));
    return;
  }
  setStep(2);
  box.append(el('p', `${cars.length} car(s) free for ${periodText(search)}.`, 'muted small results-note'));
  cars.forEach((car) => {
    const card = el('article', null, 'car-card');
    card.dataset.id = car.id;
    const visual = el('div', null, 'car-visual');
    visual.append(carPicture(car.type));
    const tags = el('div', null, 'car-tags');
    tags.append(el('span', car.type, 'tag'), el('span', `${car.seats} seats`, 'tag'), el('span', String(car.year), 'tag'));
    const pick = el('button', 'Choose this car');
    pick.type = 'button';
    pick.addEventListener('click', () => chooseCar(car));
    const body = el('div', null, 'car-body');
    body.append(el('h3', `${car.make} ${car.model}`), plate(car.plateNumber), tags, pick);
    card.append(visual, body);
    box.append(card);
  });
}

// ---------- 2. trip details and request ----------

function chooseCar(car) {
  chosenCar = car;
  document.querySelectorAll('.car-card').forEach((node) => {
    node.classList.toggle('selected', Boolean(car) && node.dataset.id === car.id);
  });
  const card = document.getElementById('details-card');
  card.hidden = !car;
  if (!car) {
    if (search) setStep(2);
    return;
  }
  setStep(3);
  const text = el('div', null, 'chosen-text');
  text.append(el('strong', `${car.make} ${car.model}`), el('span', `${periodText(search)} · ${search.passengers} passenger(s)`, 'muted small'));
  document.getElementById('chosen-car').replaceChildren(carPicture(car.type), text, plate(car.plateNumber));
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById('purpose').focus({ preventScroll: true });
}

async function estimateTrip() {
  const destination = document.getElementById('destination').value.trim();
  const out = document.getElementById('estimate-result');
  if (destination.length < 3) {
    out.textContent = 'Type the destination first (at least 3 letters).';
    return;
  }
  const button = document.getElementById('estimate-button');
  setBusy(button, true, 'Estimating...');
  try {
    const estimate = await booking(`/api/bookings/estimate?${new URLSearchParams({ destination })}`);
    out.textContent = `${estimate.destinationLabel}: ${estimateText(estimate)} by car from the company (OpenRouteService).`;
  } catch (error) {
    out.textContent = `${error.message} You can still send the request.`;
  } finally {
    setBusy(button, false, 'Estimate trip');
  }
}

async function requestBooking(event) {
  event.preventDefault();
  if (!chosenCar || !search) return showMessage('page-message', 'Search and choose a car first.');
  const purpose = document.getElementById('purpose').value.trim();
  const destination = document.getElementById('destination').value.trim();
  if (purpose.length < 5) return showMessage('page-message', 'Write the purpose of the trip (at least 5 letters).');
  if (destination.length < 3) return showMessage('page-message', 'Write the destination (at least 3 letters).');

  const button = document.getElementById('request-button');
  setBusy(button, true, 'Sending...');
  try {
    const created = await booking('/api/bookings', {
      method: 'POST',
      body: { vehicleId: chosenCar.id, startAt: search.startAt, endAt: search.endAt, purpose, destination, passengers: search.passengers }
    });
    showMessage('page-message', `Request sent for ${created.vehiclePlate}. A fleet admin will approve or reject it.`, 'success');
    document.getElementById('booking-form').reset();
    document.getElementById('estimate-result').textContent = '';
    clearResults();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    refreshLists();
  } catch (error) {
    showMessage('page-message', error.message);
    // The car may have been taken in the meantime: show the fresh list.
    if (/booked|available|maintenance/i.test(error.message)) findCars();
  } finally {
    setBusy(button, false, 'Send booking request');
  }
}

// ---------- my bookings / all bookings ----------

function noteFor(b) {
  if (b.status === 'Approved') return b.decidedBy ? `Approved by ${b.decidedBy}` : '';
  if (b.status === 'Rejected') return b.decisionReason || '';
  if (b.status === 'Cancelled') return b.cancelReason || 'Cancelled';
  if (b.status === 'Completed') return b.actualKm === null ? 'Returned' : `Actual: ${b.actualKm} km`;
  return 'Waiting for a fleet admin';
}

function canCancel(b) {
  if (b.status === 'Pending') return true;
  return b.status === 'Approved' && new Date(b.startAt) > new Date();
}

async function changeStatus(b, body, successText) {
  try {
    await booking(`/api/bookings/${b.id}/status`, { method: 'PATCH', body });
    showMessage('page-message', successText, 'success');
  } catch (error) {
    showMessage('page-message', error.message);
  }
  refreshLists();
  if (search) findCars();
}

// ---------- row actions: edit, history, cancel ----------

const EVENT_LABELS = {
  'booking.created': 'Requested',
  'booking.updated': 'Edited',
  'booking.approved': 'Approved',
  'booking.rejected': 'Rejected',
  'booking.cancelled': 'Cancelled',
  'booking.completed': 'Completed (car returned)'
};
const FIELD_NAMES = { purpose: 'purpose', destination: 'destination', passengers: 'passengers', startAt: 'start time', endAt: 'end time' };

function whoDid(e) {
  if (e.byMe) return 'you';
  return e.actorRole === 'FleetAdmin' ? 'a fleet admin' : 'the employee';
}

function historyLine(e) {
  let text = `${EVENT_LABELS[e.type] || e.type} by ${whoDid(e)}`;
  if (e.type === 'booking.updated' && e.details.changed) text += `: ${e.details.changed.map((f) => FIELD_NAMES[f] || f).join(', ')}`;
  if (e.details.reason) text += `. Reason: ${e.details.reason}`;
  if (e.details.actualKm !== undefined) text += `. Actual distance: ${e.details.actualKm} km`;
  return text;
}

async function toggleHistory(b, row, button) {
  const next = row.nextElementSibling;
  if (next && next.classList.contains('history-row')) {
    next.remove();
    button.textContent = 'History';
    return;
  }
  button.disabled = true;
  try {
    const events = await booking(`/api/bookings/${b.id}/history`);
    const cell = el('td', null, 'history-cell');
    cell.colSpan = row.children.length;
    const list = el('ol', null, 'timeline');
    if (events.length === 0) list.append(el('li', 'No history recorded for this booking.', 'muted'));
    events.forEach((e) => {
      const item = el('li', null, `timeline-item ${e.type.split('.')[1]}`);
      item.append(el('time', formatDate(e.at), 'muted small'), el('span', historyLine(e)));
      list.append(item);
    });
    cell.append(el('strong', 'History (audit trail)'), list);
    const historyRow = el('tr', null, 'history-row');
    historyRow.append(cell);
    row.after(historyRow);
    button.textContent = 'Hide history';
  } catch (error) {
    showMessage('page-message', error.message);
  } finally {
    button.disabled = false;
  }
}

function smallButton(text, className, onClick) {
  const button = el('button', text, `small ${className}`.trim());
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

// Cancel needs a second click; an admin cancelling someone else's booking must give a reason.
function actionsCell(b, row) {
  const td = el('td');
  const cell = el('div', null, 'row-actions');
  td.append(cell);
  const ownBooking = b.userId === user.id;

  function showDefault() {
    const buttons = [];
    if (ownBooking && b.status === 'Pending') buttons.push(smallButton('Edit', 'secondary', () => startEdit(b)));
    const history = smallButton('History', 'secondary', () => toggleHistory(b, row, history));
    buttons.push(history);
    if (canCancel(b) && (ownBooking || isAdmin)) buttons.push(smallButton('Cancel', 'danger', askCancel));
    cell.replaceChildren(...buttons);
  }

  function askCancel() {
    const reason = ownBooking ? null : el('input');
    if (reason) { reason.placeholder = 'Reason (needed)'; reason.maxLength = 300; }
    const confirm = smallButton('Yes, cancel', 'danger', () => {
      const text = reason ? reason.value.trim() : '';
      if (reason && text.length < 3) return showMessage('page-message', 'Give a reason when cancelling someone else\'s booking.');
      return changeStatus(b, text ? { status: 'Cancelled', reason: text } : { status: 'Cancelled' }, 'Booking cancelled.');
    });
    const keep = smallButton('Keep', 'secondary', showDefault);
    cell.replaceChildren(...(reason ? [reason] : []), confirm, keep);
    if (reason) reason.focus();
  }

  showDefault();
  return td;
}

// ---------- edit / reschedule (owner, while Pending) ----------

let editing = null;

function startEdit(b) {
  editing = b;
  document.getElementById('edit-plate').replaceChildren(plate(b.vehiclePlate, true));
  document.getElementById('edit-from').value = toInputValue(new Date(b.startAt));
  document.getElementById('edit-to').value = toInputValue(new Date(b.endAt));
  document.getElementById('edit-seats').value = b.passengers;
  document.getElementById('edit-purpose').value = b.purpose;
  document.getElementById('edit-destination').value = b.destination;
  const card = document.getElementById('edit-card');
  card.hidden = false;
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById('edit-purpose').focus({ preventScroll: true });
}

function stopEdit() {
  editing = null;
  document.getElementById('edit-card').hidden = true;
}

async function saveEdit(event) {
  event.preventDefault();
  if (!editing) return;
  const b = editing;
  const startAt = toIso(document.getElementById('edit-from').value);
  const endAt = toIso(document.getElementById('edit-to').value);
  const passengers = Number(document.getElementById('edit-seats').value);
  const purpose = document.getElementById('edit-purpose').value.trim();
  const destination = document.getElementById('edit-destination').value.trim();

  if (!startAt || !endAt) return showMessage('page-message', 'Choose both a start and an end time.');
  if (new Date(endAt) <= new Date(startAt)) return showMessage('page-message', 'The end time must be after the start time.');
  if (!Number.isInteger(passengers) || passengers < 1 || passengers > 15) return showMessage('page-message', 'Passengers must be between 1 and 15.');
  if (purpose.length < 5) return showMessage('page-message', 'Write the purpose of the trip (at least 5 letters).');
  if (destination.length < 3) return showMessage('page-message', 'Write the destination (at least 3 letters).');

  // Send only what changed, so the server re-checks only what it has to.
  const body = {};
  if (startAt !== new Date(b.startAt).toISOString() || endAt !== new Date(b.endAt).toISOString()) {
    body.startAt = startAt;
    body.endAt = endAt;
  }
  if (passengers !== b.passengers) body.passengers = passengers;
  if (purpose !== b.purpose) body.purpose = purpose;
  if (destination !== b.destination) body.destination = destination;
  if (Object.keys(body).length === 0) return showMessage('page-message', 'Nothing was changed.');

  const button = document.getElementById('edit-save');
  setBusy(button, true, 'Saving...');
  try {
    await booking(`/api/bookings/${b.id}`, { method: 'PATCH', body });
    showMessage('page-message', `Booking of ${b.vehiclePlate} updated.`, 'success');
    stopEdit();
    refreshLists();
  } catch (error) {
    showMessage('page-message', error.message);
  } finally {
    setBusy(button, false, 'Save changes');
  }
}

async function loadBookings() {
  const status = document.getElementById('filter-status').value;
  const mine = isAdmin && document.getElementById('filter-mine').checked;
  const query = new URLSearchParams();
  if (status) query.set('status', status);
  if (mine) query.set('mine', 'true');

  const rows = document.getElementById('booking-rows');
  try {
    const list = await booking(`/api/bookings${query.toString() ? `?${query}` : ''}`);
    rows.replaceChildren();
    document.getElementById('empty').hidden = list.length > 0;
    list.forEach((b) => {
      const row = el('tr');
      row.append(carCell(b));
      if (isAdmin) row.append(el('td', b.userId === user.id ? `${b.userName} (you)` : b.userName));
      row.append(
        el('td', periodText(b), 'when'),
        tripCell(b),
        el('td', estimateText(b.estimate), 'small'),
        el('td', b.status, `badge ${b.status.toLowerCase()}`),
        el('td', noteFor(b), 'small')
      );
      row.append(actionsCell(b, row));
      rows.append(row);
    });
  } catch (error) {
    showMessage('page-message', error.message);
  }
}

// ---------- approval queue (Fleet Admin) ----------

async function loadQueue() {
  if (!isAdmin) return;
  const rows = document.getElementById('queue-rows');
  try {
    const pending = await booking('/api/bookings?status=Pending');
    rows.replaceChildren();
    const count = document.getElementById('queue-count');
    count.textContent = pending.length;
    count.classList.toggle('has-items', pending.length > 0);
    document.getElementById('queue-empty').hidden = pending.length > 0;

    pending.forEach((b) => {
      const decision = el('td', null, 'decision');
      if (b.userId === user.id) {
        decision.append(el('span', 'Your own request: another admin decides.', 'muted small'));
      } else {
        const reason = el('input');
        reason.placeholder = 'Reason (needed to reject)';
        reason.maxLength = 300;
        const approve = el('button', 'Approve', 'small');
        const reject = el('button', 'Reject', 'small danger');
        approve.type = 'button';
        reject.type = 'button';
        approve.addEventListener('click', () => {
          const text = reason.value.trim();
          changeStatus(b, text ? { status: 'Approved', reason: text } : { status: 'Approved' }, `Approved ${b.userName}'s booking of ${b.vehiclePlate}.`);
        });
        reject.addEventListener('click', () => {
          const text = reason.value.trim();
          if (text.length < 3) {
            showMessage('page-message', 'Write a reason before rejecting, so the employee knows why.');
            reason.focus();
            return;
          }
          changeStatus(b, { status: 'Rejected', reason: text }, `Rejected ${b.userName}'s booking.`);
        });
        const buttons = el('div', null, 'buttons');
        buttons.append(approve, reject);
        decision.append(reason, buttons);
      }
      const row = el('tr');
      row.append(
        el('td', b.userName),
        carCell(b),
        el('td', periodText(b), 'when'),
        tripCell(b),
        el('td', estimateText(b.estimate), 'small'),
        decision
      );
      rows.append(row);
    });
  } catch (error) {
    showMessage('page-message', error.message);
  }
}

// ---------- monitoring (Fleet Admin) ----------

const SECURITY_LABELS = {
  'security.unauthenticated': 'Not logged in (401)',
  'security.forbidden': 'Not allowed (403)',
  'security.rate_limited': 'Too many requests (429)',
  'fleet.unavailable': 'Fleet service down (503)'
};

function metricCard(label, value, warn) {
  const card = el('div', null, `metric${warn && value > 0 ? ' metric-warn' : ''}`);
  card.append(el('span', String(value), 'metric-value'), el('span', label, 'metric-label'));
  return card;
}

async function loadMonitor() {
  if (!isAdmin) return;
  try {
    const m = await booking('/api/bookings/metrics');
    const d = m.last24h;
    document.getElementById('metric-cards').replaceChildren(
      metricCard('Waiting for approval', m.bookingsByStatus.Pending),
      metricCard('Approved bookings', m.bookingsByStatus.Approved),
      metricCard('New requests (24 h)', d.created),
      metricCard('Denied 401/403 (24 h)', d.unauthenticated + d.forbidden, true),
      metricCard('Rate limited (24 h)', d.rateLimited, true),
      metricCard('Fleet failures (24 h)', d.fleetUnavailable, true),
      metricCard('Event delivery failures (24 h)', d.eventDeliveryFailures, true)
    );

    document.getElementById('alert-rules').replaceChildren(...m.alerting.rules.map((rule) => {
      const line = el('div', null, `alert-rule${rule.current >= rule.threshold ? ' firing' : ''}`);
      const bar = document.createElement('progress');
      bar.max = rule.threshold;
      bar.value = Math.min(rule.current, rule.threshold);
      line.append(el('span', `${rule.title}: ${rule.current} / ${rule.threshold}`), bar);
      return line;
    }));
    const ch = m.alerting.channels;
    const channels = [ch.webhook ? 'Discord/Teams webhook' : null, ch.sns ? 'SNS alerts topic' : null].filter(Boolean);
    document.getElementById('alert-channels').textContent = channels.length
      ? `Alerts are sent to: ${channels.join(' and ')}. At most one alert per rule every ${m.alerting.windowMinutes} minutes.`
      : 'No alert channel is set up (ALERT_WEBHOOK_URL). Alerts are still recorded here.';
    document.getElementById('recent-alerts').replaceChildren(...m.alerting.recentAlerts.map((a) =>
      el('li', `${formatDate(a.at)}: alert "${a.rule}" (${a.count} events), ${a.delivered === 'sent' ? 'delivered' : a.delivered === 'none' ? 'recorded only' : 'delivery failed'}`)));

    const rows = document.getElementById('security-rows');
    rows.replaceChildren(...m.recentSecurityEvents.map((e) => {
      const row = el('tr');
      row.append(
        el('td', formatDate(e.at), 'when'),
        el('td', SECURITY_LABELS[e.type] || e.type, `badge ${e.type === 'fleet.unavailable' ? 'rejected' : 'pending'}`),
        el('td', e.actorRole ? (e.actorRole === 'FleetAdmin' ? 'Fleet Admin' : 'Employee') : 'anonymous'),
        el('td', `${e.method} ${e.path}`, 'small mono')
      );
      return row;
    }));
    document.getElementById('security-empty').hidden = m.recentSecurityEvents.length > 0;
  } catch (error) {
    showMessage('page-message', error.message);
  }
}

function refreshLists() {
  loadQueue();
  loadBookings();
  loadMonitor();
}

// ---------- start ----------

if (user) {
  if (isAdmin) {
    document.getElementById('list-title').textContent = 'All bookings';
    const head = document.getElementById('list-head');
    head.insertBefore(el('th', 'Booked by'), head.children[1]);
  }
  setDefaultDates();
  document.getElementById('search-form').addEventListener('submit', findCars);
  ['from', 'to', 'seats'].forEach((id) => document.getElementById(id).addEventListener('input', clearResults));
  document.getElementById('booking-form').addEventListener('submit', requestBooking);
  document.getElementById('estimate-button').addEventListener('click', estimateTrip);
  document.getElementById('change-car').addEventListener('click', () => {
    chooseCar(null);
    document.getElementById('car-results').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  document.getElementById('filter-status').addEventListener('change', loadBookings);
  document.getElementById('filter-mine').addEventListener('change', loadBookings);
  document.getElementById('edit-form').addEventListener('submit', saveEdit);
  document.getElementById('edit-cancel').addEventListener('click', stopEdit);
  document.getElementById('refresh-monitor').addEventListener('click', loadMonitor);
  refreshLists();
}
