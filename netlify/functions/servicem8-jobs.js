// Fetches active jobs from ServiceM8 for display in the app's Jobs section.
// The ServiceM8 API key lives only here, as a Netlify environment variable
// (SERVICEM8_API_KEY) — it never reaches the browser.

exports.handler = async function (event) {
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
    const filter = encodeURIComponent('active eq 1');
    const url = `https://api.servicem8.com/api_1.0/job.json?%24filter=${filter}`;
    const res = await fetch(url, { headers });

    if (!res.ok) {
      const detail = await res.text();
      return { statusCode: 502, body: JSON.stringify({ success: false, error: 'Could not fetch jobs from ServiceM8.', detail }) };
    }

    const jobs = await res.json();
    const simplified = (Array.isArray(jobs) ? jobs : []).map(function (j) {
      return {
        uuid: j.uuid,
        jobNumber: j.generated_job_id || '',
        description: j.job_description || '',
        address: j.job_address || '',
        status: j.status || ''
      };
    });

    return { statusCode: 200, body: JSON.stringify({ success: true, jobs: simplified }) };
  } catch (err) {
    console.error('ServiceM8 jobs list error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: (err && err.message) || 'Unknown error fetching jobs.', detail: (err && err.stack) || String(err) })
    };
  }
};
