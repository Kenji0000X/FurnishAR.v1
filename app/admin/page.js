'use client';

import Link from 'next/link';
import { ArrowRight, ArrowUpRight } from '@phosphor-icons/react/dist/ssr';
import { useAdmin } from './AdminGate.js';
import { StoresByPlan, StorageByStore, ListingsReady } from './AdminCharts.js';
import { ConsoleHeader, ConsoleSection, ConsoleCta } from '../console/ConsoleShell.js';
import { formatBytes, timeAgo } from './format.js';

/**
 * The overview: what the platform looks like in one screen.
 *
 * A review-queue tile first, because it is the one figure that means someone
 * is waiting on the operator; then four counts, three charts and the latest
 * decisions. All of it is read from the same arrays the section pages render
 * row by row. If a tile could not be grounded in a real query it is not on
 * this page.
 *
 * The activity list is live in the sense that matters: it shows the most
 * recent recorded decisions, refreshed when the console reloads after an
 * approval or rejection. It does not pretend to stream.
 */
export default function AdminOverview() {
  const { applications, stores, models, missingModels, usage, audit } = useAdmin();

  const queue = applications.filter(a => a.status === 'pending')
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const pending = queue.length;
  const totalBytes = models.reduce((sum, asset) => sum + (Number(asset.byte_size) || 0), 0);
  const withModel = new Set(models.map(a => a.product?.id).filter(Boolean)).size;
  const listings = withModel + missingModels.length;
  const activeStores = stores.filter(s => s.status !== 'suspended').length;

  const tiles = [
    ['Stores', stores.length, activeStores === stores.length ? 'All active' : `${activeStores} active`],
    ['Listings', listings, listings ? `${withModel} ready for AR` : 'None yet'],
    ['3D Files', models.length, 'Uploaded by stores'],
    ['Storage', formatBytes(totalBytes), 'Across every store']
  ];

  return (
    <>
      {/* The decision comes first: the queue is the hero tile directly under
          the title, with its own action. The header used to lead with a
          sentence about how the figures are counted and a second, duplicate
          "Review Applications" button, which pushed the queue down a screen. */}
      <ConsoleHeader eyebrow="Platform Administration" title="Overview">
        <p>{pending
          ? `${pending} ${pending === 1 ? 'application needs' : 'applications need'} a decision.`
          : 'Nothing is waiting for a decision.'}</p>
      </ConsoleHeader>

      <ul className="console-bento" aria-label="Platform at a glance">
        <li className="console-tile is-hero bezel">
          <div className="bezel-core">
            <p className="console-tile-label">Review Queue</p>
            <p className="console-tile-value">
              {pending}<small>&nbsp;{pending === 1 ? 'application' : 'applications'}</small>
            </p>
            {pending ? (
              <ul className="console-list" aria-label="Oldest first">
                {queue.slice(0, 3).map(application => (
                  <li key={application.id}>
                    <span className="console-list-name">{application.store_name}</span>
                    <small>{timeAgo(application.created_at)}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="console-tile-note">Nobody is waiting. New applications from store owners land here first.</p>
            )}
            <div className="console-tile-actions">
              <ConsoleCta href="/admin/applications" icon={ArrowRight} className={pending ? undefined : 'is-quiet'}>
                {pending ? 'Review Applications' : 'See Past Applications'}
              </ConsoleCta>
            </div>
          </div>
        </li>
        {tiles.map(([label, value, note]) => (
          <li key={label} className="console-tile bezel">
            <div className="bezel-core">
              <p className="console-tile-label">{label}</p>
              <p className="console-tile-value">{value}</p>
              <p className="console-tile-note">{note}</p>
            </div>
          </li>
        ))}
      </ul>

      <ConsoleSection id="charts" title="Platform Health"
        note="Counted from the platform’s own records; a figure that can’t be counted isn’t shown. Each chart has a table view with the same numbers.">
        <div className="chart-grid">
          <StoresByPlan stores={stores} />
          <ListingsReady models={models} missingModels={missingModels} />
          <StorageByStore usage={usage} />
        </div>
      </ConsoleSection>

      <ConsoleSection
        id="activity"
        title="Latest Activity"
        note="Every decision, recorded."
        action={<ConsoleCta href="/admin/activity" icon={ArrowUpRight} className="is-quiet">See All Activity</ConsoleCta>}
      >
        <div className="bezel console-panel">
          <div className="bezel-core">
            {/* A live region: when an approval lands, a screen reader hears the
                new entry rather than finding it on a later visit. Polite,
                because it is news, not an alert. */}
            <ul className="activity-rail" aria-live="polite">
              {audit.length ? audit.slice(0, 6).map(entry => (
                <li key={entry.id}>
                  <span className="activity-dot" aria-hidden="true" />
                  <div>
                    <p>
                      <b>{entry.action.replace('application.', '').replace('.', ' ')}</b>
                      {entry.detail?.store_name ? <> &mdash; <span translate="no">{entry.detail.store_name}</span></> : ''}
                    </p>
                    <small><span translate="no">{entry.actor_email || '—'}</span> · {timeAgo(entry.at)}</small>
                  </div>
                </li>
              )) : (
                <li className="console-empty">
                  <p>No decisions recorded yet. Approvals, rejections and fee settlements show up here.</p>
                  <Link href="/admin/applications">Go to Applications</Link>
                </li>
              )}
            </ul>
          </div>
        </div>
      </ConsoleSection>
    </>
  );
}
