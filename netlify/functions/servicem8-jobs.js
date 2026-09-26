// Fetches jobs from ServiceM8 for display in the app's Jobs section, and to
// power the "attach to a ServiceM8 job" picker used when completing forms.
// Returns every active job to every logged-in user (this is an internal
// company tool — there's no customer-facing exposure), each carrying its
// full schedule (who's booked on it and when, across all staff) and its
// customer/company name, so the app can prioritise "my jobs today" while
// still letting anyone search any other job or customer.
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
    const [jobsRes, activitiesRes, staffRes, companiesRes] = await Promise.all([
      fetch(`https://api.servicem8.com/api_1.0/job.json?%24filter=${encodeURIComponent('active eq 1')}`, { headers }),
      fetch('https://api.servicem8.com/api_1.0/jobactivity.json', { headers }),
      fetch('https://api.servicem8.com/api_1.0/staff.json', { headers }),
      fetch('https://api.servicem8.com/api_1.0/company.json', { headers })
    ]);

    if (!jobsRes.ok) {
      const detail = await jobsRes.text();
      return { statusCode: 502, body: JSON.stringify({ success: false, error: 'Could not fetch jobs from ServiceM8.', detail }) };
    }
    if (!activitiesRes.ok) {
      const detail = await activitiesRes.text();
      return { statusCode: 502, body: JSON.stringify({ success: false, error: 'Could not fetch job activities from ServiceM8.', detail }) };
    }
    if (!staffRes.ok) {
      const detail = await staffRes.text();
      return { statusCode: 502, body: JSON.stringify({ success: false, error: 'Could not fetch staff list from ServiceM8.', detail }) };
    }
    if (!companiesRes.ok) {
      const detail = await companiesRes.text();
      return { statusCode: 502, body: JSON.stringify({ success: false, error: 'Could not fetch customer list from ServiceM8.', detail }) };
    }

    const allJobs = await jobsRes.json();
    const activities = await activitiesRes.json();
    const staffList = await staffRes.json();
    const companies = await companiesRes.json();

    const jobs = Array.isArray(allJobs) ? allJobs : [];

    const staffMap = {};
    (Array.isArray(staffList) ? staffList : []).forEach(function (s) {
      staffMap[s.uuid] = `${s.first || ''} ${s.last || ''}`.trim();
    });

    const companyMap = {};
    (Array.isArray(companies) ? companies : []).forEach(function (co) {
      companyMap[co.uuid] = co.name || '';
    });

    const activeActivities = (Array.isArray(activities) ? activities : [])
      .filter(function (a) { return a.active !== 0 && a.active !== '0'; });

    const scheduleMap = {};
    activeActivities.forEach(function (a) {
      if (!a.job_uuid) return;
      if (!scheduleMap[a.job_uuid]) scheduleMap[a.job_uuid] = [];
      scheduleMap[a.job_uuid].push({
        start: a.start_date || '',
        end: a.end_date || '',
        staffName: staffMap[a.staff_uuid] || ''
      });
    });

    const simplified = jobs.map(function (j) {
      return {
        uuid: j.uuid,
        jobNumber: j.generated_job_id || '',
        description: j.job_description || '',
        address: j.job_address || '',
        status: j.status || '',
        companyUuid: j.company_uuid || '',
        companyName: companyMap[j.company_uuid] || '',
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
