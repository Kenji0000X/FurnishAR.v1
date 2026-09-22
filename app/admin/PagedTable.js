'use client';

import { useEffect, useState } from 'react';

/**
 * A table that stops at a page's worth of rows.
 *
 * Every table in this console is unbounded: `listUploadedModels(200)` will
 * happily render two hundred rows, and the Stores table grows with the
 * platform. On a phone that is a thousand-pixel scroll past information nobody
 * asked for, and it is exactly the kind of thing that is fine in a thesis demo
 * with three rows and unusable the week it works.
 *
 * The count is stated in full ("13 of 47") rather than only the page number,
 * because "showing 10" with no total is how a table quietly hides rows.
 */
export default function PagedTable({ rows, perPage = 10, head, renderRow, empty, colSpan }) {
  const [page, setPage] = useState(0);
  const pages = Math.max(Math.ceil(rows.length / perPage), 1);

  /* Filtering or a reload can leave you on a page that no longer exists —
     which renders an empty table under a pager that says there are rows. */
  useEffect(() => { if (page > pages - 1) setPage(0); }, [page, pages]);

  const start = page * perPage;
  const shown = rows.slice(start, start + perPage);

  return (
    <>
      <div className="inventory-table-wrap">
        <table>
          <thead>{head}</thead>
          <tbody>
            {shown.length
              ? shown.map(renderRow)
              : <tr><td colSpan={colSpan}>{empty}</td></tr>}
          </tbody>
        </table>
      </div>

      {rows.length > perPage && (
        <div className="table-pager">
          <p className="table-pager-count">
            {start + 1}–{Math.min(start + perPage, rows.length)} of {rows.length}
          </p>
          <div className="table-pager-controls">
            <button type="button" onClick={() => setPage(p => p - 1)} disabled={page === 0}>
              <span aria-hidden="true">←</span><span className="sr-only">Previous page</span>
            </button>
            {Array.from({ length: pages }, (_, index) => (
              <button
                key={index}
                type="button"
                aria-current={index === page ? 'page' : undefined}
                onClick={() => setPage(index)}
              >
                {index + 1}
              </button>
            ))}
            <button type="button" onClick={() => setPage(p => p + 1)} disabled={page === pages - 1}>
              <span aria-hidden="true">→</span><span className="sr-only">Next page</span>
            </button>
          </div>
        </div>
      )}
    </>
  );
}
