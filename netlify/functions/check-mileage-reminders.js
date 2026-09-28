// Runs every 15 minutes (see netlify.toml) but only actually does anything
// at 5:30pm UK local time — checked below, correct across the GMT/BST
// switch the same way check-reminders.js is. Kept as its own function
// rather than folded into check-reminders.js's hourly run because it needs
// to fire on a half-hour, not on the hour.
//
// Nudges any engineer who has opted in (their "Remind me at 5:30pm" toggle
// in the app's Mileage Log) and hasn't logged a single trip for today yet.
// Tapping the notification just opens the app; the actual "log it now" /
// "nothing to report today" choice is made there, in the Mileage Log
// screen's own reminder banner (iOS push notifications don't reliably
// support action buttons, so this is done in-app instead).

const webpush = require('web-push');

const FIREBASE_PROJECT_ID = 'van-stock-app-ccd8c';

async function firestoreGetDoc(path) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore read failed (${path}): ${res.status}`);
  const doc = await res.json();
  const value = doc.fields && doc.fields.value && doc.fields.value.stringValue;
  return value ? JSON.parse(value) : null;
}

// Real UK local hour/minute/day, correct across the GMT/BST switch.
function ukNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour: 'numeric', minute: 'numeric', hour12: false,
    day: 'numeric', month: 'numeric', year: 'numeric'
  }).formatToParts(new Date());
  const get = (t) => parseInt(parts.find(p => p.type === t).value, 10);
  return { hour: get('hour'), minute: get('minute'), day: get('day'), month: get('month'), year: get('year') };
}
function pad2(n) { return String(n).padStart(2, '0'); }

exports.handler = async function () {
  const uk = ukNow();
  if (uk.hour !== 17 || uk.minute !== 30) {
    return { statusCode: 200, body: 'skipped - not 5:30pm UK' };
  }

  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  if (!vapidPublic || !vapidPrivate) {
    return { statusCode: 200, body: 'skipped - no VAPID keys configured' };
  }
  webpush.setVapidDetails('mailto:office@khgsecurity.com', vapidPublic, vapidPrivate);

  try {
    const [catalog, mileageEntries, subsMap] = await Promise.all([
      firestoreGetDoc('shared/catalog'),
      firestoreGetDoc('shared/mileage'),
      firestoreGetDoc('shared/push-subscriptions')
    ]);

    const engineers = (catalog && catalog.engineers) || [];
    const todayStr = uk.year + '-' + pad2(uk.month) + '-' + pad2(uk.day);

    const loggedTodayByPerson = {};
    (mileageEntries || []).forEach(function (e) {
      if (e.date === todayStr) loggedTodayByPerson[e.personId] = true;
    });

    const toRemind = engineers.filter(function (e) {
      return e.mileageReminderOptIn && !loggedTodayByPerson[e.id];
    });

    let sent = 0, failed = 0;
    for (const eng of toRemind) {
      const subs = (subsMap && subsMap[eng.id]) || [];
      for (const sub of subs) {
        try {
          await webpush.sendNotification(sub, JSON.stringify({
            title: 'Mileage reminder',
            body: 'You haven’t logged any mileage today — open the app to add a trip, or mark it as nothing to report.',
            url: '/'
          }));
          sent++;
        } catch (err) {
          failed++;
        }
      }
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, remindedCount: toRemind.length, sent, failed }) };
  } catch (err) {
    console.error('check-mileage-reminders error:', err);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: (err && err.message) || 'Unknown error' }) };
  }
};
