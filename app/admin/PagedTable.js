'use client';

import { useCallback, useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

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
 *
 * The page lives in the URL (?page=3, 1-based, or ?<param>= when a view has
 * two tables), so refresh, Back and a shared link all land on the same rows.
 * It is replaced rather than pushed: paging is not worth a history entry each.
 */
export default function PagedTable({ rows, perPage = 10, head, renderRow, empty, colSpan, param = 'page' }) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const pages = Math.max(Math.ceil(rows.length / perPage), 1);
  const asked = Number.parseInt(search?.get(param) || '1', 10);
  const page = Number.isFinite(asked) && asked >= 1 && asked <= pages ? asked - 1 : 0;

  const setPage = useCallback(next => {
    const index = typeof next === 'function' ? next(page) : next;
    const params = new URLSearchParams(search?.toString() || '');
    if (index > 0) params.set(param, String(index + 1)); else params.delete(param);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [page, search, param, pathname, router]);

  /* Filtering or a reload can leave the URL on a page that no longer exists —
     which would render an empty table under a pager that says there are rows.
     Drop the stale number rather than show it. */
  useEffect(() => {
    if (search?.get(param) && page === 0 && asked !== 1) setPage(0);
  }, [search, param, page, asked, setPage]);

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
          <p className="table-pager-count" aria-live="polite">
            {start + 1}–{Math.min(start + perPage, rows.length)} of {rows.length}
          </p>
          <div className="table-pager-controls">
            <button type="button" onClick={() => setPage(p => p - 1)} disabled={page === 0}>
              <span aria-hidden="true">←</span><span className="sr-only">Previous Page</span>
            </button>
            {Array.from({ length: pages }, (_, index) => (
              <button
                key={index}
                type="button"
                aria-current={index === page ? 'page' : undefined}
                aria-label={`Page ${index + 1}`}
                onClick={() => setPage(index)}
              >
                {index + 1}
              </button>
            ))}
            <button type="button" onClick={() => setPage(p => p + 1)} disabled={page === pages - 1}>
              <span aria-hidden="true">→</span><span className="sr-only">Next Page</span>
            </button>
          </div>
        </div>
      )}
    </>
  );
}
