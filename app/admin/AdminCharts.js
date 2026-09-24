'use client';

import { useId, useState } from 'react';
import { formatBytes } from './format.js';

/**
 * Three charts, drawn from what the console already loaded.
 *
 * Every number here comes from the same arrays the tables below render. That
 * is the whole rule for this file: a dashboard is the easiest thing in a thesis
 * project to fake, and a chart with plausible invented bars would look more
 * finished than the truth — five stores, four listings, three models — while
 * telling the operator something that is not so. If a query returns nothing,
 * the chart says there is nothing rather than drawing a shape.
 *
 * Plain SVG, no chart library: three small charts do not justify shipping a
 * plotting runtime to a console that four people will open.
 *
 * Colour: slots 1-3 of the validated categorical palette, in fixed order,
 * never cycled. Validated with the dataviz validator in both modes —
 *   light #2a78d6,#eb6834,#1baf7a  worst all-pairs CVD ΔE 9.2, normal 24.0
 *   dark  #3987e5,#d95926,#199e70  worst all-pairs CVD ΔE 9.4, normal 20.9
 * Light-mode aqua sits below 3:1 on the light surface, which under the relief
 * rule obliges visible labels — so every segment is directly labelled and each
 * chart carries a table view. That is not decoration; it is the condition on
 * using that step at all.
 */

const EMPTY = 'Nothing to chart yet.';

/** A count and its label, sharing one horizontal scale. */
function BarRows({ rows, slot, format = v => String(v) }) {
  const max = Math.max(...rows.map(r => r.value), 1);
  return (
    <ul className="chart-bars">
      {rows.map(row => (
        <li key={row.label}>
          <span className="chart-bar-label">{row.label}</span>
          <span className="chart-bar-track">
            <span
              className="chart-bar-fill"
              style={{
                width: `${Math.max((row.value / max) * 100, row.value > 0 ? 2 : 0)}%`,
                background: `var(--series-${slot})`
              }}
            />
          </span>
          {/* Direct label on every bar. Never a legend for a single series —
              the chart's own title names it. */}
          <b className="chart-bar-value">{format(row.value)}</b>
        </li>
      ))}
    </ul>
  );
}

/**
 * A chart and the table that says the same thing.
 *
 * The table is not a fallback for a broken chart — it is the accessible
 * reading of the same numbers, and the relief the colour validation requires.
 */
function Figure({ title, note, rows, format, children }) {
  const [asTable, setAsTable] = useState(false);
  const id = useId();

  return (
    <figure className="chart-card">
      <figcaption>
        <div>
          <h3 id={id}>{title}</h3>
          {note && <p>{note}</p>}
        </div>
        <button
          type="button"
          className="chart-toggle"
          aria-pressed={asTable}
          onClick={() => setAsTable(value => !value)}
        >
          {asTable ? 'Chart' : 'Table'}
        </button>
      </figcaption>

      {rows.length === 0 ? (
        <p className="card-copy chart-empty">{EMPTY}</p>
      ) : asTable ? (
        <table className="chart-table">
          <caption className="sr-only">{title}</caption>
          <tbody>
            {rows.map(row => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{format ? format(row.value) : row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : children}
    </figure>
  );
}

/**
 * Stores by plan.
 *
 * Plan is an identity, not a magnitude, so the bars wear categorical hues in
 * the palette's fixed order — Premium always slot 1, Freemium always slot 2,
 * whichever happens to be larger. Colour follows the entity, never its rank.
 */
export function StoresByPlan({ stores }) {
  const order = ['Premium', 'Freemium'];
  const counts = new Map(order.map(plan => [plan, 0]));
  for (const store of stores) {
    /* The database stores plans lowercase ('premium'); the chart's fixed
       order is Title Case. Normalise before counting, or every store lands in
       a second, unlabelled-looking bar of its own. */
    const raw = String(store.plan || 'freemium').trim().toLowerCase();
    const plan = raw.charAt(0).toUpperCase() + raw.slice(1);
    counts.set(plan, (counts.get(plan) || 0) + 1);
  }
  const rows = [...counts].map(([label, value]) => ({ label, value }))
    .filter(row => row.value > 0 || order.includes(row.label));

  return (
    <Figure title="Stores by Plan" note={`${stores.length} registered`} rows={rows}>
      <ul className="chart-bars">
        {rows.map((row, index) => (
          <li key={row.label}>
            <span className="chart-bar-label">{row.label}</span>
            <span className="chart-bar-track">
              <span
                className="chart-bar-fill"
                style={{
                  width: `${Math.max((row.value / Math.max(...rows.map(r => r.value), 1)) * 100, row.value > 0 ? 2 : 0)}%`,
                  background: `var(--series-${index + 1})`
                }}
              />
            </span>
            <b className="chart-bar-value">{row.value}</b>
          </li>
        ))}
      </ul>
    </Figure>
  );
}

/**
 * Storage used, by store.
 *
 * One series — how much of the storage plan each shop is spending — so one
 * hue and no legend. Sorted largest first, because the question this answers
 * is "who is using it up", and an alphabetical answer to that is no answer.
 */
export function StorageByStore({ usage }) {
  const rows = [...usage]
    .map(row => ({ label: row.store_name || '—', value: Number(row.total_bytes) || 0 }))
    .sort((a, b) => b.value - a.value);

  const total = rows.reduce((sum, row) => sum + row.value, 0);

  return (
    <Figure
      title="Storage Used by Store"
      note={`${formatBytes(total)} across the platform`}
      rows={rows}
      format={formatBytes}
    >
      <BarRows rows={rows} slot={3} format={formatBytes} />
    </Figure>
  );
}

/**
 * How much of the catalogue can actually be placed in a room.
 *
 * This is the platform's one real health number. A listing with no 3D model
 * is a product a shopper can read about and cannot stand in their living
 * room, which is the entire promise of the site — so it is worth a chart
 * rather than a row in a table.
 *
 * Two parts of one whole, so one stacked bar rather than two: the comparison
 * that matters is the share, not the pair of counts. The 2px gap between the
 * segments is a surface-coloured spacer, not a border — a border would add
 * width and put the segments' edges half a pixel out.
 */
export function ListingsReady({ models, missingModels }) {
  const withModel = new Set(models.map(asset => asset.product?.id).filter(Boolean)).size;
  const without = missingModels.length;
  const total = withModel + without;

  const rows = [
    { label: 'Ready for AR', value: withModel },
    { label: 'No 3D Model', value: without }
  ];

  return (
    <Figure
      title="Listings Ready for AR"
      note={total ? `${Math.round((withModel / total) * 100)}% of ${total} listings can be placed in a room` : null}
      rows={total ? rows : []}
      format={v => String(v)}
    >
      <>
        <div className="chart-stack" role="img"
          aria-label={`${withModel} of ${total} listings ready for AR, ${without} without a 3D model`}>
          {rows.map((row, index) => row.value > 0 && (
            <span
              key={row.label}
              className="chart-stack-part"
              style={{
                flexGrow: row.value,
                background: `var(--series-${index === 0 ? 3 : 2})`
              }}
            >
              {/* The count rides inside the segment when it fits, so the
                  reading never depends on telling two colours apart. */}
              <b>{row.value}</b>
            </span>
          ))}
        </div>
        <ul className="chart-legend">
          {rows.map((row, index) => (
            <li key={row.label}>
              <span className="chart-swatch"
                style={{ background: `var(--series-${index === 0 ? 3 : 2})` }} aria-hidden="true" />
              {row.label} <b>{row.value}</b>
            </li>
          ))}
        </ul>
      </>
    </Figure>
  );
}
