// Runs on a schedule (see netlify.toml) and watches ServiceM8 for jobs that
// have just been assigned to an engineer (a new schedule/diary entry
// appearing against a job), then sends that engineer a push notification.
//
// There's no webhook from ServiceM8 for this, so instead each run takes a
// fresh snapshot of "which staff member is booked on which job on which
// day" and compares it against the snapshot saved from the previous run
// (kept in Firestore). Anything new in this run that wasn't in the last one
// is a newly-made assignment.
//
// On the very first run ever (no previous snapshot saved yet) nothing is
// notified — everything currently on the schedule would otherwise look
// "new" and blast every engineer at once. It just seeds the snapshot.

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

exports.handler = async function () {
  const apiKey = process.env.SERVICEM8_API_KEY;
  if (!apiKey) {
    return { statusCode: 200, body: 'skipped - ServiceM8 API key not configured' };
  }
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  if (!vapidPublic || !vapidPrivate) {
    return { statusCode: 200, body: 'skipped - no VAPID keys configured' };
  }
  webpush.setVapidDetails('mailto:office@khgsecurity.com', vapidPublic, vapidPrivate);

  const headers = { 'X-Api-Key': apiKey, 'Accept': 'application/json' };

  try {
    const [jobsRes, activitiesRes, staffRes, companiesRes, catalog, subsMap, previous] = await Promise.all([
      fetch(`https://api.servicem8.com/api_1.0/job.json?%24filter=${encodeURIComponent('active eq 1')}`, { headers }),
      fetch('https://api.servicem8.com/api_1.0/jobactivity.json', { headers }),
      fetch('https://api.servicem8.com/api_1.0/staff.json', { headers }),
      fetch('https://api.servicem8.com/api_1.0/company.json', { headers }),
      firestoreGetDoc('shared/catalog'),
      firestoreGetDoc('shared/push-subscriptions'),
      firestoreGetDoc('shared/servicem8-known-assignments')
    ]);

    if (!jobsRes.ok || !activitiesRes.ok || !staffRes.ok || !companiesRes.ok) {
      return { statusCode: 502, body: JSON.stringify({ success: false, error: 'Could not fetch data from ServiceM8.' }) };
    }

    const jobs = await jobsRes.json();
    const activities = await activitiesRes.json();
    const staffList = await staffRes.json();
    const companies = await companiesRes.json();

    const jobMap = {};
    (Array.isArray(jobs) ? jobs : []).forEach(function (j) { jobMap[j.uuid] = j; });

    const staffMap = {};
    (Array.isArray(staffList) ? staffList : []).forEach(function (s) {
      staffMap[s.uuid] = `${s.first || ''} ${s.last || ''}`.trim();
    });

    const companyMap = {};
    (Array.isArray(companies) ? companies : []).forEach(function (co) { companyMap[co.uuid] = co.name || ''; });

    const engineers = (catalog && catalog.engineers) || [];
    const personIdByServicem8Name = {};
    engineers.forEach(function (e) {
      if (e.servicem8Name) personIdByServicem8Name[e.servicem8Name] = e.id;
    });

    // Build today's snapshot: one entry per (job, staff, day) currently on
    // the active schedule.
    const current = {}; // key -> { jobUuid, staffName, date }
    (Array.isArray(activities) ? activities : [])
      .filter(function (a) { return a.active !== 0 && a.active !== '0'; })
      .forEach(function (a) {
        if (!a.job_uuid || !a.staff_uuid || !a.start_date) return;
        const job = jobMap[a.job_uuid];
        if (!job) return; // job no longer active
        const staffName = staffMap[a.staff_uuid] || '';
        if (!staffName) return;
        const date = String(a.start_date).slice(0, 10);
        const key = a.job_uuid + '|' + a.staff_uuid + '|' + date;
        current[key] = { jobUuid: a.job_uuid, staffUuid: a.staff_uuid, staffName: staffName, date: date };
      });

    const previousKeys = (previous && previous.keys) || null;

    let sent = 0, failed = 0, notified = 0;

    if (previousKeys) {
      const newKeys = Object.keys(current).filter(function (k) { return !previousKeys[k]; });

      // Group new assignments by staff member so one engineer with several
      // new jobs gets a single, combined notification rather than a flood.
      const byStaff = {};
      newKeys.forEach(function (k) {
        const entry = current[k];
        if (!byStaff[entry.staffName]) byStaff[entry.staffName] = [];
        byStaff[entry.staffName].push(entry);
      });

      for (const staffName of Object.keys(byStaff)) {
        const personId = personIdByServicem8Name[staffName];
        if (!personId) continue; // no matching app user for this ServiceM8 staff member
        const subs = (subsMap && subsMap[personId]) || [];
        if (!subs.length) continue;

        const entries = byStaff[staffName];
        let title, body;
        if (entries.length === 1) {
          const e = entries[0];
          const job = jobMap[e.jobUuid];
          const jobNumber = job ? (job.generated_job_id || '') : '';
          const customerName = job ? (companyMap[job.company_uuid] || '') : '';
          const dateLabel = new Date(e.date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
          title = 'New job assigned';
          body = (jobNumber ? '#' + jobNumber + ' — ' : '') + (customerName || 'Job') + ' on ' + dateLabel;
        } else {
          title = 'New jobs assigned';
          body = entries.length + ' new jobs added to your schedule';
        }

        notified++;
        for (const sub of subs) {
          try {
            await webpush.sendNotification(sub, JSON.stringify({ title: title, body: body, url: '/' }));
            sent++;
          } catch (err) {
            failed++;
          }
        }
      }
    }

    // Save this run's snapshot for next time. Firestore documents have a
    // size limit, so this keeps only the small set of fields actually
    // needed for the diff, not the full job/activity payload.
    const keysToSave = {};
    Object.keys(current).forEach(function (k) { keysToSave[k] = 1; });
    await firestoreSetDoc('shared/servicem8-known-assignments', { keys: keysToSave, savedAt: new Date().toISOString() });

    return { statusCode: 200, body: JSON.stringify({ success: true, seeded: !previousKeys, notified, sent, failed }) };
  } catch (err) {
    console.error('servicem8-check-new-jobs error:', err);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: (err && err.message) || 'Unknown error' }) };
  }
};
