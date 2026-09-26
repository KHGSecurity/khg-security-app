// Fetches the customer/company list from ServiceM8 for the app's Customers
// section. The app overlays its own admin-editable fields (maintained status,
// renewal date, monitoring type) on top of this, stored in the app's own
// database — ServiceM8 itself isn't touched by those edits.
// The ServiceM8 API key lives only here, as a Netlify environment variable
// (SERVICEM8_API_KEY) — it never reaches the browser.

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

  const headers = {
    'X-Api-Key': apiKey,
    'Accept': 'application/json'
  };

  try {
    const companiesRes = await fetch('https://api.servicem8.com/api_1.0/company.json', { headers });
    if (!companiesRes.ok) {
      const detail = await companiesRes.text();
      return { statusCode: 502, body: JSON.stringify({ success: false, error: 'Could not fetch customers from ServiceM8.', detail }) };
    }
    const allCompanies = await companiesRes.json();
    const companies = Array.isArray(allCompanies) ? allCompanies : [];

    const simplified = companies
      .filter(function (co) { return co.active !== 0 && co.active !== '0'; })
      .map(function (co) {
        return {
          uuid: co.uuid,
          name: co.name || '(unnamed)',
          address: co.billing_address || co.address || '',
          email: co.email || '',
          phone: co.phone || co.mobile || ''
        };
      });

    return { statusCode: 200, body: JSON.stringify({ success: true, companies: simplified }) };
  } catch (err) {
    console.error('ServiceM8 companies list error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: (err && err.message) || 'Unknown error fetching customers.', detail: (err && err.stack) || String(err) })
    };
  }
};
