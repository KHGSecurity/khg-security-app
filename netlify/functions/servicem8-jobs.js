// Fetches jobs from ServiceM8 for display in the app's Jobs section, along
// with their scheduled dates (from Job Activity/booking records) so the app
// can show them on a calendar. Admins see every active job's schedule.
// Everyone else only sees jobs they're actually scheduled against, found via
// ServiceM8's Job Activity records for their matching staff member.
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

  const params = event.queryStringParameters || {};
  const isAdmin = params.admin === '1';
  const staffName = String(params.staffName || '').trim().toLowerCase();

  try {
    const jobsRes = await fetch(`https://api.servicem8.com/api_1.0/job.json?%24filter=${encodeURIComponent('active eq 1')}`, { headers });
    if (!jobsRes.ok) {
      const detail = await jobsRes.text();
      return { statusCode: 502, body: JSON.stringify({ success: false, error: 'Could not fetch jobs from ServiceM8.', detail }) };
    }
    const allJobs = await jobsRes.json();
    let jobs = Array.isArray(allJobs) ? allJobs : [];

    var activitiesUrl;
    if (isAdmin) {
      activitiesUrl = 'https://api.servicem8.com/api_1.0/jobactivity.json';
    } else {
      if (!staffName) {
        return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Missing staff name to look up.' }) };
      }
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
      const actFilter = encodeURIComponent(`staff_uuid eq '${staffMember.uuid}'`);
      activitiesUrl = `https://api.servicem8.com/api_1.0/jobactivity.json?%24filter=${actFilter}`;
    }

    const actRes = await fetch(activitiesUrl, { headers });
    if (!actRes.ok) {
      const detail = await actRes.text();
      return { statusCode: 502, body: JSON.stringify({ success: false, error: 'Could not fetch job activities from ServiceM8.', detail }) };
    }
    const activities = await actRes.json();
    const activeActivities = (Array.isArray(activities) ? activities : [])
      .filter(function (a) { return a.active !== 0 && a.active !== '0'; });

    const scheduleMap = {};
    activeActivities.forEach(function (a) {
      if (!a.job_uuid) return;
      if (!scheduleMap[a.job_uuid]) scheduleMap[a.job_uuid] = [];
      scheduleMap[a.job_uuid].push({ start: a.start_date || '', end: a.end_date || '' });
    });

    if (!isAdmin) {
      const myJobUuids = new Set(Object.keys(scheduleMap));
      jobs = jobs.filter(function (j) { return myJobUuids.has(j.uuid); });
    }

    const simplified = jobs.map(function (j) {
      return {
        uuid: j.uuid,
        jobNumber: j.generated_job_id || '',
        description: j.job_description || '',
        address: j.job_address || '',
        status: j.status || '',
        schedule: scheduleMap[j.uuid] || []
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
