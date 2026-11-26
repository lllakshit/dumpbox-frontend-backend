/**
 * Gmail → DumpBox Email section. A Google Apps Script that runs in your own Google account.
 *
 * What it does: every 10 minutes it sends the Gmail conversations that carry the labels you list below to the
 * Email section of DumpBox, with their labels, star, importance, unread state and your priority labels.
 * One Gmail conversation = one DumpBox conversation; sending it again updates it, so there are never copies.
 * A conversation whose labels you remove in Gmail moves to Archived in DumpBox. Gmail is only read, never changed.
 *
 * Setup:
 *   1. DumpBox → Settings → Email → Make import key → Copy script. Paste it here (replace everything) and save.
 *      (If you pasted this file by hand, put the key in IMPORT_KEY.)
 *   2. Edit SYNC_LABELS and PRIORITY below.
 *   3. Choose fullSync → Run. Allow access (Advanced → Go to project: it is your own script).
 *      Big mailboxes: run it again while the log says "paused" (or let the hourly run continue it).
 *   4. Choose installTriggers → Run. Done: it now runs by itself.
 */

const CONFIG = {
  API: 'https://dumpbox-app.vercel.app',
  IMPORT_KEY: 'PASTE_IMPORT_KEY',

  // Gmail labels to bring in. A parent also brings its children ("Work" covers "Work/Clients/Acme").
  SYNC_LABELS: ['Bills', 'Travel', 'Work'],
  INCLUDE_CHILD_LABELS: true,

  // Your priority labels, highest first. Conversations with one of them are brought in too.
  PRIORITY: [
    { label: 'P1', priority: 1 }, // High
    { label: 'P2', priority: 2 }, // Medium
    { label: 'P3', priority: 3 }, // Low
  ],
  // Priority for Gmail's yellow "important" marker when no priority label is set: 0 = none, or 1 / 2 / 3.
  IMPORTANT_MEANS: 0,

  // true: a conversation shows every Gmail label it has; false: only the labels listed above.
  SEND_ALL_LABELS: true,

  RECENT_DAYS: 3,            // the 10-minute run checks conversations with mail in the last N days
  MAX_MESSAGES: 50,          // latest N messages of a conversation are kept
  MAX_CHARS_PER_MESSAGE: 60000,
  BATCH_THREADS: 20,         // conversations per request
};

const REQUEST_BYTES = 3000000;  // DumpBox accepts up to 4 MB per request; stay well under it
const MAX_REMEMBERED = 9000;    // script storage holds ~500 KB; past this, conversations are simply re-checked

// ───────────────────────── Run these ─────────────────────────

/** Every 10 minutes (installTriggers): conversations under your labels with mail in the last RECENT_DAYS days. */
function syncRecent() {
  withLock_(function () {
    const ctx = context_();
    const since = Date.now() - CONFIG.RECENT_DAYS * 86400000;
    const seen = {};
    for (const label of ctx.labels) {
      for (let start = 0; ; start += 50) {
        const threads = label.getThreads(start, 50); // newest first
        let older = false;
        for (const thread of threads) {
          if (thread.getLastMessageDate().getTime() < since) { older = true; break; }
          if (seen[thread.getId()]) continue;
          seen[thread.getId()] = true;
          if (outOfTime_(ctx)) { send_(ctx); return report_(ctx, 'stopped early, the next run continues'); }
          queue_(thread, ctx);
        }
        if (older || threads.length < 50) break;
      }
    }
    send_(ctx);
    report_(ctx, 'done');
  });
}

/**
 * First import, and nightly: every conversation under your labels, plus every one sent before (so a label removed
 * in Gmail, or added to an old email, is picked up). Its place is saved after every successful send, so a time
 * limit or an error never loses more than one batch; the next run continues from there.
 */
function fullSync() {
  withLock_(function () {
    const ctx = context_();
    const props = ctx.props;
    const cursor = JSON.parse(props.getProperty('cursor') || '{"phase":"known","i":0,"label":0,"start":0}');
    ctx.trackCursor = true;

    if (cursor.phase === 'known') {
      const ids = Object.keys(props.getProperties()).filter(function (k) { return k.indexOf('t:') === 0; }).map(function (k) { return k.slice(2); }).sort();
      for (; cursor.i < ids.length; cursor.i++) {
        if (outOfTime_(ctx)) return pause_(ctx, cursor);
        let thread = null;
        try { thread = GmailApp.getThreadById(ids[cursor.i]); } catch (e) { thread = null; }
        ctx.next = { phase: 'known', i: cursor.i + 1, label: 0, start: 0 };
        if (thread) queue_(thread, ctx); // deleted in Gmail: its DumpBox copy stays as it is
        checkpoint_(ctx);
      }
      cursor.phase = 'labels'; cursor.label = 0; cursor.start = 0;
    }

    for (; cursor.label < ctx.labels.length; cursor.label++, cursor.start = 0) {
      const label = ctx.labels[cursor.label];
      for (;;) {
        const threads = label.getThreads(cursor.start, 100);
        for (let k = 0; k < threads.length; k++) {
          if (outOfTime_(ctx)) return pause_(ctx, cursor);
          ctx.next = { phase: 'labels', i: 0, label: cursor.label, start: cursor.start + k + 1 };
          queue_(threads[k], ctx);
          checkpoint_(ctx);
        }
        cursor.start += threads.length;
        if (threads.length < 100) break;
      }
    }
    send_(ctx);
    props.deleteProperty('cursor');
    report_(ctx, 'full sync done');
  });
}

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('syncRecent').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('fullSync').timeBased().everyDays(1).atHour(3).create();
  ScriptApp.newTrigger('continueFullSync').timeBased().everyHours(1).create();
  Logger.log('Installed: every 10 minutes, nightly full check, and an hourly continue for an unfinished full check.');
}

