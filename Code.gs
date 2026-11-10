/**
 * Chromebook Locker Automation (Lock N Charge API v1 + Google Admin + Google Sheets)
 * Bound to the tracking spreadsheet. See README.md for setup.
 *
 * How it works
 *  - Lock N Charge calls our web app (webhook) when a bay is accessed (BAY_CREDS_CLEARED = checkout)
 *    and when a bay door closes after that (BAY_CLOSED = return). Events go in the "Checkouts" sheet.
 *  - ~4:30 PM weekdays: anything still out past 4:15 PM is DISABLED in Google Admin, its bay is set
 *    OFFLINE, and the student is listed on the "Overdue" sheet for the front office.
 *  - On return: the Chromebook is RE-ENABLED, the bay set ONLINE, and the Overdue row is marked Returned.
 *
 * The LNC API has no Chromebook serial numbers, so the "Bay Map" sheet maps bay name -> serial.
 */

const CFG = {
  TZ: 'America/Los_Angeles',   // Pacific (confirmed by webhook timestamps vs. sheet times)
  DUE_HOUR: 16, DUE_MIN: 15,   // 4:15 PM return deadline
  MIN_RETURN_MINUTES: 3,       // a door-close within this many minutes of checkout is NOT a return
  DRY_RUN: true,               // true = write to sheets/log only; no Admin or bay changes. Set false to go live.
};
const SH = { CHECKOUTS: 'Checkouts', OVERDUE: 'Overdue', MAP: 'Bay Map', WH: 'Webhook Log', LOG: 'Log' };
const CO_COLS = ['Bay ID', 'Bay Name', 'Asset Tag', 'User ID', 'Student', 'Student ID', 'Checked Out', 'Returned', 'Status', 'Bay #', 'Station'];
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
    // "Accessed" fires for BOTH pickup and drop-off (the student enters their PIN either way).
    // "Closed" fires after both too, so it's not used.
    if (type === 'BAY_CREDS_CLEARED') onBayAccessed_(bayId, ev);
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
  co.appendRow([bayId, d.bayName, tag, uid, name, sid, ts, '', 'Out', d.bay, d.stationName]);
  co.getRange(co.getLastRow(), 7, 1, 2).setNumberFormat('M/d/yyyy h:mm AM/PM');   // Checked Out + Returned columns
}

/**
 * A bay access is a RETURN if that bay's latest Checkouts row is still open (Out/Overdue);
 * otherwise it's a new CHECKOUT. Time recorded is the event's own timestamp.
 */
function onBayAccessed_(bayId, ev) {
  const d = ev.data || {};
  const co = checkoutsSheet_();
  const n = co.getLastRow();
  if (n >= 2) {
    const rows = co.getRange(2, 1, n - 1, 9).getValues();
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r[0] !== bayId) continue;
      if (r[8] === 'Out') {                                // open checkout -> this access is the drop-off
        const when = ev.timestamp ? new Date(ev.timestamp) : new Date();
        co.getRange(i + 2, 8, 1, 2).setValues([[when, 'Returned']]);
        co.getRange(i + 2, 7, 1, 2).setNumberFormat('M/d/yyyy h:mm AM/PM');
        markReturned_(bayId, r[2], 'Returned');
        log_('Return recorded: bay ' + d.bayName);
        return;
      }
      break;                                               // latest row for this bay is closed -> new checkout
    }
  }
  onCheckout_(bayId, ev);
  log_('Checkout recorded: bay ' + d.bayName);
}

function markReturned_(bayId, serial, status) {
  const od = overdueSheet_();
  const rows = overdueRows_(od);
  const key = String(serial).trim();
  if (!rows[key]) return;                        // wasn't overdue: nothing was disabled
  setChromebookEnabled_(serial, true);
  lncSetBayOnline_(bayId, true);
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
    const co = checkoutsSheet_(), od = overdueSheet_();
    const n = co.getLastRow();
    if (n < 2) return;
    const data = co.getRange(2, 1, n - 1, 11).getValues();
    const listed = overdueRows_(od);   // asset tags already on the Overdue list (don't add twice)
    data.forEach((r, i) => {
      if (r[8] !== 'Out' || new Date(r[6]) > due || listed[String(r[2]).trim()]) return;
      const ok = setChromebookEnabled_(r[2], false);
      try { lncSetBayOnline_(r[0], false); } catch (e) { log_('bay offline failed: ' + e); }
      od.appendRow([r[4], r[9], r[2], Utilities.formatDate(new Date(r[6]), CFG.TZ, 'MMM d'),
        ok ? '' : 'Auto-disable FAILED - see Log tab', '', '', 'Overdue', '', r[0], r[10], r[5]]);
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

function checkoutsSheet_() {
  const s = sheet_(SH.CHECKOUTS, CO_COLS);
  // Status dropdown (column I): Out or Returned. Script writes bypass it; it only guards manual edits.
  s.getRange('I2:I2000').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['Out', 'Returned'], true).setAllowInvalid(false).build());
  return s;
}

const assetTagForBay_ = bayName => String(bayName || '').trim();   // bays are named after the asset tag

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
}

/**
 * Safe test: writes ONE fake row to the target spreadsheet (Overdue + Checkouts + Log) and logs the spreadsheet's
 * name and URL. Touches nothing in Google Admin or Lock N Charge. Delete the TEST rows afterwards.
 */
function testSheetSetup() {
  const ss = ss_();
  Logger.log('Writing to spreadsheet: "' + ss.getName() + '" ' + ss.getUrl());
  overdueSheet_().appendRow(['TEST STUDENT', 0, 'TEST-TAG', 'Test', '', '', '', 'Overdue', '', 'test-bay', 'TEST', '000000']);
  checkoutsSheet_().appendRow(['test-bay', 'TEST-TAG', 'TEST-TAG', 'u', 'TEST STUDENT', '000000', new Date(), '', 'Returned']);
  sortOverdue_(overdueSheet_());
  log_('testSheetSetup ran');
}

/** Run once to add the Out/Returned dropdown to an existing Checkouts tab. */
function setupCheckoutsDropdown() { checkoutsSheet_(); }

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
