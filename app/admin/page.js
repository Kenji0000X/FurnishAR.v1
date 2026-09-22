'use client';

import Link from 'next/link';
import { useAdmin } from './AdminGate.js';
import { StoresByPlan, StorageByStore, ListingsReady } from './AdminCharts.js';
import { formatBytes, timeAgo } from './format.js';

/**
 * The overview: what the platform looks like in one screen.
 *
 * Five tiles and three charts, all read from the same arrays the section
 * pages render row by row. Nothing here is computed from anything the console
 * did not fetch — if a tile could not be grounded in a real query it is not
 * on this page.
 *
 * The activity rail is live in the sense that matters: it shows the most
 * recent recorded decisions, refreshed when the console reloads after an
 * approval or rejection. It does not pretend to stream.
 */
export default function AdminOverview() {
  const { applications, stores, models, missingModels, usage, audit } = useAdmin();

  const pending = applications.filter(a => a.status === 'pending').length;
  const totalBytes = models.reduce((sum, asset) => sum + (Number(asset.byte_size) || 0), 0);
  const listings = new Set(models.map(a => a.product?.id).filter(Boolean)).size + missingModels.length;

  /* Short notes on purpose. These are flash cards, sized to what is written
     on them, so "across every store" and "against your plan" were making two
     cards half again as wide as the rest to say something the section pages
     already say at length. One word each. */
  const tiles = [
    ['Stores', stores.length, 'registered'],
    ['Listings', listings, 'listed'],
    ['3D files', models.length, 'uploaded'],
    ['Storage', formatBytes(totalBytes), 'stored'],
    /* "Queue", not "Awaiting review": a two-word label was the one thing on
       the row forcing its card wider than the rest, to say what the
       Applications badge beside it already says. */
    ['Queue', pending, pending ? 'waiting' : 'clear']
  ];

  return (
    <>
      <section className="admin-intro">
        <p className="eyebrow">Platform administration</p>
        <h1 id="console-title">Overview</h1>
        <p>
          Everything on this page is counted from the platform&rsquo;s own records. A figure
          that could not be counted is not shown.
        </p>
      </section>

      <ul className="kpi-row">
        {tiles.map(([label, value, note]) => (
          <li key={label} className="kpi-tile">
            <p className="kpi-label">{label}</p>
            {/* The number is the point, so it is the biggest thing in the
                tile and carries no colour of its own. */}
            <b className="kpi-value">{value}</b>
            <small>{note}</small>
          </li>
        ))}
      </ul>

      <div className="chart-grid">
        <StoresByPlan stores={stores} />
        <ListingsReady models={models} missingModels={missingModels} />
        <StorageByStore usage={usage} />
      </div>

      <section className="plan-section" aria-labelledby="rail-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Every decision, recorded</p>
            <h2 id="rail-title">Latest activity</h2>
          </div>
          <Link className="button button-outline" href="/admin/activity">See all</Link>
        </div>

        {/* A live region: when an approval lands, a screen reader hears the
            new entry rather than finding it on a later visit. Polite, because
            it is news, not an alert. */}
        <ul className="activity-rail" aria-live="polite">
          {audit.length ? audit.slice(0, 6).map(entry => (
            <li key={entry.id}>
              <span className="activity-dot" aria-hidden="true" />
              <div>
                <p>
                  <b>{entry.action.replace('application.', '')}</b>
                  {entry.detail?.store_name ? ` — ${entry.detail.store_name}` : ''}
                </p>
                <small>{entry.actor_email || '—'} · {timeAgo(entry.at)}</small>
              </div>
            </li>
          )) : <li className="card-copy">No decisions recorded yet.</li>}
        </ul>
      </section>
    </>
  );
}
