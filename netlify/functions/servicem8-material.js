// Looks up a ServiceM8 job by its job number, then adds a material line item to it.
// The ServiceM8 API key lives only here, as a Netlify environment variable
// (SERVICEM8_API_KEY) — it never reaches the browser.

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }

  const apiKey = process.env.SERVICEM8_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ success: false, error: 'ServiceM8 API key is not set up on the server yet.' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Invalid request body.' }) };
  }

  const jobNumber = String(payload.jobNumber || '').trim();
  const itemName = String(payload.itemName || '').trim();
  const quantity = Number(payload.quantity) || 0;

  if (!jobNumber || !itemName || !quantity) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Missing job number, item name, or quantity.' }) };
  }

  const headers = {
    'X-Api-Key': apiKey,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };

  try {
    // 1. Find the job by its job number
    const escapedJobNumber = jobNumber.replace(/'/g, "''");
    const filter = encodeURIComponent(`generated_job_id eq '${escapedJobNumber}'`);
    const jobLookupUrl = `https://api.servicem8.com/api_1.0/job.json?%24filter=${filter}`;
    const jobRes = await fetch(jobLookupUrl, { headers });

    if (!jobRes.ok) {
      const detail = await jobRes.text();
      return { statusCode: 502, body: JSON.stringify({ success: false, error: 'Could not reach ServiceM8 to look up the job.', detail }) };
    }

    const jobs = await jobRes.json();
    if (!Array.isArray(jobs) || jobs.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ success: false, error: `No ServiceM8 job found with job number "${jobNumber}".` }) };
    }
    const job = jobs[0];

    // 2. Add a material line item to that job
    const materialRes = await fetch('https://api.servicem8.com/api_1.0/jobmaterial.json', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        job_uuid: job.uuid,
        name: itemName,
        quantity: String(quantity)
      })
    });

    if (!materialRes.ok) {
      const detail = await materialRes.text();
      return { statusCode: 502, body: JSON.stringify({ success: false, error: 'ServiceM8 rejected the material line item.', detail }) };
    }

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error('ServiceM8 function error:', err);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: (err && err.message) || 'Unknown error contacting ServiceM8.', detail: (err && err.stack) || String(err) }) };
  }
};
