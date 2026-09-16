'use client';

import { useEffect, useState } from 'react';

function readToken() {
  try { return sessionStorage.getItem('furnishar-admin-token') || ''; } catch { return ''; }
}

export default function AdminApplications() {
  const [token, setToken] = useState('');
  const [applications, setApplications] = useState([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function request(path = '', options = {}) {
    const response = await fetch(`/api/admin/applications${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
    return body;
  }

  async function load() {
    setMessage('');
    try {
      const result = await request();
      setApplications(result.applications || []);
      sessionStorage.setItem('furnishar-admin-token', token);
    } catch (error) { setMessage(error.message); }
  }

  useEffect(() => { setToken(readToken()); }, []);

  async function review(application, action) {
    setBusy(true);
    setMessage('');
    try {
      await request('', { method: 'POST', body: JSON.stringify({ id: application.id, action }) });
      setApplications(current => current.filter(item => item.id !== application.id));
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  if (!token || !applications.length && !message) {
    return (
      <section className="admin-tool">
        <h2>Administrator access</h2>
        <p className="card-copy">Enter the private admin token configured on the server.</p>
        <form className="login-form" onSubmit={event => { event.preventDefault(); load(); }}>
          <label>Admin token<input type="password" value={token} onChange={event => setToken(event.target.value)} required autoComplete="off" /></label>
          <button className="button button-primary" type="submit">Open applications</button>
          <p className="form-error" role="alert">{message}</p>
        </form>
      </section>
    );
  }

  return (
    <section className="admin-tool">
      <div className="dashboard-top"><div><p className="eyebrow">Pending review</p><h2>{applications.length} application{applications.length === 1 ? '' : 's'}</h2></div><button className="button button-outline" type="button" onClick={load}>Refresh</button></div>
      {message && <p className="form-error" role="alert">{message}</p>}
      {!applications.length && <p className="card-copy">No pending store applications.</p>}
      <div className="application-list">
        {applications.map(application => (
          <article className="application-item" key={application.id}>
            <div><p className="eyebrow">{new Date(application.created_at).toLocaleDateString()}</p><h3>{application.store_name}</h3><p>{application.contact_email} · {application.contact_phone || 'No phone provided'}</p>{application.message && <p>{application.message}</p>}</div>
            <div className="application-actions"><button className="button button-primary" type="button" disabled={busy} onClick={() => review(application, 'approve')}>Approve</button><button className="button button-outline" type="button" disabled={busy} onClick={() => review(application, 'reject')}>Reject</button></div>
          </article>
        ))}
      </div>
    </section>
  );
}