function continueFullSync() {
  if (PropertiesService.getScriptProperties().getProperty('cursor')) fullSync();
}

/** Forget what was already sent (DumpBox keeps the mail). The next fullSync sends everything again, without copies. */
function resetSyncState() {
  const props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).forEach(function (k) { if (k.indexOf('t:') === 0 || k === 'cursor') props.deleteProperty(k); });
}

// ───────────────────────── One conversation ─────────────────────────

/** Adds a conversation to the outgoing batch when it changed since it was last sent. */
function queue_(thread, ctx) {
  const names = thread.getLabels().map(function (l) { return l.getName(); });
  const synced = names.filter(ctx.isSynced);
  const key = 't:' + thread.getId();
  const before = ctx.props.getProperty(key);
  if (!synced.length && !before) return; // not one of yours and never sent
  if (ctx.batch.some(function (b) { return b.key === key; })) return; // already waiting (it has two synced labels)

  const messages = thread.getMessages();
  const last = messages[messages.length - 1];
  const labels = CONFIG.SEND_ALL_LABELS ? names : synced;
  const lower = names.map(function (n) { return n.toLowerCase(); });
  const p = CONFIG.PRIORITY.filter(function (x) { return lower.indexOf(x.label.toLowerCase()) >= 0; })[0];
  const important = thread.isImportant();
  const priority = p ? p.priority : (important && CONFIG.IMPORTANT_MEANS ? CONFIG.IMPORTANT_MEANS : null);
  const starred = thread.hasStarredMessages();
  const unread = thread.isUnread();
  const inScope = synced.length > 0;
  const hash = digest_([labels.join('|'), priority, starred, important, unread, inScope, messages.length, last.getId()].join('#'));
  if (before === hash) return; // nothing changed in Gmail

  const body = {
    external_id: thread.getId(),
    subject: thread.getFirstMessageSubject() || '',
    labels: labels.slice(0, 100),
    starred: starred,
    important: important,
    unread: unread,
    priority: priority,
    in_scope: inScope,
    message_count: messages.length,
    messages: messages.slice(-CONFIG.MAX_MESSAGES).map(function (m) {
      let attachments = [];
      try {
        attachments = m.getAttachments({ includeInlineImages: false }).slice(0, 50).map(function (a) {
          return { name: a.getName(), size: a.getSize(), mime: a.getContentType() };
        });
      } catch (e) { attachments = []; }
      return {
        external_id: m.getId(),
        from: m.getFrom(),
        to: m.getTo(),
        cc: m.getCc(),
        sent_at: m.getDate().toISOString(),
        body_text: (m.getPlainBody() || '').slice(0, CONFIG.MAX_CHARS_PER_MESSAGE),
        unread: m.isUnread(),
        attachments: attachments,
      };
    }),
  };
  const size = fitToRequest_(body);
  // Send what is waiting first when this conversation would push the request over the limit.
  if (ctx.batch.length && ctx.batchBytes + size > REQUEST_BYTES) send_(ctx);
  ctx.batch.push({ key: key, hash: hash, body: body });
  ctx.batchBytes += size;
  if (ctx.batch.length >= CONFIG.BATCH_THREADS || ctx.batchBytes > REQUEST_BYTES) send_(ctx);
}

/** Real UTF-8 size of a conversation; a very long one keeps fewer, shorter messages until it fits one request. */
function fitToRequest_(body) {
  let size = bytes_(body);
  while (size > REQUEST_BYTES - 50000 && body.messages.length > 1) {
    body.messages.shift(); // oldest first
    size = bytes_(body);
  }
  const caps = [20000, 5000, 1000];
  for (let c = 0; c < caps.length && size > REQUEST_BYTES - 50000; c++) {
    body.messages.forEach(function (m) { m.body_text = m.body_text.slice(0, caps[c]); });
    size = bytes_(body);
  }
  return size;
}

function bytes_(value) {
  return Utilities.newBlob(JSON.stringify(value)).getBytes().length;
}

/**
 * Sends the batch. If DumpBox refuses it, each conversation is sent on its own, so one bad email never holds back
 * the others. A conversation is remembered as sent only after DumpBox accepted it (a refused one is remembered too,
 * so it is not retried every 10 minutes; it is tried again when it changes in Gmail).
 */
