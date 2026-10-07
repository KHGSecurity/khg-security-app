// Fetches the materials / price list from ServiceM8 so an admin can rebuild
// or extend the app's stock catalogue from it (Stock -> Items -> Import items
// & stock -> "Pull from ServiceM8"). Read-only: nothing in ServiceM8 is changed.
// The ServiceM8 API key lives only here, as a Netlify environment variable
// (SERVICEM8_API_KEY) - it never reaches the browser.

exports.handler = async function (event) {
  if ((event.headers['x-app-secret'] || event.headers['X-App-Secret']) !== process.env.APP_SHARED_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ success: false, error: 'Unauthorized' }) };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }

  const apiKey = process.env.SERVICEM8_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ success: false, error: 'ServiceM8 API key is not set up on the server yet.' }) };
  }

  const headers = { 'X-Api-Key': apiKey, 'Accept': 'application/json' };

  try {
    const res = await fetch('https://api.servicem8.com/api_1.0/material.json', { headers });
    if (!res.ok) {
      const detail = await res.text();
      return { statusCode: 502, body: JSON.stringify({ success: false, error: 'Could not fetch materials from ServiceM8.', detail }) };
    }
    const all = await res.json();
    const list = Array.isArray(all) ? all : [];

    const seen = new Set();
    const materials = [];
    list
      .filter(function (m) { return m.active !== 0 && m.active !== '0'; })
      .forEach(function (m) {
        const name = String(m.name || '').trim();
        if (!name) return;
        const key = name.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        materials.push({
          name: name,
          itemNumber: String(m.item_number || '').trim(),
          barcode: String(m.barcode || '').trim()
        });
      });
    materials.sort(function (a, b) { return a.name.localeCompare(b.name); });

    return { statusCode: 200, body: JSON.stringify({ success: true, materials: materials }) };
  } catch (err) {
    console.error('ServiceM8 materials list error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: (err && err.message) || 'Unknown error fetching materials.', detail: (err && err.stack) || String(err) })
    };
  }
};
