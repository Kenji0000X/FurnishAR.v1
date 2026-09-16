const crypto = require('node:crypto');

function config() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const adminToken = process.env.FURNISHAR_ADMIN_TOKEN || '';
  if (!url || !key || !adminToken) {
    throw new Error('Admin approval requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and FURNISHAR_ADMIN_TOKEN.');
  }
  if (/^sb_publishable_|^sb_secret_/i.test(key)) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY must be a service-role key kept only on the server.');
  }
  return { url, key, adminToken };
}

function authorized(request, adminToken) {
  const header = request.headers.get('authorization') || '';
  const supplied = header.match(/^Bearer\s+(.+)$/i)?.[1] || '';
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(adminToken);
  return suppliedBytes.length === expectedBytes.length &&
    suppliedBytes.length > 0 && crypto.timingSafeEqual(suppliedBytes, expectedBytes);
}

async function supabaseRequest(path, options = {}) {
  const { url, key } = config();
  const response = await fetch(`${url}${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    throw new Error(body?.message || body?.msg || body?.error || `Supabase request failed (${response.status}).`);
  }
  return body;
}

function slugify(value) {
  const slug = String(value || '').toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);
  return slug || `store-${crypto.randomUUID().slice(0, 8)}`;
}

async function listApplications() {
  const applications = await supabaseRequest('/rest/v1/store_applications?select=id,store_name,contact_email,contact_phone,message,status,created_at&status=eq.pending&order=created_at.asc');
  const users = await supabaseRequest('/auth/v1/admin/users?per_page=1000');
  const byEmail = new Map((users?.users || []).map(user => [String(user.email || '').toLowerCase(), user]));
  return applications.map(application => {
    const user = byEmail.get(String(application.contact_email).toLowerCase());
    return {
      ...application,
      account: user
        ? {
            found: true,
            emailConfirmed: Boolean(user.email_confirmed_at),
            emailConfirmedAt: user.email_confirmed_at || null,
            lastSignInAt: user.last_sign_in_at || null,
            disabled: Boolean(user.banned_until && new Date(user.banned_until) > new Date())
          }
        : { found: false, emailConfirmed: false, emailConfirmedAt: null, lastSignInAt: null, disabled: false }
    };
  });
}

async function findAuthUser(email) {
  const users = await supabaseRequest('/auth/v1/admin/users?per_page=1000');
  return (users?.users || []).find(user => String(user.email || '').toLowerCase() === String(email).toLowerCase());
}

async function approveApplication(id) {
  const applications = await supabaseRequest(`/rest/v1/store_applications?id=eq.${encodeURIComponent(id)}&select=*`);
  const application = applications?.[0];
  if (!application) throw new Error('Application not found or it is no longer pending.');
  if (application.status !== 'pending') throw new Error('This application has already been reviewed.');

  const user = await findAuthUser(application.contact_email);
  if (!user) throw new Error('The applicant Auth account was not found. Ask them to sign up again after confirming their email.');
  if (!user.email_confirmed_at) throw new Error('Verify the applicant email before approving this store.');
  if (user.banned_until && new Date(user.banned_until) > new Date()) throw new Error('This applicant account is disabled.');

  const store = (await supabaseRequest('/rest/v1/stores', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ slug: slugify(application.store_name), name: application.store_name, contact_number: application.contact_phone || null })
  }))[0];

  try {
    await supabaseRequest('/rest/v1/store_members', {
      method: 'POST',
      body: JSON.stringify({ store_id: store.id, user_id: user.id, role: 'owner' })
    });
    await supabaseRequest(`/rest/v1/store_applications?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'approved', approved_store_id: store.id, reviewed_at: new Date().toISOString() })
    });
  } catch (error) {
    await supabaseRequest(`/rest/v1/stores?id=eq.${encodeURIComponent(store.id)}`, { method: 'DELETE' }).catch(() => {});
    throw error;
  }
  return { application, store, user: { id: user.id, email: user.email } };
}

async function rejectApplication(id, reviewNote = '') {
  const rows = await supabaseRequest(`/rest/v1/store_applications?id=eq.${encodeURIComponent(id)}&status=eq.pending&select=id`);
  if (!rows?.length) throw new Error('Application not found or it is no longer pending.');
  await supabaseRequest(`/rest/v1/store_applications?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'rejected', review_note: String(reviewNote).slice(0, 1000), reviewed_at: new Date().toISOString() })
  });
  return { id };
}

module.exports = { config, authorized, listApplications, approveApplication, rejectApplication };
