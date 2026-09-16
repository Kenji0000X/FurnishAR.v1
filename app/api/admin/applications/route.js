import admin from '../../../../lib/admin-applications.js';

export const dynamic = 'force-dynamic';

function json(status, body) {
  return Response.json(body, { status });
}

async function handle(request) {
  try {
    const { adminToken } = admin.config();
    if (!admin.authorized(request, adminToken)) return json(401, { error: 'Admin authorization required.' });

    if (request.method === 'GET') return json(200, { applications: await admin.listApplications() });

    if (request.method === 'POST') {
      const payload = await request.json().catch(() => ({}));
      if (!payload.id || !['approve', 'reject'].includes(payload.action)) {
        return json(400, { error: 'Provide an application id and approve or reject action.' });
      }
      const result = payload.action === 'approve'
        ? await admin.approveApplication(payload.id)
        : await admin.rejectApplication(payload.id, payload.reviewNote);
      return json(200, result);
    }

    return json(405, { error: 'Method not allowed.' });
  } catch (error) {
    console.error('[admin applications]', error);
    const status = /requires|missing:|not configured|must be|authorization/i.test(error.message) ? 503 : 400;
    return json(status, { error: error.message || 'Could not process the application.' });
  }
}

export const GET = handle;
export const POST = handle;
