/**
 * Wedding RSVP backend — Google Apps Script
 *
 * The RSVP page (rsvp.html) calls this script to
 *   1. check a guest's email against the "Guests" sheet, and
 *   2. save their answers into the "Responses" sheet.
 *
 * What the browser can learn from it
 *   - A lookup returns only the party name, the guest names and a yes/no
 *     "responded" flag. Saved answers, notes, dietary details and license
 *     plates are never sent back.
 *   - Repeated misses are throttled (see THROTTLE below), so the guest list
 *     can't be probed by trying email after email.
 *
 * ── SET-UP ───────────────────────────────────────────────────────────────
 * 1. Create a Google Sheet with a tab named exactly:  Guests
 *    Row 1 headers, then one row per invitation:
 *
 *      Email                         | Party Name   | Guests
 *      priya@example.com             | Priya & Raj  | Priya Sharma, Raj Sharma
 *      sam@example.com, jo@mail.com  | Sam & Jo     | Sam Lee, Jo Lee
 *      alex@example.com              | Alex         | Alex Kim
 *
 *    - Email:      one or more addresses (separated by commas) that can log in for this invitation
 *    - Party Name: shown as "Welcome, …" — keep each one unique
 *    - Guests:     the named guests on the invitation, separated by commas
 *                  (leave blank to use the Party Name as a single guest)
 *
 * 2. In the sheet: Extensions → Apps Script. Replace the code with this file.
 * 3. Deploy → New deployment → gear icon → "Web app"
 *      Execute as:      Me
 *      Who has access:  Anyone
 *    Authorize when asked, then copy the Web app URL (ends in /exec).
 * 4. Paste that URL into CONFIG.appsScriptUrl near the bottom of rsvp.html.
 *
 * After editing this code later: Deploy → Manage deployments → edit (pencil) →
 * Version: "New version" → Deploy. (The URL stays the same.)
 *
 * A "Responses" tab is created automatically. There is one row per guest, and
 * a guest who edits their RSVP replaces their party's earlier rows.
 */

const GUESTS_SHEET = 'Guests';
const RESPONSES_SHEET = 'Responses';
const RESPONSE_HEADERS = [
  'Timestamp', 'Party', 'Email used', 'Guest', 'Attending',
  'Dietary restrictions', 'License plate', 'Taxi needed', 'Message',
];
const MAX_TEXT_LENGTH = 500;

/**
 * Throttling — adjust these numbers to taste.
 *
 * Apps Script can't see a visitor's IP address, so limits are counted for the
 * whole site rather than per person:
 *
 *   failedLookups   Emails that were NOT on the guest list. Once any window
 *                   below is full, every lookup and save is refused until
 *                   that window ends. Real guests rarely mistype more than a
 *                   couple of times, so these leave plenty of room, while
 *                   still making it impractical to guess addresses in bulk.
 *   submitsPerParty Saves allowed per invitation, so one invitation can't
 *                   flood the Responses tab.
 *
 * Counters live in CacheService, which is best-effort: entries can expire
 * early, and a counter that can't be read never blocks a real guest.
 */
const THROTTLE = {
  failedLookups: [
    { windowSeconds: 10 * 60,      max: 20 },   // 20 misses per 10 minutes
    { windowSeconds: 6 * 60 * 60,  max: 100 },  // 100 misses per 6 hours
  ],
  submitsPerParty: { windowSeconds: 60 * 60, max: 10 },
};
const CACHE_MAX_SECONDS = 21600; // CacheService's upper limit (6 hours)

/** Look up an invitation: GET ?action=lookup&email=… */
function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    if (params.action !== 'lookup') return jsonResponse_({ ok: false, error: 'unknown_action' });

    const wait = lockoutSeconds_();
    if (wait > 0) return rateLimitedResponse_(wait);

    const party = findParty_(params.email);
    if (!party) {
      withLock_(recordFailedLookup_);
      return jsonResponse_({ ok: true, found: false });
    }

    return jsonResponse_({
      ok: true,
      found: true,
      party: party.name,
      guests: party.guests,
      responded: hasResponse_(party), // just yes/no — never the saved answers
    });
  } catch (err) {
    console.error(err);
    return jsonResponse_({ ok: false, error: 'server_error' });
  }
}