function send_(ctx) {
  if (!ctx.batch.length) return;
  const batch = ctx.batch;
  ctx.batch = [];
  ctx.batchBytes = 0;
  const res = post_(batch);
  if (res.status === 200) {
    accepted_(ctx, batch, res.json);
  } else if (batch.length > 1 && (res.status === 400 || res.status === 413 || res.status >= 500)) {
    batch.forEach(function (one) {
      const r = post_([one]);
      if (r.status === 200) accepted_(ctx, [one], r.json);
      else refused_(ctx, one, r);
    });
  } else {
    batch.forEach(function (one) { refused_(ctx, one, res); });
  }
  if (ctx.trackCursor && ctx.next) {
    try { ctx.props.setProperty('cursor', JSON.stringify(ctx.next)); } catch (e) { /* storage full */ }
    ctx.sinceSave = 0;
  }
}

function post_(batch) {
  const res = UrlFetchApp.fetch(CONFIG.API + '/v1/email/import', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + CONFIG.IMPORT_KEY },
    payload: JSON.stringify({ threads: batch.map(function (b) { return b.body; }) }),
    muteHttpExceptions: true,
  });
  const status = res.getResponseCode();
  if (status === 401) throw new Error('DumpBox refused the import key. Make a new one in DumpBox → Settings → Email and put it in IMPORT_KEY.');
  let json = null;
  try { json = JSON.parse(res.getContentText()); } catch (e) { json = null; }
  return { status: status, json: json, text: res.getContentText() };
}

function accepted_(ctx, batch, r) {
  ctx.created += r.created; ctx.updated += r.updated; ctx.skipped += r.skipped;
  batch.forEach(function (b) { remember_(ctx, b); });
}

function refused_(ctx, one, res) {
  ctx.failed++;
  if (ctx.errors.length < 5) ctx.errors.push('"' + one.body.subject.slice(0, 80) + '" → ' + res.status + ' ' + String(res.text).slice(0, 200));
  remember_(ctx, one);
}

function remember_(ctx, b) {
  const known = ctx.props.getProperty(b.key) !== null;
  if (!known && ctx.remembered >= MAX_REMEMBERED) return;
  try {
    ctx.props.setProperty(b.key, b.hash);
    if (!known) ctx.remembered++;
  } catch (e) { /* storage full: it is just checked again next time */ }
}

/** With nothing waiting to be sent, the place in a full sync can be saved now and then without losing anything. */
function checkpoint_(ctx) {
  if (ctx.batch.length || !ctx.next) return;
  ctx.sinceSave = (ctx.sinceSave || 0) + 1;
  if (ctx.sinceSave < 25) return;
  ctx.sinceSave = 0;
  try { ctx.props.setProperty('cursor', JSON.stringify(ctx.next)); } catch (e) { /* storage full */ }
}

// ───────────────────────── Helpers ─────────────────────────

function context_() {
  if (!/^[A-Za-z0-9_-]{43}$/.test(CONFIG.IMPORT_KEY)) throw new Error('Put your import key in IMPORT_KEY (DumpBox → Settings → Email).');
  const roots = CONFIG.SYNC_LABELS.concat(CONFIG.PRIORITY.map(function (p) { return p.label; })).map(function (n) { return n.toLowerCase(); });
  const isSynced = function (name) {
    const n = name.toLowerCase();
    return roots.some(function (r) { return n === r || (CONFIG.INCLUDE_CHILD_LABELS && n.indexOf(r + '/') === 0); });
  };
  const labels = GmailApp.getUserLabels().filter(function (l) { return isSynced(l.getName()); });
  if (!labels.length) Logger.log('None of SYNC_LABELS / PRIORITY exist in Gmail yet: ' + roots.join(', '));
  const props = PropertiesService.getScriptProperties();
  return {
    started: Date.now(),
    props: props,
    remembered: Object.keys(props.getProperties()).filter(function (k) { return k.indexOf('t:') === 0; }).length,
    labels: labels,
    isSynced: isSynced,
    batch: [],
    batchBytes: 0,
    trackCursor: false,
    next: null,
    sinceSave: 0,
    created: 0, updated: 0, skipped: 0, failed: 0,
    errors: [],
  };
}

function report_(ctx, note) {
  Logger.log(note + ' · new ' + ctx.created + ' · updated ' + ctx.updated + ' · skipped (deleted in DumpBox) ' + ctx.skipped + ' · refused ' + ctx.failed +
    (ctx.errors.length ? '\n' + ctx.errors.join('\n') : ''));
}

function pause_(ctx, cursor) {
  send_(ctx);
  try { ctx.props.setProperty('cursor', JSON.stringify(ctx.next || cursor)); } catch (e) { /* storage full */ }
  report_(ctx, 'paused (time limit): run fullSync again, or wait for the hourly continue');
}

function outOfTime_(ctx) {
  return Date.now() - ctx.started > 4.5 * 60000;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) { Logger.log('Another sync is running; skipped.'); return; }
  try { fn(); } finally { lock.releaseLock(); }
}

function digest_(text) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, text, Utilities.Charset.UTF_8)).slice(0, 12);
}
