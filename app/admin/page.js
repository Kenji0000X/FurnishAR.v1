import AdminApplications from './AdminApplications.js';

export const metadata = {
  title: 'Store applications',
  robots: { index: false, follow: false }
};

export default function AdminPage() {
  return (
    <section className="view admin-view active" aria-labelledby="admin-title">
      <section className="admin-intro">
        <p className="eyebrow">FurnishAR administration</p>
        <h1 id="admin-title">Store applications</h1>
        <p>Review incoming furniture shops and approve the stores ready to join the catalogue.</p>
      </section>
      <AdminApplications />
    </section>
  );
}
