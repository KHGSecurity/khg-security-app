// Sends a web push notification to one or more people, immediately.
// Reads their stored push subscriptions from Firestore (the same
// open-rules database the rest of the app already uses, via plain REST —
// no extra Firebase credential needed) and sends via the Web Push
// protocol using VAPID keys stored as Netlify environment variables.

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

exports.handler = async function (event) {
  if ((event.headers['x-app-secret'] || event.headers['X-App-Secret']) !== process.env.APP_SHARED_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ success: false, error: 'Unauthorized' }) };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }

  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  if (!vapidPublic || !vapidPrivate) {
    return { statusCode: 500, body: JSON.stringify({ success: false, error: 'VAPID keys are not set up on the server yet.' }) };
  }
  webpush.setVapidDetails('mailto:office@khgsecurity.com', vapidPublic, vapidPrivate);

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Invalid request body.' }) };
  }

  const toPersonIds = Array.isArray(payload.toPersonIds) ? payload.toPersonIds : [];
  const title = String(payload.title || 'KHG Security');
  const body = String(payload.body || '');
  const url = String(payload.url || '/');

  if (toPersonIds.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'No recipients specified.' }) };
  }

  try {
    const subsMap = (await firestoreGetDoc('shared/push-subscriptions')) || {};
    let sent = 0, failed = 0;

    for (const personId of toPersonIds) {
      const subs = subsMap[personId] || [];
      for (const sub of subs) {
        try {
          await webpush.sendNotification(sub, JSON.stringify({ title, body, url }));
          sent++;
        } catch (err) {
          failed++;
        }
      }
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, sent, failed }) };
  } catch (err) {
    console.error('send-push error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: (err && err.message) || 'Unknown error', detail: (err && err.stack) || String(err) })
    };
  }
};
