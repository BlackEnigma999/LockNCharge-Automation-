/**
 * Chromebook Locker Automation (Lock N Charge API v1 + Google Admin + Google Sheets)
 * Bound to the tracking spreadsheet. See README.md for setup.
 *
 * How it works
 *  - Lock N Charge calls our web app (webhook) when a student scans into a bay (BAY_CREDS_CLEARED). That is a
 *    pickup, or a return if the SAME student scans a bay whose laptop they have out. Anyone else is ignored.
 *  - Bay states (verified against the portal): assigned=false & offline=false = green (laptop in);
 *    assigned=true = laptop OUT, assignedUserId = who has it; offline=true = black.
 *  - Every 5 min (and right before the overdue check) syncWithBays_ compares the sheet with those live states,
 *    so missed events and pre-automation checkouts get fixed.
 *  - ~4:30 PM weekdays: anything still out past 4:15 PM is DISABLED in Google Admin, its bay is set OFFLINE
 *    (CFG.OFFLINE_OVERDUE_BAYS = true), and the student is listed on the "Overdue" sheet.
 *  - Late laptops are put back by IT by hand: set the row's Overdue Status to "Returned (bin)" to re-enable the
 *    Chromebook and bring the bay online. (Set OFFLINE_OVERDUE_BAYS to false to let students return them by scan.)
 *
 * Bays are named after each Chromebook's asset tag (first word of the bay name), matched to Google Admin's Asset ID.
 */

const CFG = {
  TZ: 'America/Los_Angeles',   // Pacific (confirmed by webhook timestamps vs. sheet times)
  DUE_HOUR: 16, DUE_MIN: 15,   // 4:15 PM return deadline
  MIN_RETURN_MINUTES: 3,       // a door-close within this many minutes of checkout is NOT a return
  DRY_RUN: false,              // true = write to sheets/log only; no Admin or bay changes. Set false to go live.
  // false = an overdue bay stays ONLINE, so the student can scan in and return it themselves (fully automatic).
  // true  = the bay is also set offline (nobody can open it until IT restores it and sets "Returned (bin)").
  OFFLINE_OVERDUE_BAYS: true,
};
const SH = { CHECKOUTS: 'Checkouts', OVERDUE: 'Overdue', MAP: 'Bay Map', WH: 'Webhook Log', LOG: 'Log' };
// "User ID" = the student's ID number (the portal's PIN); "Station User" = Lock N Charge's internal key.
const CO_COLS = ['Bay ID', 'Bay Name', 'Asset Tag', 'User ID', 'Student', 'Station User', 'Checked Out', 'Returned', 'Status', 'Bay #', 'Station'];
// Columns A-G match the old "Sheet 1" so its rows can be pasted straight in. H onward are used by the script.
const OD_COLS = ['Name', 'Bay #', 'Asset Tag', 'Notes', 'AF NOTES', 'ATTEMPTS TO CONTACT', 'LINK TO PASS',
                 'Status', 'Returned At', 'Bay ID', 'Station', 'Student ID'];

/* ===================== Lock N Charge API ===================== */

function prop_(k) {
  const v = PropertiesService.getScriptProperties().getProperty(k);
  if (!v || !v.trim()) throw new Error('Missing Script Property: ' + k);
  return v.trim();   // pasted values often carry stray spaces/newlines
}

function lncToken_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('lnc_token');
  if (hit) return hit;
  const res = UrlFetchApp.fetch(prop_('LNC_BASE_URL') + '/v1/token', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ client_id: prop_('LNC_CLIENT_ID'), client_secret: prop_('LNC_CLIENT_SECRET') }),
  });
  if (res.getResponseCode() !== 201 && res.getResponseCode() !== 200) throw new Error('LNC token ' + res.getResponseCode() + ' ' + res.getContentText().substring(0, 200));
  const j = JSON.parse(res.getContentText());
  // "expires" unit isn't documented: accept epoch ms, epoch s, or a duration in seconds. Cap at 50 min to be safe.
  let ttl = j.expires > 1e12 ? (j.expires - Date.now()) / 1000 : j.expires > 1e9 ? j.expires - Date.now() / 1000 : j.expires;
  ttl = Math.max(30, Math.min(ttl - 60, 3000));
  cache.put('lnc_token', j.access_token, Math.floor(ttl));
  return j.access_token;
}