/** Save an RSVP: POST { email, attending: { "Guest Name": "yes"|"no" }, dietary, plate, taxi, message } */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000); // avoid two submissions writing at the same moment

    const wait = lockoutSeconds_();
    if (wait > 0) return rateLimitedResponse_(wait);

    const data = JSON.parse(e.postData.contents);

    const party = findParty_(data.email);
    if (!party) {
      recordFailedLookup_(); // we already hold the lock here
      return jsonResponse_({ ok: false, error: 'not_found' });
    }

    const partyWait = submitLockoutSeconds_(party);
    if (partyWait > 0) return rateLimitedResponse_(partyWait);
    recordSubmit_(party);

    writeResponse_(party, normalizeEmail_(data.email), data);
    return jsonResponse_({ ok: true });
  } catch (err) {
    console.error(err);
    return jsonResponse_({ ok: false, error: err && err.message === 'incomplete' ? 'incomplete' : 'server_error' });
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

/* ───────────────────────────── Throttling ─────────────────────────────── */

/** Seconds until the next window opens (used for "try again in …"). */
function secondsLeftInWindow_(windowSeconds, now) {
  const windowMs = windowSeconds * 1000;
  return Math.ceil((windowMs - (now % windowMs)) / 1000);
}

/** Counters use fixed windows: the key changes each time a new window starts. */
function windowKey_(name, windowSeconds, now) {
  return name + ':' + windowSeconds + ':' + Math.floor(now / (windowSeconds * 1000));
}

function readCount_(key) {
  try {
    return Number(CacheService.getScriptCache().get(key)) || 0;
  } catch (err) {
    console.error(err);
    return 0; // fail open: never lock real guests out because the cache hiccuped
  }
}

function bumpCount_(key, windowSeconds) {
  try {
    CacheService.getScriptCache().put(key, String(readCount_(key) + 1), Math.min(windowSeconds * 2, CACHE_MAX_SECONDS));
  } catch (err) {
    console.error(err);
  }
}

/** 0 if lookups are allowed, otherwise how many seconds until they are. */
function lockoutSeconds_() {
  const now = Date.now();
  let wait = 0;
  THROTTLE.failedLookups.forEach(function (rule) {
    if (readCount_(windowKey_('miss', rule.windowSeconds, now)) >= rule.max) {
      wait = Math.max(wait, secondsLeftInWindow_(rule.windowSeconds, now));
    }
  });
  return wait;
}

function recordFailedLookup_() {
  const now = Date.now();
  THROTTLE.failedLookups.forEach(function (rule) {
    bumpCount_(windowKey_('miss', rule.windowSeconds, now), rule.windowSeconds);
  });
}

function submitKey_(party, now) {
  const rule = THROTTLE.submitsPerParty;
  return windowKey_('save:' + encodeURIComponent(party.name).slice(0, 120), rule.windowSeconds, now);
}

function submitLockoutSeconds_(party) {
  const rule = THROTTLE.submitsPerParty;
  const now = Date.now();
  return readCount_(submitKey_(party, now)) >= rule.max ? secondsLeftInWindow_(rule.windowSeconds, now) : 0;
}

function recordSubmit_(party) {
  bumpCount_(submitKey_(party, Date.now()), THROTTLE.submitsPerParty.windowSeconds);
}

/** Runs fn while holding the script lock, so two counters can't overwrite each other. */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    lock.waitLock(5000);
    locked = true;
  } catch (err) {
    // Couldn't get the lock in time — carry on; the counters are best-effort anyway.
  }
  try {
    return fn();
  } finally {
    if (locked) lock.releaseLock();
  }
}

function rateLimitedResponse_(retryAfterSeconds) {
  return jsonResponse_({ ok: false, error: 'rate_limited', retryAfterSeconds: retryAfterSeconds });
}

/* ───────────────────────────── Guests sheet ───────────────────────────── */

function findParty_(email) {
  const target = normalizeEmail_(email);
  if (!target) return null;

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GUESTS_SHEET);
  if (!sheet) throw new Error('Missing "' + GUESTS_SHEET + '" sheet');

  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) { // row 0 is the header
    const emailCell = rows[i][0];
    const partyCell = rows[i][1];
    const guestsCell = rows[i][2];

    const emails = String(emailCell).split(/[,;\s]+/).map(normalizeEmail_).filter(Boolean);
    if (emails.indexOf(target) === -1) continue;

    const name = String(partyCell).trim() || emails[0];
    let guests = String(guestsCell).split(/[,;\n]+/).map(function (g) { return g.trim(); }).filter(Boolean);
    if (guests.length === 0) guests = [name];
    return { name: name, guests: guests };
  }
  return null;
}

/* ──────────────────────────── Responses sheet ─────────────────────────── */

function getResponsesSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(RESPONSES_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(RESPONSES_SHEET);
    sheet.appendRow(RESPONSE_HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, RESPONSE_HEADERS.length).setFontWeight('bold');
  }
  return sheet;
}

/** True if this party has already saved an RSVP. */
function hasResponse_(party) {
  return getResponsesSheet_().getDataRange().getValues().slice(1)
    .some(function (row) { return row[1] === party.name; });
}

function writeResponse_(party, email, data) {
  const attending = data.attending || {};

  // Every guest on the invitation must have an answer.
  party.guests.forEach(function (guest) {
    if (attending[guest] !== 'yes' && attending[guest] !== 'no') throw new Error('incomplete');
  });

  const sheet = getResponsesSheet_();

  // Replace any earlier answers for this party.
  const existing = sheet.getDataRange().getValues();
  for (let i = existing.length - 1; i >= 1; i--) {
    if (existing[i][1] === party.name) sheet.deleteRow(i + 1);
  }

  const anyYes = party.guests.some(function (guest) { return attending[guest] === 'yes'; });
  const dietary = anyYes ? cleanText_(data.dietary) : '';
  const plate = anyYes ? cleanText_(data.plate) : '';
  const taxi = anyYes && data.taxi === true ? 'Yes' : 'No';
  const message = cleanText_(data.message);
  const now = new Date();

  const rows = party.guests.map(function (guest) {
    return [now, party.name, email, guest, attending[guest] === 'yes' ? 'Yes' : 'No', dietary, plate, taxi, message];
  });

  const target = sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, RESPONSE_HEADERS.length);
  // Columns D–I are stored as plain text so a guest can't inject a spreadsheet formula (e.g. "=IMPORTDATA(…)").
  sheet.getRange(target.getRow(), 4, rows.length, RESPONSE_HEADERS.length - 3).setNumberFormat('@');
  target.setValues(rows);
}

/* ────────────────────────────── helpers ───────────────────────────────── */

function normalizeEmail_(value) {
  return String(value || '').trim().toLowerCase();
}

function cleanText_(value) {
  return String(value || '').trim().slice(0, MAX_TEXT_LENGTH);
}

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
