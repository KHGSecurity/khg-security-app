// Runs once a day (see netlify.toml) to check for follow-ups nearing their
// repair deadline and vehicles nearing their MOT/service date, and pushes
// reminders to the relevant people. No client involvement — this runs
// entirely on Netlify's own schedule.

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

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const target = new Date(dateStr + 'T00:00:00Z');
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}

exports.handler = async function () {
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  if (!vapidPublic || !vapidPrivate) {
    console.error('VAPID keys not configured');
    return { statusCode: 200, body: 'skipped - no VAPID keys configured' };
  }
  webpush.setVapidDetails('mailto:office@khgsecurity.com', vapidPublic, vapidPrivate);

  try {
    const [catalog, followUps, vehicles, subsMap, rota] = await Promise.all([
      firestoreGetDoc('shared/catalog'),
      firestoreGetDoc('shared/follow-ups'),
      firestoreGetDoc('shared/vehicles'),
      firestoreGetDoc('shared/push-subscriptions'),
      firestoreGetDoc('shared/rota')
    ]);

    const engineers = (catalog && catalog.engineers) || [];
    const officeOrAdminIds = engineers
      .filter(function (e) { return e.isAdmin || !e.hasVan; })
      .map(function (e) { return e.id; });

    const toNotify = {};
    function queue(personId, title, body, url) {
      if (!personId) return;
      if (!toNotify[personId]) toNotify[personId] = [];
      toNotify[personId].push({ title, body, url });
    }

    (followUps || [])
      .filter(function (f) { return f.status !== 'resolved'; })
      .forEach(function (f) {
        const d = daysUntil(f.repairBy);
        if (d !== null && d <= 3) {
          const label = d < 0 ? 'OVERDUE' : (d + ' day(s) left');
          const body = f.customerName + ' \u2014 ' + label + ' to repair (due ' + f.repairBy + ')';
          queue(f.createdById, 'Follow-up reminder', body, '/');
          officeOrAdminIds.forEach(function (id) { queue(id, 'Follow-up reminder', body, '/'); });
        }
      });

    (vehicles || []).forEach(function (v) {
      const motDays = daysUntil(v.motDate);
      const serviceDays = daysUntil(v.serviceDate);
      const due = [];
      if (motDays !== null && motDays <= 7) due.push('MOT (' + v.motDate + ')');
      if (serviceDays !== null && serviceDays <= 7) due.push('Service (' + v.serviceDate + ')');
      if (due.length) {
        const body = v.registration + ': ' + due.join(', ') + ' due soon';
        const driver = engineers.filter(function (e) {
          return e.registration && e.registration.trim().toUpperCase() === (v.registration || '').trim().toUpperCase();
        })[0];
        if (driver) queue(driver.id, 'Vehicle reminder', body, '/');
        officeOrAdminIds.forEach(function (id) { queue(id, 'Vehicle reminder', body, '/'); });
      }
    });

    // Monthly on-call report: fires on the 25th, covering the WHOLE month
    // (1st to last day), including days still to come — not just to date.
    const now = new Date();
    if (now.getUTCDate() === 25) {
      const year = now.getUTCFullYear(), month = now.getUTCMonth();
      const monthStart = year + '-' + String(month + 1).padStart(2, '0') + '-01';
      const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      const monthEnd = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(lastDay).padStart(2, '0');
      const monthLabel = new Date(Date.UTC(year, month, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

      const counts = {}; // engineerId -> { weekday, weekend }
      (rota || []).forEach(function (r) {
        if (r.date < monthStart || r.date > monthEnd) return;
        if (!counts[r.engineerId]) counts[r.engineerId] = { weekday: 0, weekend: 0 };
        const dow = new Date(r.date + 'T00:00:00Z').getUTCDay();
        if (dow === 0 || dow === 6) counts[r.engineerId].weekend++;
        else counts[r.engineerId].weekday++;
      });

      var summaryLines = engineers
        .filter(function (e) { return counts[e.id]; })
        .map(function (e) {
          var c = counts[e.id];
          return e.name + ': ' + c.weekday + ' weekday, ' + c.weekend + ' weekend';
        });

      if (summaryLines.length) {
        var reportBody = monthLabel + ' \u2014 ' + summaryLines.join(' | ');
        officeOrAdminIds.forEach(function (id) { queue(id, 'Monthly on-call report', reportBody, '/'); });
      }
    }

    let sent = 0, failed = 0;
    for (const personId of Object.keys(toNotify)) {
      const subs = (subsMap && subsMap[personId]) || [];
      for (const item of toNotify[personId]) {
        for (const sub of subs) {
          try {
            await webpush.sendNotification(sub, JSON.stringify(item));
            sent++;
          } catch (err) {
            failed++;
          }
        }
      }
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, sent, failed }) };
  } catch (err) {
    console.error('check-reminders error:', err);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: (err && err.message) || 'Unknown error' }) };
  }
};