function lnc_(method, path, body) {
  const opt = { method: method, headers: { Authorization: 'Bearer ' + lncToken_() }, muteHttpExceptions: true };
  if (body) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
  const res = UrlFetchApp.fetch(prop_('LNC_BASE_URL') + path, opt);
  const code = res.getResponseCode();
  if (code >= 300) throw new Error('LNC ' + method + ' ' + path + ' -> ' + code + ' ' + res.getContentText());
  const t = res.getContentText();
  return t ? JSON.parse(t) : null;
}

const lncGetBay_ = id => lnc_('get', '/v1/bays/' + encodeURIComponent(id));
const lncGetUser_ = id => lnc_('get', '/v1/station-users/' + encodeURIComponent(id));
function lncSetBayOnline_(bayId, online) {
  if (CFG.DRY_RUN) return log_('DRY RUN: bay ' + bayId + (online ? ' online' : ' offline'));
  lnc_(online ? 'delete' : 'put', '/v1/bays/' + encodeURIComponent(bayId) + '/offline');
  log_('Bay ' + bayId + (online ? ' set ONLINE' : ' set OFFLINE'));
}

/* ===================== Google Admin ===================== */

function setChromebookEnabled_(serial, enable) {
  // "serial" here is the Chromebook's ASSET TAG (= the bay name), matched against Admin's Asset ID field.
  const tag = String(serial || '').trim();
  if (!tag) return false;
  const verb = enable ? 're-enable ' : 'disable ';
  let id = null;
  try {
    const r = AdminDirectory.Chromeosdevices.list('my_customer', { query: 'asset_id:' + tag, maxResults: 10, projection: 'BASIC' });
    const exact = (r.chromeosdevices || []).filter(d => String(d.annotatedAssetId || '').trim().toLowerCase() === tag.toLowerCase());
    if (exact.length !== 1) { log_('Admin lookup for asset tag "' + tag + '" found ' + exact.length + ' exact matches - skipped.'); return false; }
    id = exact[0].deviceId;
  } catch (err) {
    if (!CFG.DRY_RUN) throw err;
    log_('DRY RUN: Admin lookup unavailable (' + err + ') for ' + tag);
    return true;
  }
  if (CFG.DRY_RUN) { log_('DRY RUN: would ' + verb + tag + ' (device found in Admin)'); return true; }
  AdminDirectory.Chromeosdevices.action({ action: enable ? 'reenable' : 'disable' }, 'my_customer', id);
  log_((enable ? 'Re-enabled ' : 'Disabled ') + tag);
  return true;
}

/* ===================== Webhook receiver (deploy as Web App) ===================== */

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if ((e.parameter || {}).key !== prop_('WEBHOOK_KEY')) return out_('forbidden');
    const raw = e.postData ? e.postData.contents : '';
    sheet_(SH.WH, ['Received', 'Raw payload']).appendRow([new Date(), raw.substring(0, 4000)]);  // verify real field names here
    const ev = JSON.parse(raw);
    // Real payload: { type, timestamp, data: { bayId, bayName, bay, stationName, user: { id, name } } }
    const type = ev.type;
    const bayId = ev.data && ev.data.bayId;
    if (!type || !bayId) { log_('Ignored event (no type/bayId): ' + raw.substring(0, 200)); return out_('ignored'); }
    // Lock N Charge retries on a 5 s timeout, so the same event can arrive twice: drop repeats.
    const cache = CacheService.getScriptCache(), dk = 'ev:' + type + '|' + bayId + '|' + (ev.timestamp || '');
    if (cache.get(dk)) return out_('duplicate');
    cache.put(dk, '1', 21600);
    // "Bay reserved" (BAY_CREDS_CACHED) = PICKUP. "Bay accessed" (BAY_CREDS_CLEARED) = RETURN. "Closed" is ignored.
    if (type === 'BAY_CREDS_CACHED') onBayReserved_(bayId, ev);
    else if (type === 'BAY_CREDS_CLEARED') onBayReturned_(bayId, ev);
    else if (type !== 'BAY_CLOSED') log_('Unhandled event type: ' + type);
    return out_('ok');
  } catch (err) {
    log_('doPost error: ' + err);
    return out_('error');
  } finally { lock.releaseLock(); }
}
const out_ = s => ContentService.createTextOutput(s);

