export class HttpError extends Error {
  constructor(status, message, extra = undefined) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const badRequest = (msg, extra) => new HttpError(400, msg, extra);
export const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`);
export const forbidden = (msg = 'You do not have permission to do that') => new HttpError(403, msg);

/** A 409 the client may override by resending the request with `force: true`. */
export const needsConfirmation = (message, code, details = {}) =>
  new HttpError(409, message, { code, requires_confirmation: true, ...details });

export function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

export function requireFields(body, fields) {
  const missing = fields.filter((f) => body?.[f] === undefined || body?.[f] === null || body?.[f] === '');
  if (missing.length) throw badRequest(`Missing required field(s): ${missing.join(', ')}`);
}

export const toInt = (v) => (v === undefined || v === null || v === '' ? null : Number.parseInt(v, 10));
export const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isTime = (t) => typeof t === 'string' && TIME_RE.test(t);
export const toMinutes = (t) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
export const toHHMM = (mins) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
export const overlaps = (aStart, aEnd, bStart, bEnd) =>
  toMinutes(aStart) < toMinutes(bEnd) && toMinutes(aEnd) > toMinutes(bStart);

export const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const DAY_SHORT = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Current date/time in a university's timezone: { date: 'YYYY-MM-DD', dow: 1..7, minutes }. */
export function zonedNow(timeZone = 'UTC', at = new Date()) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    }).formatToParts(at);
  } catch {
    return zonedNow('UTC', at);
  }
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const dow = DAY_SHORT.indexOf(get('weekday'));
  const hour = Number(get('hour')) % 24;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    dow,
    minutes: hour * 60 + Number(get('minute')),
  };
}

/** ISO weekday (Mon=1..Sun=7) of a YYYY-MM-DD date string. */
export function dowOf(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const slugify = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
