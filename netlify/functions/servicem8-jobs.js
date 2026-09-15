// Fetches jobs from ServiceM8 for display in the app's Jobs section.
// Admins see every active job. Everyone else only sees jobs they're actually
// scheduled against, found via ServiceM8's Job Activity (booking) records.
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

  const params = event.queryStringParameters || {};
  const isAdmin = params.admin === '1';
  const staffName = String(params.staffName || '').trim().toLowerCase();

  try {
    // Always need the active jobs list — either to return directly (admin) or to filter against (non-admin)
    const jobsRes = await fetch(`https://api.servicem8.com/api_1.0/job.json?%24filter=${encodeURIComponent('active eq 1')}`, { headers });
    if (!jobsRes.ok) {
      const detail = await jobsRes.text();
      return { statusCode: 502, body: JSON.stringify({ success: false, error: 'Could not fetch jobs from ServiceM8.', detail }) };
    }
    const allJobs = await jobsRes.json();

    let jobs = Array.isArray(allJobs) ? allJobs : [];

    if (!isAdmin) {
      if (!staffName) {
        return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Missing staff name to look up.' }) };
      }

      // 1. Find this person's ServiceM8 staff record by name
      const staffRes = await fetch('https://api.servicem8.com/api_1.0/staff.json', { headers });
      if (!staffRes.ok) {
        const detail = await staffRes.text();
        return { statusCode: 502, body: JSON.stringify({ success: false, error: 'Could not fetch staff list from ServiceM8.', detail }) };
      }
      const staffList = await staffRes.json();
      const staffMember = (Array.isArray(staffList) ? staffList : []).find(function (s) {
        const full = `${s.first || ''} ${s.last || ''}`.trim().toLowerCase();
        return full === staffName;
      });
      if (!staffMember) {
        return { statusCode: 404, body: JSON.stringify({ success: false, error: `No ServiceM8 staff member found matching the name "${params.staffName}". Names must match exactly.` }) };
      }

      // 2. Find job activities (bookings) assigned to that staff member
      const actFilter = encodeURIComponent(`staff_uuid eq '${staffMember.uuid}'`);
      const actRes = await fetch(`https://api.servicem8.com/api_1.0/jobactivity.json?%24filter=${actFilter}`, { headers });
      if (!actRes.ok) {
        const detail = await actRes.text();
        return { statusCode: 502, body: JSON.stringify({ success: false, error: 'Could not fetch job activities from ServiceM8.', detail }) };
      }
      const activities = await actRes.json();
      const myJobUuids = new Set((Array.isArray(activities) ? activities : [])
        .filter(function (a) { return a.active !== 0 && a.active !== '0'; })
        .map(function (a) { return a.job_uuid; }));

      jobs = jobs.filter(function (j) { return myJobUuids.has(j.uuid); });
    }

    const simplified = jobs.map(function (j) {
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