function onCheckout_(bayId, ev) {
  const d = ev.data || {};
  const uid = (d.user && d.user.id) || '';
  let name = (d.user && d.user.name) || '', sid = '';
  // the portal's "PIN" is the student ID
  if (uid) {
    try {
      const u = lncGetUser_(uid);
      name = u.name || name;
      sid = (u.stationCredentials && u.stationCredentials.pin) || u.externalRefId || '';
    } catch (e) { log_('user lookup: ' + e); }
  }
  const tag = assetTagForBay_(d.bayName);   // bay name = Chromebook asset tag
  const ts = ev.timestamp ? new Date(ev.timestamp) : new Date();
  const co = checkoutsSheet_();
  co.appendRow([bayId, d.bayName, tag, sid, name, uid, ts, '', 'Out', d.bay, d.stationName]);
  co.getRange(co.getLastRow(), 7, 1, 2).setNumberFormat('M/d/yyyy h:mm AM/PM');   // Checked Out + Returned columns
}

/** PICKUP: "Bay reserved". The student reserved a bay and took the laptop: open a Checkouts row. */
function onBayReserved_(bayId, ev) {
  const d = ev.data || {};
  const when = ev.timestamp ? new Date(ev.timestamp) : new Date();
  if (!(d.user && d.user.id)) {                            // no student in the event: ask the bay who holds it
    try { const b = lncGetBay_(bayId); if (b.assignedUserId) d.user = { id: b.assignedUserId, name: (d.user && d.user.name) || '' }; ev.data = d; } catch (e) { /* logged below */ }
  }
  const uid = (d.user && d.user.id) || '', who = (d.user && d.user.name) || '(no student)';
  if (!uid) { log_('Ignored pickup: bay ' + d.bayName + ' reserved with no student.'); return; }
  const co = checkoutsSheet_(), n = co.getLastRow();
  const rows = n >= 2 ? co.getRange(2, 1, n - 1, 9).getValues() : [];
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][0] !== bayId || rows[i][8] !== 'Out') continue;
    if (rows[i][5] === uid) { log_('Ignored duplicate pickup: bay ' + d.bayName + ' by ' + who); return; }
    co.getRange(i + 2, 8, 1, 2).setValues([[when, 'Returned']]);   // stale row: a missed return event
    log_('Closed stale Out row for bay ' + d.bayName + ' (return was never seen) before new pickup.');
    break;
  }
  onCheckout_(bayId, ev);
  log_('Checkout recorded: bay ' + d.bayName + ' by ' + who);
}

/**
 * RETURN: "Bay accessed". Counts only if the bay has an open Out row and it is the SAME student who borrowed it.
 * A different student opening the empty bay, or a bay with nothing out, is ignored and logged.
 */
function onBayReturned_(bayId, ev) {
  const d = ev.data || {};
  const uid = (d.user && d.user.id) || '', who = (d.user && d.user.name) || '(no student)';
  const when = ev.timestamp ? new Date(ev.timestamp) : new Date();
  const co = checkoutsSheet_(), n = co.getLastRow();
  const rows = n >= 2 ? co.getRange(2, 1, n - 1, 9).getValues() : [];
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][0] !== bayId || rows[i][8] !== 'Out') continue;
    if (uid && rows[i][5] !== uid) { log_('Ignored: bay ' + d.bayName + ' opened by ' + who + ', not the student who borrowed it.'); return; }
    co.getRange(i + 2, 8, 1, 2).setValues([[when, 'Returned']]);
    markReturned_(bayId, rows[i][2], 'Returned');
    log_('Return recorded: bay ' + d.bayName + ' by ' + who);
    return;
  }
  log_('Ignored: bay ' + d.bayName + ' accessed by ' + who + ' but nothing is checked out of it.');
}

