// Daily safety copy of every shared data set (people, items, stock, history,
// leave, mileage, vehicles, forms ...), kept for 30 days. If anything is ever
// wiped or reset by mistake, an admin can restore from any of these days
// inside the app (Stock -> Items -> Backup & restore). Runs once a day at
// 02:00 UTC (see netlify.toml).
//
// Backups are stored in the same "shared" collection as everything else, in
// documents whose ids start with "bk__" (that is the only collection the
// database rules allow writing to).

const FIREBASE_PROJECT_ID = 'van-stock-app-ccd8c';
const BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const RETENTION_DAYS = 30;
// Push subscriptions are device tokens, not business data - not worth copying.
const SKIP_KEYS = ['push-subscriptions'];

async function listAll(collection) {
  const docs = [];
  let token = '';
  do {
    const url = `${BASE}/${collection}?pageSize=300${token ? '&pageToken=' + encodeURIComponent(token) : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`List failed (${collection}): ${res.status}`);
    const json = await res.json();
    (json.documents || []).forEach((d) => docs.push(d));
    token = json.nextPageToken || '';
  } while (token);
  return docs;
}

function lastSegment(name) {
  return name.split('/').pop();
}

exports.handler = async function () {
  try {
    const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const savedAt = new Date().toISOString();

    const shared = await listAll('shared');
    let saved = 0;
    for (const d of shared) {
      const key = decodeURIComponent(lastSegment(d.name));
      if (key.startsWith('bk__') || SKIP_KEYS.includes(key)) continue;
      const value = d.fields && d.fields.value && d.fields.value.stringValue;
      if (value == null) continue;
      const url = `${BASE}/shared/${encodeURIComponent('bk__' + stamp + '__' + key)}`;
      const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            bkKey: { stringValue: key },
            bkStamp: { stringValue: stamp },
            savedAt: { stringValue: savedAt },
            value: { stringValue: value }
          }
        })
      });
      if (!res.ok) throw new Error(`Backup write failed (${key}): ${res.status}`);
      saved++;
    }

    // Prune dated backups older than the retention window.
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
    let pruned = 0;
    for (const d of shared) {
      const id = decodeURIComponent(lastSegment(d.name));
      if (!id.startsWith('bk__')) continue;
      const prefix = id.slice(4, 14);
      if (/^\d{4}-\d{2}-\d{2}$/.test(prefix) && prefix < cutoff) {
        const res = await fetch(`${BASE}/shared/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (res.ok) pruned++;
      }
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, stamp, saved, pruned }) };
  } catch (err) {
    console.error('backup-data error:', err);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: (err && err.message) || 'Unknown error' }) };
  }
};
