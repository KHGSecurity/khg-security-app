// Looks up a ServiceM8 job by its job number, then uploads a PDF as an
// Attachment on that job (so it shows up alongside photos/documents on the
// job and its customer in ServiceM8 — not just as a text Note).
// The ServiceM8 API key lives only here, as a Netlify environment variable
// (SERVICEM8_API_KEY) — it never reaches the browser.
//
// ServiceM8's attachment upload is two steps:
//   1. POST attachment.json to create the attachment record (metadata only).
//      The new record's UUID comes back in the `x-record-uuid` response header.
//   2. POST the raw file bytes to attachment/{uuid}.file to fill it in.

exports.handler = async function (event) {
  if ((event.headers['x-app-secret'] || event.headers['X-App-Secret']) !== process.env.APP_SHARED_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ success: false, error: 'Unauthorized' }) };
  }
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
  const fileName = String(payload.fileName || 'document.pdf').trim();
  const fileBase64 = String(payload.fileBase64 || '');

  if (!jobNumber || !fileBase64) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Missing job number or file data.' }) };
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

    // 2. Create the attachment record
    const createRes = await fetch('https://api.servicem8.com/api_1.0/attachment.json', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        related_object: 'job',
        related_object_uuid: job.uuid,
        attachment_name: fileName,
        file_type: '.pdf',
        active: 1
      })
    });

    if (!createRes.ok) {
      const detail = await createRes.text();
      return { statusCode: 502, body: JSON.stringify({ success: false, error: 'ServiceM8 rejected the attachment record.', detail }) };
    }

    const attachmentUuid = createRes.headers.get('x-record-uuid');
    if (!attachmentUuid) {
      return { statusCode: 502, body: JSON.stringify({ success: false, error: 'ServiceM8 did not return a UUID for the new attachment.' }) };
    }

    // 3. Upload the actual PDF bytes to that attachment record
    const fileBuffer = Buffer.from(fileBase64, 'base64');
    const uploadRes = await fetch(`https://api.servicem8.com/api_1.0/attachment/${attachmentUuid}.file`, {
      method: 'POST',
      headers: {
        'X-Api-Key': apiKey,
        'Content-Type': 'application/pdf'
      },
      body: fileBuffer
    });

    if (!uploadRes.ok) {
      const detail = await uploadRes.text();
      return { statusCode: 502, body: JSON.stringify({ success: false, error: 'ServiceM8 rejected the PDF upload.', detail }) };
    }

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error('ServiceM8 attachment function error:', err);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: (err && err.message) || 'Unknown error contacting ServiceM8.', detail: (err && err.stack) || String(err) }) };
  }
};