function bayStateText_(bayId) {
  try {
    const b = lncGetBay_(bayId);
    return 'API state: assigned=' + b.assigned + ' locked=' + b.locked + ' offline=' + b.offline;
  } catch (e) { return 'API state unavailable'; }
}

/** Run when all bays are in a state you know (e.g. each morning): lists every bay's live API state in a "Bay States" tab. */
function dumpBayStates() {
  const s = sheet_('Bay States', ['Checked At', 'Station ID', 'Bay #', 'Bay Name', 'Locked', 'Offline', 'Assigned', 'Assigned User', 'Raw API record']);
  const now = new Date(), rows = [];
  let path = '/v1/bays?limit=100';
  for (let page = 0; page < 20 && path; page++) {
    const r = lnc_('get', path);
    (r.items || []).forEach(b => rows.push([now, b.stationId, b.bayNumber, b.name, b.locked, b.offline, b.assigned, b.assignedUserId || '', JSON.stringify(b)]));
    path = r._links && r._links.next ? String(r._links.next).replace(/^https?:\/\/[^\/]+/, '') : '';
  }
  if (rows.length) s.getRange(s.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  log_('dumpBayStates: ' + rows.length + ' bays');
}

/**
 * The "initial check": compares the sheet with the live bay states from Lock N Charge and repairs it.
 *   assigned=true                  -> laptop is OUT; assignedUserId is who has it (portal: white, or black if offline)
 *   assigned=false & offline=false -> laptop is IN its bay (portal: green)
 * - Bay is out but the sheet has no open checkout (missed pickup / before the automation): adds an Out row for
 *   the student the API names, with a blank Checked Out time.
 * - Bay is green but the sheet still says Out (missed return): marks it Returned at the detection time.
 * - Overdue-tab rows whose bay is now green are marked Returned (and the Chromebook re-enabled).
 * Unless force=true, a difference must persist across two runs before it is acted on, so a pickup or return the
 * webhook is about to record is never raced. The caller must hold the script lock.
 */
function syncWithBays_(force) {
  const now = new Date();
  if (!force && (!isSchoolDay_(now) || Number(Utilities.formatDate(now, CFG.TZ, 'H')) < 6 ||
                 Number(Utilities.formatDate(now, CFG.TZ, 'H')) >= 18)) return;
  const props = PropertiesService.getScriptProperties();
  const prev = JSON.parse(props.getProperty('BAY_SNAP') || '{}');
  const snap = {}, bays = [], stationNames = {};
  let path = '/v1/bays?limit=100';
  for (let page = 0; page < 20 && path; page++) {
    const r = lnc_('get', path);
    (r.items || []).forEach(b => bays.push(b));
    path = r._links && r._links.next ? String(r._links.next).replace(/^https?:\/\/[^\/]+/, '') : '';
  }
  try { (lnc_('get', '/v1/stations?limit=100').items || []).forEach(s => { stationNames[s.id] = s.name; }); }
  catch (e) { log_('sync: station names unavailable: ' + e); }

  const co = checkoutsSheet_(), n = co.getLastRow();
  const rows = n >= 2 ? co.getRange(2, 1, n - 1, 11).getValues() : [];
  const latest = {};                                       // bayId -> index of that bay's latest row
  rows.forEach((r, i) => { latest[r[0]] = i; });
  const byTag = {};
  let added = 0, closed = 0;

  bays.forEach(b => {
    const tag = assetTagForBay_(b.name);
    byTag[tag] = b;
    const out = !!b.assigned;
    snap[b.id] = out ? 'out:' + (b.assignedUserId || '') : (b.offline ? 'off' : 'in');
    const stable = force || prev[b.id] === snap[b.id];     // same state on the previous run too
    const i = latest[b.id];
    const open = i !== undefined && rows[i][8] === 'Out';

    if (out && !open) {                                    // out, but the sheet doesn't know
      if (!stable) return;
      const uid = b.assignedUserId || '';
      let name = '', sid = '';
      if (uid) {
        try {
          const u = lncGetUser_(uid);
          name = u.name || '';
          sid = (u.stationCredentials && u.stationCredentials.pin) || u.externalRefId || '';
        } catch (e) { log_('sync: user lookup failed for ' + b.name + ': ' + e); }
      }
      co.appendRow([b.id, b.name, tag, sid, name, uid, '', '', 'Out', b.bayNumber, stationNames[b.stationId] || b.stationId]);
      added++;
      log_('Sync: bay ' + b.name + ' is out with ' + (name || uid || 'an unknown student') + ' but had no checkout - added.');
    } else if (!out && !b.offline && open) {              // green, but the sheet says Out
      const ageMin = rows[i][6] ? (now - new Date(rows[i][6])) / 60000 : 999;
      if (ageMin < 3 || !stable) return;                   // a fresh pickup, or not settled yet
      co.getRange(i + 2, 8, 1, 2).setValues([[now, 'Returned']]);
      markReturned_(b.id, rows[i][2], 'Returned');
      closed++;
      log_('Sync: bay ' + b.name + ' is back in its locker but was marked Out - marked Returned (detected, not scanned).');
    } else if (out && open && b.assignedUserId && rows[i][5] && rows[i][5] !== b.assignedUserId) {
      log_('Sync: bay ' + b.name + ' is held by a different student than the sheet shows - check manually.');
    }
  });

  // Overdue-tab rows (including ones pasted from the old sheet) whose bay is now green are back.
  const od = overdueSheet_(), listed = overdueRows_(od);
  let odClosed = 0;
  Object.keys(listed).forEach(tag => {
    const b = byTag[tag];
    if (!b || b.assigned || b.offline) return;
    if (!(force || prev[b.id] === snap[b.id])) return;
    setChromebookEnabled_(tag, true);
    od.getRange(listed[tag], 8, 1, 2).setValues([['Returned', Utilities.formatDate(now, CFG.TZ, 'yyyy-MM-dd HH:mm')]]);
    odClosed++;
    log_('Sync: overdue laptop ' + tag + ' is back in bay ' + b.name + ' - marked Returned.');
  });
  if (added || closed || odClosed) sortOverdue_(od);

  props.setProperty('BAY_SNAP', JSON.stringify(snap));
  if (added || closed || odClosed) log_('Sync done: ' + added + ' added, ' + closed + ' closed, ' + odClosed + ' overdue rows closed.');
}

/** Timer (every 5 min, school days 6am-6pm): keeps the sheet in line with the live bay states. */
function syncBays() {
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try { syncWithBays_(false); } catch (e) { log_('syncBays error: ' + e); } finally { lock.releaseLock(); }
}

/** Run once now (and any time the script may have missed events): forces the check immediately. */
function initialCheck() {
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try { syncWithBays_(true); } finally { lock.releaseLock(); }
}

function markReturned_(bayId, serial, status) {
  const od = overdueSheet_();
  const rows = overdueRows_(od);
  const key = String(serial).trim();
  if (!rows[key]) return;                        // wasn't overdue: nothing was disabled
  setChromebookEnabled_(serial, true);
  if (CFG.OFFLINE_OVERDUE_BAYS) lncSetBayOnline_(bayId, true);
  od.getRange(rows[key], 8, 1, 2).setValues([[status || 'Returned', Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm')]]);
  sortOverdue_(od);
}

/**
 * Front office: late drop-offs go in a bin, so no door event happens. Set the Status cell on the Overdue
 * sheet to "Returned (bin)" and this re-enables the Chromebook, brings the bay online and closes the case.
 * (Installable trigger, created by installTriggers.) Deleting a row does NOT re-enable anything.
 */
function onOverdueEdit(e) {
  const s = e.range.getSheet();
  if (s.getName() !== SH.OVERDUE || e.range.getColumn() !== 8 || e.range.getRow() < 2) return;
  if (e.value !== 'Returned (bin)' || e.oldValue !== 'Overdue') return;
  const r = s.getRange(e.range.getRow(), 1, 1, OD_COLS.length).getValues()[0];
  const serial = String(r[2]).trim();
  let bayId = r[9];
  // The sheet cell is already "Returned (bin)": do the actions directly, then close the Checkouts row.
  setChromebookEnabled_(serial, true);
  try { if (!bayId) bayId = lncBayIdByName_(serial); } catch (err) { log_('bay lookup: ' + err); }
  if (bayId) lncSetBayOnline_(bayId, true); else log_('No bay found for asset tag ' + serial + ' - bay not changed.');
  s.getRange(e.range.getRow(), 9).setValue(Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm'));
  if (bayId) closeCheckout_(bayId, 'Returned');
  sortOverdue_(s);
}

function closeCheckout_(bayId, status) {
  const co = checkoutsSheet_(), n = co.getLastRow();
  if (n < 2) return;
  const d = co.getRange(2, 1, n - 1, 9).getValues();
  for (let i = d.length - 1; i >= 0; i--) {
    if (d[i][0] === bayId && d[i][8] === 'Out') { co.getRange(i + 2, 8, 1, 2).setValues([[new Date(), status]]); return; }
  }
}

/* ===================== Timer job (weekdays ~4:30 PM) ===================== */

function checkOverdue() {
  const now = new Date();
  if (!isSchoolDay_(now)) return;
  const due = new Date(now); due.setHours(CFG.DUE_HOUR, CFG.DUE_MIN, 0, 0);
  if (now < due) return;

  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    try { syncWithBays_(true); } catch (e) { log_('sync before overdue check failed: ' + e); }   // use live bay states first
    const co = checkoutsSheet_(), od = overdueSheet_();
    const n = co.getLastRow();
    if (n < 2) return;
    const data = co.getRange(2, 1, n - 1, 11).getValues();
    const listed = overdueRows_(od);   // asset tags already on the Overdue list (don't add twice)
    data.forEach((r, i) => {
      if (r[8] !== 'Out' || new Date(r[6]) > due || listed[String(r[2]).trim()]) return;
      const ok = setChromebookEnabled_(r[2], false);
      if (CFG.OFFLINE_OVERDUE_BAYS) { try { lncSetBayOnline_(r[0], false); } catch (e) { log_('bay offline failed: ' + e); } }
      od.appendRow([r[4], r[9], r[2], r[6] ? Utilities.formatDate(new Date(r[6]), CFG.TZ, 'MMM d') : 'Before automation',
        ok ? '' : 'Auto-disable FAILED - see Log tab', '', '', 'Overdue', '', r[0], r[10], r[3]]);
    });
    sortOverdue_(od);
  } finally { lock.releaseLock(); }
}

/* ===================== Sheet helpers ===================== */

// Web apps and triggers have no "active" spreadsheet, so open it by ID from the SHEET_ID Script Property.
// (Deliberately no default: it must never fall back to your live tracking sheet.)
function ss_() { return SpreadsheetApp.openById(prop_('SHEET_ID')); }

function sheet_(name, headers) {
  const ss = ss_();
  let s = ss.getSheetByName(name);
  if (!s) {
    s = ss.insertSheet(name);
    s.appendRow(headers); s.setFrozenRows(1);
    s.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#d9e2f3');
  }
  return s;
}
function overdueSheet_() {
  const s = sheet_(SH.OVERDUE, OD_COLS);
  // Status dropdown for the front office (column H).
  s.getRange('H2:H1000').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['Overdue', 'Returned', 'Returned (bin)'], true).build());
  return s;
}

function checkoutsSheet_() { return sheet_(SH.CHECKOUTS, CO_COLS); }   // fast: used on every webhook

/** Slow formatting (run from setup functions only, never per event). */
function formatCheckouts_() {
  const s = checkoutsSheet_();
  s.getRange(1, 1, s.getMaxRows(), s.getMaxColumns()).clearDataValidations();   // no dropdown anywhere...
  s.getRange('G2:H2000').setNumberFormat('M/d/yyyy h:mm AM/PM');
  s.getRange('I2:I2000').setDataValidation(SpreadsheetApp.newDataValidation()   // ...except Status
    .requireValueInList(['Out', 'Returned'], true).setAllowInvalid(false).build());
  return s;
}

// Bays are named after the asset tag. Use only the first word, so a bay renamed "50689 (829923)" still gives "50689".
const assetTagForBay_ = bayName => String(bayName || '').trim().split(/\s+/)[0] || '';

function overdueRows_(sheet) {          // bayId -> row number, for rows still Overdue
  const out = {}, n = sheet.getLastRow();
  if (n < 2) return out;
  // keyed by asset tag
  sheet.getRange(2, 1, n - 1, OD_COLS.length).getValues().forEach((v, i) => { if (v[7] === 'Overdue') out[String(v[2]).trim()] = i + 2; });
  return out;
}

function sortOverdue_(sheet) {
  const n = sheet.getLastRow();
  if (n < 3) return;
  const rng = sheet.getRange(2, 1, n - 1, OD_COLS.length);
  rng.sort([{ column: 8, ascending: true }, { column: 1, ascending: true }]);   // Overdue first ("Overdue" < "Returned"), then by name
  rng.setBackgrounds(rng.getValues().map(v => Array(OD_COLS.length).fill(v[7] === 'Overdue' ? '#fde9e7' : '#e8f5e9')));
}

function log_(msg) { sheet_(SH.LOG, ['Time', 'Message']).appendRow([new Date(), msg]); }

function isSchoolDay_(d) {
  if (d.getDay() === 0 || d.getDay() === 6) return false;
  const hol = (PropertiesService.getScriptProperties().getProperty('HOLIDAYS') || '').split(',');  // yyyy-MM-dd
  return hol.indexOf(Utilities.formatDate(d, CFG.TZ, 'yyyy-MM-dd')) === -1;
}

/* ===================== One-time setup ===================== */

/** Run once from the editor. */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkOverdue').timeBased().atHour(16).nearMinute(30).everyDays(1).inTimezone(CFG.TZ).create();
  ScriptApp.newTrigger('onOverdueEdit').forSpreadsheet(ss_()).onEdit().create();
  ScriptApp.newTrigger('syncBays').timeBased().everyMinutes(5).create();
}

/**
 * Safe test: writes ONE fake row to the target spreadsheet (Overdue + Checkouts + Log) and logs the spreadsheet's
 * name and URL. Touches nothing in Google Admin or Lock N Charge. Delete the TEST rows afterwards.
 */
function testSheetSetup() {
  const ss = ss_();
  Logger.log('Writing to spreadsheet: "' + ss.getName() + '" ' + ss.getUrl());
  overdueSheet_().appendRow(['TEST STUDENT', 0, 'TEST-TAG', 'Test', '', '', '', 'Overdue', '', 'test-bay', 'TEST', '000000']);
  checkoutsSheet_().appendRow(['test-bay', 'TEST-TAG', 'TEST-TAG', '000000', 'TEST STUDENT', 'u', new Date(), '', 'Returned']);
  sortOverdue_(overdueSheet_());
  log_('testSheetSetup ran');
}

/** Run once to add the Out/Returned dropdown to an existing Checkouts tab. */
function setupCheckoutsDropdown() {
  const s = formatCheckouts_();
  const hdr = s.getRange(1, 1, 1, CO_COLS.length).getValues()[0].map(String);
  const bad = CO_COLS.filter((c, i) => hdr[i] !== c);
  Logger.log(bad.length ? 'WARNING: Checkouts header row differs from expected in: ' + bad.join(', ') +
    '. Run resetCheckoutsTab to rewrite it.' : 'Checkouts header OK; dropdown is on Status (column I) only.');
}

/** Run ONCE after this update: clears the Checkouts tab and rewrites its header with the new column order. */
function resetCheckoutsTab() {
  const s = checkoutsSheet_();
  s.clear();
  s.appendRow(CO_COLS); s.setFrozenRows(1);
  s.getRange(1, 1, 1, CO_COLS.length).setFontWeight('bold').setBackground('#d9e2f3');
  formatCheckouts_();   // re-applies the Out/Returned dropdown
}

/** Run ONCE before pasting your old rows: clears the Overdue tab (including test rows) and rewrites its header. */
function resetOverdueTab() {
  const s = overdueSheet_();
  s.clear();
  s.appendRow(OD_COLS); s.setFrozenRows(1);
  s.getRange(1, 1, 1, OD_COLS.length).setFontWeight('bold').setBackground('#d9e2f3');
  overdueSheet_();   // re-applies the Status dropdown
}

/** After pasting old Sheet 1 rows (columns A-G) into the Overdue tab starting at A2, run this to mark them Overdue. */
function markImportedAsOverdue() {
  const s = overdueSheet_(), n = s.getLastRow();
  if (n < 2) return;
  const v = s.getRange(2, 1, n - 1, 8).getValues();
  s.getRange(2, 8, n - 1, 1).setValues(v.map(r => [r[0] && !r[7] ? 'Overdue' : r[7]]));
  sortOverdue_(s);
}

function lncBayIdByName_(name) {
  const r = lnc_('get', '/v1/bays?limit=20&name=' + encodeURIComponent(name));
  const m = (r.items || []).filter(b => String(b.name).trim() === String(name).trim());
  return m.length === 1 ? m[0].id : '';
}

/** Read-only: checks that a bay name (asset tag) finds exactly one device in Google Admin. Edit the tag below. */
function testAdminLookup() {
  const tag = 'PUT-A-REAL-ASSET-TAG-HERE';
  const r = AdminDirectory.Chromeosdevices.list('my_customer', { query: 'asset_id:' + tag, maxResults: 10, projection: 'BASIC' });
  Logger.log((r.chromeosdevices || []).map(d => d.annotatedAssetId + ' | ' + d.status + ' | ' + d.deviceId).join('\n') || 'no match');
}

/** Run once to confirm the API credentials work. Lists first bays (read-only). */
function testLncConnection() {
  const r = lnc_('get', '/v1/bays?limit=5');
  Logger.log(JSON.stringify(r, null, 2));
}


/** One-time: fill blank "Checked Out" times from the Lock N Charge event log (latest "reserved" per bay). */
function applyCheckoutTimes() {
  const T = [ // station, bay #, y, m, d, h, min (24h). No student names in code: the repo is public.
    ['ADMIN 1', 6, 2026, 11, 10,  8, 34],
    ['ADMIN 1', 1, 2026, 11, 10, 11,  1],
    ['ADMIN 1', 2, 2026, 11, 10,  9, 31],
    ['ADMIN 1', 13, 2026, 11, 10, 12, 47],
    ['ADMIN 1', 7, 2026, 11,  6, 11, 30],
    ['ADMIN 1', 9, 2026, 11,  6, 12,  7],
    ['ADMIN 1', 11, 2026, 11,  6, 10, 16],
    ['ADMIN 2', 7, 2026, 11, 10, 12, 48],
    ['ADMIN 2', 8, 2026, 11, 10, 13,  1],
    ['ADMIN 2', 1, 2026, 10, 30, 11, 27],
    ['ADMIN 2', 2, 2026, 11,  9, 10,  9],
    ['ADMIN 2', 3, 2026, 10, 29,  8, 21],
    ['ADMIN 2', 10, 2026, 11,  4,  8, 39]
  ];
  const s = sheet_(SH.CHECKOUTS, CO_COLS);
  const rows = s.getLastRow() - 1;
  if (rows < 1) return;
  const v = s.getRange(2, 1, rows, CO_COLS.length).getValues();
  let n = 0;
  T.forEach(t => {
    let found = false;
    for (let i = v.length - 1; i >= 0; i--) {
      const r = v[i];
      if (String(r[10]).trim().toUpperCase() !== t[0] || Number(r[9]) !== t[1] || String(r[8]).trim() !== 'Out') continue;
      found = true;
      if (r[6]) break; // already has a time
      s.getRange(i + 2, 7).setValue(new Date(t[2], t[3] - 1, t[4], t[5], t[6])).setNumberFormat('M/d/yyyy h:mm AM/PM');
      n++; break;
    }
    if (!found) log_('applyCheckoutTimes: no Out row for ' + t[0] + ' bay ' + t[1]);
  });
  log_('applyCheckoutTimes: ' + 'filled ' + n + ' rows');
}
