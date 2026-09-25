// Runs every hour (see netlify.toml) but only actually does anything at
// specific UK local times, checked below. Netlify's scheduler only runs in
// UTC and doesn't shift for British Summer Time, so running hourly and
// checking real UK local time here is what keeps "9am" meaning 9am UK
// year-round rather than drifting an hour out every summer.

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

async function firestoreSetDoc(path, valueObj) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}?updateMask.fieldPaths=value`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { value: { stringValue: JSON.stringify(valueObj) } } })
  });
  if (!res.ok) throw new Error(`Firestore write failed (${path}): ${res.status}`);
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const target = new Date(dateStr + 'T00:00:00Z');
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}

// Real UK local hour and day-of-month, correct across the GMT/BST switch.
function ukNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour: 'numeric', hour12: false, day: 'numeric', month: 'numeric', year: 'numeric'
  }).formatToParts(new Date());
  const get = (t) => parseInt(parts.find(p => p.type === t).value, 10);
  return { hour: get('hour'), day: get('day'), month: get('month'), year: get('year') };
}

function pad2(n) { return String(n).padStart(2, '0'); }

exports.handler = async function () {
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  if (!vapidPublic || !vapidPrivate) {
    console.error('VAPID keys not configured');
    return { statusCode: 200, body: 'skipped - no VAPID keys configured' };
  }
  webpush.setVapidDetails('mailto:office@khgsecurity.com', vapidPublic, vapidPrivate);

  const uk = ukNow();

  try {
    const [catalog, followUps, vehicles, subsMap, rota, overtime, monthlyReportsExisting] = await Promise.all([
      firestoreGetDoc('shared/catalog'),
      firestoreGetDoc('shared/follow-ups'),
      firestoreGetDoc('shared/vehicles'),
      firestoreGetDoc('shared/push-subscriptions'),
      firestoreGetDoc('shared/callout-rota'),
      firestoreGetDoc('shared/overtime'),
      firestoreGetDoc('shared/monthly-reports')
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

    // Daily checks (follow-ups nearing deadline, vehicles nearing MOT/service)
    // — run once, at 7am UK local time.
    if (uk.hour === 7) {
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
    }

    // Monthly on-call report: 7am UK on the 25th, covering the WHOLE month
    // (1st to last day), including days still to come — not just to date.
    if (uk.day === 25 && uk.hour === 7) {
      const monthStart = uk.year + '-' + pad2(uk.month) + '-01';
      const lastDay = new Date(Date.UTC(uk.year, uk.month, 0)).getUTCDate();
      const monthEnd = uk.year + '-' + pad2(uk.month) + '-' + pad2(lastDay);
      const monthLabel = new Date(Date.UTC(uk.year, uk.month - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

      const counts = {}; // engineerId -> { weekday, weekend }
      (rota || []).forEach(function (r) {
        if (r.date < monthStart || r.date > monthEnd) return;
        if (!counts[r.engineerId]) counts[r.engineerId] = { weekday: 0, weekend: 0 };
        const dow = new Date(r.date + 'T00:00:00Z').getUTCDay();
        if (dow === 0 || dow === 6) counts[r.engineerId].weekend++;
        else counts[r.engineerId].weekday++;
      });

      const summaryLines = engineers
        .filter(function (e) { return counts[e.id]; })
        .map(function (e) {
          const c = counts[e.id];
          return e.name + ': ' + c.weekday + ' weekday, ' + c.weekend + ' weekend';
        });

      if (summaryLines.length) {
        const reportBody = monthLabel + ' \u2014 ' + summaryLines.join(' | ');
        officeOrAdminIds.forEach(function (id) { queue(id, 'Monthly on-call report', reportBody, '/'); });
        const reports = (monthlyReportsExisting || []).slice();
        reports.push({ id: genId(), type: 'oncall', label: 'On-call \u2014 ' + monthLabel, body: reportBody, generatedAt: new Date().toISOString() });
        while (reports.length > 60) reports.shift();
        await firestoreSetDoc('shared/monthly-reports', reports).catch(function (e) { console.error('Failed to log on-call report', e); });
      }
    }

    // Monthly overtime report: 9am UK on the 25th, covering all APPROVED
    // overtime dated from the 1st to the 25th of the current month.
    if (uk.day === 25 && uk.hour === 9) {
      const monthStart = uk.year + '-' + pad2(uk.month) + '-01';
      const cutoff = uk.year + '-' + pad2(uk.month) + '-25';
      const monthLabel = new Date(Date.UTC(uk.year, uk.month - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

      const totals = {}; // engineerId -> { name, hours, count }
      (overtime || [])
        .filter(function (o) { return o.status === 'approved' && o.date >= monthStart && o.date <= cutoff; })
        .forEach(function (o) {
          if (!totals[o.personId]) totals[o.personId] = { name: o.personName, hours: 0, count: 0 };
          totals[o.personId].hours += parseFloat(o.hours) || 0;
          totals[o.personId].count += 1;
        });

      const otLines = Object.keys(totals).map(function (id) {
        const t = totals[id];
        return t.name + ': ' + t.hours + 'h (' + t.count + ')';
      });

      if (otLines.length) {
        const reportBody = monthLabel + ' to 25th \u2014 ' + otLines.join(' | ');
        officeOrAdminIds.forEach(function (id) { queue(id, 'Monthly overtime report', reportBody, '/'); });
        const reports = (monthlyReportsExisting || []).slice();
        reports.push({ id: genId(), type: 'overtime', label: 'Overtime \u2014 ' + monthLabel, body: reportBody, generatedAt: new Date().toISOString() });
        while (reports.length > 60) reports.shift();
        await firestoreSetDoc('shared/monthly-reports', reports).catch(function (e) { console.error('Failed to log overtime report', e); });
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

    return { statusCode: 200, body: JSON.stringify({ success: true, sent, failed, ukHour: uk.hour, ukDay: uk.day }) };
  } catch (err) {
    console.error('check-reminders error:', err);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: (err && err.message) || 'Unknown error' }) };
  }
};
