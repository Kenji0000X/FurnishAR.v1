/**
 * The phone, treated as the primary device rather than a narrow desktop.
 *
 * FurnishAR's core act — scan a room, measure it, stand a piece of furniture
 * in it — only happens on a phone. So this drives the real pages at the widths
 * real phones have, in both orientations, and reports what a thumb and an eye
 * would actually hit.
 *
 * Every number here is measured off the rendered page. Nothing is concluded
 * from a media query existing.
 *
 *   node scripts/audit-mobile.mjs [baseUrl]
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:4300';

/* The widths in the brief, each with a plausible height for that class of
   phone. 320 is an iPhone SE 1st gen and the narrowest thing still in use;
   430 is a Pro Max. */
const PHONES = [
  { name: 'iPhone SE (320)', width: 320, height: 568 },
  { name: 'Galaxy S8 (360)', width: 360, height: 740 },
  { name: 'iPhone SE3 (375)', width: 375, height: 667 },
  { name: 'iPhone 14 (390)', width: 390, height: 844 },
  { name: 'iPhone Plus (414)', width: 414, height: 896 },
  { name: 'iPhone Pro Max (430)', width: 430, height: 932 }
];

const TAP = 44;          // the coarse-pointer minimum, in CSS px
const MIN_FONT = 16;     // below this, iOS zooms the page on focus

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader']
});

const findings = [];
const note = (severity, area, what, evidence = '') =>
  findings.push({ severity, area, what, evidence });

const seen = new Set();
/** Report a class of problem once, with the worst case as the evidence. */
const noteOnce = (key, severity, area, what, evidence) => {
  if (seen.has(key)) return;
  seen.add(key);
  note(severity, area, what, evidence);
};

async function phone(device, landscape = false) {
  const viewport = landscape
    ? { width: device.height, height: device.width }
    : { width: device.width, height: device.height };
  const context = await browser.newContext({
    viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true
  });
  return { context, page: await context.newPage(), viewport };
}

/** Everything measurable about one route at one viewport. */
async function measure(page) {
  return page.evaluate(({ TAP, MIN_FONT }) => {
    const doc = document.documentElement;
    const visible = el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };

    // Tap targets: the box a thumb actually gets. A small <a> inside a padded
    // parent is fine, so the parent's box counts when the child fills it.
    const small = [];
    for (const el of document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="radio"], [role="tab"]')) {
      if (!visible(el) || el.type === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.height >= TAP && r.width >= TAP) continue;
      /* A checkbox or radio wrapped in a label is tapped by the LABEL, which
         is usually the full width of the panel. Measuring the 16x16 box the
         browser draws reports a perfectly comfortable control as too small. */
      const label = el.closest('label');
      if (label) {
        const lr = label.getBoundingClientRect();
        if (lr.height >= TAP && lr.width >= TAP) continue;
      }
      small.push({
        what: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`,
        text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 28),
        size: `${Math.round(r.width)}x${Math.round(r.height)}`
      });
    }

    /* Controls packed closer than a fingertip apart.

       Only counted when BOTH are already below the tap minimum. Two
       full-height nav links stacked in a list touch each other by
       definition, and a 56px-tall row is not a mis-tap risk however close
       its neighbour is — an earlier version counted those and reported
       "7 crowded pairs" on a perfectly ordinary menu. */
    const boxes = [...document.querySelectorAll('a, button, [role="button"]')]
      .filter(el => {
        if (!visible(el)) return false;
        const r = el.getBoundingClientRect();
        return r.height < TAP || r.width < TAP;
      })
      .map(el => ({ el, r: el.getBoundingClientRect() }));
    const crowdedPairs = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].r, b = boxes[j].r;
        if (a.right < b.left - 8 || b.right < a.left - 8) continue;
        if (a.bottom < b.top - 8 || b.bottom < a.top - 8) continue;
        const overlap = !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
        if (!overlap) {
          crowdedPairs.push(`"${(boxes[i].el.textContent || '').trim().slice(0, 18)}" / ` +
            `"${(boxes[j].el.textContent || '').trim().slice(0, 18)}"`);
        }
      }
    }
    const crowded = crowdedPairs.length;

    /* Anything that would make iOS zoom the page when focused.

       Only TEXT-ENTRY fields do this. A range slider or a checkbox has
       nothing to type into and Safari never zooms for them, so including
       them — as an earlier version of this check did — reports a perfectly
       good filter panel as a problem three times over. */
    const TYPES_THAT_ZOOM = new Set([
      'text', 'email', 'password', 'number', 'search', 'tel', 'url', 'date',
      'datetime-local', 'month', 'week', 'time'
    ]);
    const zoomy = [...document.querySelectorAll('input, select, textarea')]
      .filter(el => {
        if (!visible(el)) return false;
        if (el.tagName === 'INPUT' && !TYPES_THAT_ZOOM.has(el.type)) return false;
        return parseFloat(getComputedStyle(el).fontSize) < MIN_FONT;
      })
      .map(el => `${el.tagName.toLowerCase()}${el.name ? `[${el.name}]` : ''}:${el.type} ${getComputedStyle(el).fontSize}`);

    // Text too small to read comfortably on a phone.
    const tiny = [];
    for (const el of document.querySelectorAll('p, span, li, dd, dt, b, i, small, label, td, th')) {
      if (!visible(el) || !el.textContent.trim()) continue;
      /* Decorative glyphs are not text anybody reads — they are icons drawn
         from a font, already hidden from screen readers, and sized by their
         container. Measuring them reported a 0px font-size as "too small". */
      if (el.getAttribute('aria-hidden') === 'true' || el.closest('[aria-hidden="true"]')) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (!size) continue;
      if (size < 11) tiny.push(`${el.tagName.toLowerCase()} ${size}px "${el.textContent.trim().slice(0, 22)}"`);
    }

    const overflowing = [];
    if (doc.scrollWidth > doc.clientWidth + 1) {
      for (const el of document.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > doc.clientWidth + 1) {
          overflowing.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]} right=${Math.round(r.right)}`);
        }
      }
    }

    const grid = document.querySelector('.product-grid');
    let columns = null;
    if (grid) {
      const cards = [...grid.querySelectorAll('.product-card')].filter(visible);
      if (cards.length) {
        const firstTop = Math.round(cards[0].getBoundingClientRect().top);
        columns = cards.filter(c => Math.round(c.getBoundingClientRect().top) === firstTop).length;
      }
    }

    const media = document.querySelector('.product-card .product-media, .product-card img');

    return {
      overflow: doc.scrollWidth - doc.clientWidth,
      overflowing: [...new Set(overflowing)].slice(0, 5),
      small: small.slice(0, 12),
      smallCount: small.length,
      crowded,
      crowdedPairs: crowdedPairs.slice(0, 4),
      zoomy: [...new Set(zoomy)],
      tiny: [...new Set(tiny)].slice(0, 6),
      tinyCount: tiny.length,
      columns,
      cardMedia: media ? Math.round(media.getBoundingClientRect().height) : null,
      headerHeight: Math.round(document.querySelector('.site-header')?.getBoundingClientRect().height || 0),
      viewportHeight: window.innerHeight,
      filtersVisible: (() => {
        const f = document.querySelector('.filters');
        return f ? visible(f) : null;
      })(),
      filterToggle: Boolean(document.querySelector('[data-filter-toggle], .filter-open, #open-filters'))
    };
  }, { TAP, MIN_FONT });
}

const rows = [];

/* ------------------------------------------------- every width, portrait -- */
for (const device of PHONES) {
  for (const route of ['/', '/plan', '/portal', '/collection']) {
    const { context, page, viewport } = await phone(device);
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2200);
    const m = await measure(page);
    rows.push({ device: device.name, width: viewport.width, route, ...m });

    if (m.overflow > 0) {
      note('P0', 'layout', `${route} scrolls sideways at ${viewport.width}px (${m.overflow}px)`,
        m.overflowing.join('; '));
    }
    if (m.zoomy.length) {
      noteOnce(`zoom:${route}`, 'P1', 'forms',
        `${route} has inputs under 16px — iOS zooms the page when they are focused`,
        m.zoomy.join(', '));
    }
    if (m.smallCount) {
      noteOnce(`tap:${route}`, 'P2', 'touch',
        `${route} has ${m.smallCount} control(s) under ${TAP}px`,
        m.small.map(s => `${s.what} "${s.text}" ${s.size}`).join('; ').slice(0, 260));
    }
    if (m.crowded) {
      noteOnce(`crowd:${route}`, 'P2', 'touch',
        `${route} has ${m.crowded} pair(s) of small controls closer than 8px apart`,
        m.crowdedPairs.join('; '));
    }
    if (m.tinyCount) {
      noteOnce(`tiny:${route}`, 'P2', 'readability',
        `${route} has ${m.tinyCount} run(s) of text under 11px`, m.tiny.join('; ').slice(0, 220));
    }
    if (m.headerHeight > viewport.height * 0.18) {
      noteOnce(`header:${route}`, 'P2', 'layout',
        `header takes ${Math.round(m.headerHeight / viewport.height * 100)}% of the screen at ${viewport.width}px`,
        `${m.headerHeight}px of ${viewport.height}px`);
    }
    await context.close();
  }
}

/* ------------------------------------------------------------ landscape -- */
for (const device of [PHONES[1], PHONES[3]]) {
  for (const route of ['/', '/plan']) {
    const { context, page, viewport } = await phone(device, true);
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const m = await measure(page);
    rows.push({ device: `${device.name} landscape`, width: viewport.width, route, ...m });
    if (m.overflow > 0) {
      note('P0', 'layout', `${route} scrolls sideways in landscape at ${viewport.width}px`, m.overflowing.join('; '));
    }
    await context.close();
  }
}

/* ----------------------------------------------------------- navigation -- */
/*
   The hamburger is gone; a bottom bar replaced it. So this no longer looks
   for a menu that opens — it checks that every destination is visible and
   reachable WITHOUT opening anything, which is the whole point of the change.
*/
{
  const { context, page } = await phone(PHONES[1]);
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);

  const bar = await page.evaluate(() => {
    const nav = document.querySelector('.bottom-nav');
    if (!nav) return null;
    const rect = nav.getBoundingClientRect();
    const items = [...nav.querySelectorAll('.bottom-nav-item')];
    return {
      visible: rect.height > 0,
      height: Math.round(rect.height),
      pinnedToBottom: Math.abs(rect.bottom - window.innerHeight) < 2,
      items: items.map(a => {
        const r = a.getBoundingClientRect();
        return {
          label: a.querySelector('.bottom-nav-label')?.textContent?.trim() || '',
          href: a.getAttribute('href'),
          active: a.classList.contains('is-active'),
          current: a.getAttribute('aria-current'),
          width: Math.round(r.width), height: Math.round(r.height),
          hasIcon: Boolean(a.querySelector('svg'))
        };
      }),
      // Nothing may sit underneath the bar where it cannot be tapped.
      coveredControls: [...document.querySelectorAll('a, button')].filter(el => {
        if (el.closest('.bottom-nav')) return false;
        const r = el.getBoundingClientRect();
        if (r.height === 0) return false;
        const fixed = getComputedStyle(el).position === 'fixed'
          || Boolean(el.closest('.cookie-notice, .toast, .back-to-top'));
        return fixed && r.bottom > rect.top && r.top < rect.bottom;
      }).length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  });

  rows.push({ device: 'bottom nav @360', route: '/', bar });

  if (!bar) {
    note('P0', 'navigation', 'no bottom navigation bar at 360px', '');
  } else {
    if (!bar.visible) note('P0', 'navigation', 'the bottom nav renders with no height', '');
    if (!bar.pinnedToBottom) note('P1', 'navigation', 'the bottom nav is not pinned to the bottom of the screen', '');
    if (!bar.items.length) note('P0', 'navigation', 'the bottom nav has no destinations', '');

    const unlabelled = bar.items.filter(i => !i.label);
    if (unlabelled.length) note('P1', 'a11y', `${unlabelled.length} nav item(s) have no label`, '');

    const iconless = bar.items.filter(i => !i.hasIcon);
    if (iconless.length) note('P2', 'navigation', `${iconless.length} nav item(s) have no icon`, '');

    const small = bar.items.filter(i => i.height < TAP);
    if (small.length) {
      note('P2', 'touch', `${small.length} nav item(s) under ${TAP}px tall`,
        small.map(i => `${i.label} ${i.width}x${i.height}`).join('; '));
    }

    // Exactly one destination marks itself current, and it is the right one.
    const active = bar.items.filter(i => i.active);
    if (active.length !== 1) {
      note('P1', 'navigation', `${active.length} nav items are marked active on "/"`, 'expected exactly one');
    } else if (active[0].href !== '/') {
      note('P1', 'navigation', `"${active[0].label}" is marked active on "/"`, `href ${active[0].href}`);
    } else if (active[0].current !== 'page') {
      note('P1', 'a11y', 'the active nav item has no aria-current="page"', '');
    }

    if (bar.coveredControls) {
      note('P1', 'navigation', `${bar.coveredControls} fixed control(s) sit underneath the bottom bar`,
        'they cannot be tapped there');
    }
    if (bar.overflow > 0) note('P0', 'layout', `the bottom nav causes ${bar.overflow}px of sideways scroll`, '');

    // And it actually navigates. (The bar has had no Stores/portal item since
    // buyer accounts landed; Collection is a tab every visitor has.)
    await page.click('.bottom-nav-item[href="/collection"]');
    await page.waitForTimeout(1800);
    const landed = page.url();
    const nowActive = await page.evaluate(() =>
      [...document.querySelectorAll('.bottom-nav-item.is-active')]
        .map(a => a.getAttribute('href')));
    rows.push({ device: 'bottom nav nav-to', route: landed, active: nowActive });
    if (!landed.endsWith('/collection')) {
      note('P0', 'navigation', 'tapping Collection did not go to /collection', landed);
    }
    if (nowActive.length !== 1 || nowActive[0] !== '/collection') {
      note('P1', 'navigation', 'the active destination did not follow the navigation',
        nowActive.join(', ') || 'none');
    }
  }

  // The hamburger it replaced must be gone, not merely hidden behind it.
  const stale = await page.evaluate(() => {
    const toggle = document.querySelector('.nav-toggle');
    if (!toggle) return null;
    const r = toggle.getBoundingClientRect();
    return { visible: r.height > 0, display: getComputedStyle(toggle).display };
  });
  if (stale?.visible) {
    note('P2', 'navigation', 'the old hamburger is still visible alongside the bottom bar', JSON.stringify(stale));
  }

  await context.close();
}

/* --------------------------------------------- filters and search @360 --- */
{
  const { context, page } = await phone(PHONES[1]);
  // The catalogue moved off the home page to /collection.
  await page.goto(`${BASE}/collection`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const filters = await page.evaluate(() => {
    const panel = document.querySelector('.filters');
    if (!panel) return null;
    const r = panel.getBoundingClientRect();
    const grid = document.querySelector('.product-grid')?.getBoundingClientRect();
    /* Measure the PANEL BODY, not the <details> element. Closed, the element
       is still 44px of summary, so "height > 0" reported a collapsed panel as
       permanently open. */
    const body = panel.querySelector('.filter-heading');
    return {
      height: Math.round(r.height),
      top: Math.round(r.top + window.scrollY),
      alwaysOpen: Boolean(body && body.getBoundingClientRect().height > 0),
      // How far down the page the actual furniture starts.
      gridStartsAt: grid ? Math.round(grid.top + window.scrollY) : null,
      // The distance a thumb must travel from the catalogue heading to the
      // first card. This is the number the phone layout is judged on.
      gapBeforeGrid: (() => {
        const section = document.querySelector('.catalog-section .section-heading');
        if (!section || !grid) return 0;
        return Math.round(grid.top - section.getBoundingClientRect().bottom);
      })(),
      pageHeight: document.documentElement.scrollHeight,
      viewport: window.innerHeight
    };
  });
  rows.push({ device: 'filters @360', route: '/', filters });

  /* The question is how much stands between the catalogue heading and the
     first piece of furniture — NOT how far down the document the grid is,
     which mostly measures the hero above it and would fire on any long page. */
  if (filters && filters.gapBeforeGrid > filters.viewport * 0.5) {
    note('P1', 'mobile-ux',
      'the filter panel stands between the catalogue heading and the furniture',
      `${filters.gapBeforeGrid}px of controls before the first card, on a ${filters.viewport}px screen`);
  }

  // Search: type, get results, clear.
  const search = await page.$('.catalog-search input[type="search"]');   // the header has its own, hidden on a phone
  if (!search) note('P1', 'search', 'no search field found at 360px', '');
  else {
    const box = await search.boundingBox();
    await search.fill('armchair');
    await page.waitForTimeout(600);
    const hits = await page.$$eval('.product-card', c => c.length);
    await search.fill('zzzznotathing');
    await page.waitForTimeout(600);
    const empty = await page.evaluate(() => ({
      cards: document.querySelectorAll('.product-card').length,
      message: document.querySelector('.no-results')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 90) || null
    }));
    rows.push({ device: 'search @360', route: '/', width: Math.round(box?.width || 0), height: Math.round(box?.height || 0), hits, empty });
    if ((box?.height || 0) < 40) note('P2', 'touch', `the search field is only ${Math.round(box.height)}px tall`, '');
    if (!empty.message) note('P1', 'states', 'a search with no matches shows no empty-state message', '');
  }
  await context.close();
}

/* ------------------------------------------------ the dashboard table ---- */
{
  const { context, page } = await phone(PHONES[1]);
  await page.goto(`${BASE}/portal`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('form.login-form', { timeout: 20000 });
  await page.fill('input[name="email"]', 'owner@furnishar.ph');
  await page.fill('input[name="password"]', 'furnishar');
  await page.click('form.login-form button[type="submit"]');
  const signedIn = await page.waitForSelector('.console', { timeout: 20000 }).then(() => true, () => false);

  if (!signedIn) {
    note('P1', 'dashboard', 'could not sign in at 360px, so the dashboard was NOT audited', '');
  } else {
    await page.waitForTimeout(1500);
    const m = await measure(page);
    const table = await page.evaluate(() => {
      const wrap = document.querySelector('.inventory-table-wrap');
      const tbl = wrap?.querySelector('table');
      return {
        wrapWidth: Math.round(wrap?.clientWidth || 0),
        tableWidth: Math.round(tbl?.scrollWidth || 0),
        needsSideScroll: (tbl?.scrollWidth || 0) > (wrap?.clientWidth || 0) + 1,
        columns: tbl?.querySelectorAll('thead th').length || 0,
        actionButtons: [...document.querySelectorAll('.table-actions button')]
          .map(b => { const r = b.getBoundingClientRect(); return `${b.textContent.trim()} ${Math.round(r.width)}x${Math.round(r.height)}`; })
      };
    });
    rows.push({ device: 'dashboard @360', route: '/portal', ...m, table });

    if (m.overflow > 0) note('P0', 'layout', `the dashboard scrolls sideways at 360px`, m.overflowing.join('; '));
    if (table.needsSideScroll) {
      note('P1', 'mobile-ux',
        `the inventory table needs sideways scrolling on a phone (${table.tableWidth}px in ${table.wrapWidth}px)`,
        `${table.columns} columns — a stacked card layout would suit a phone better`);
    }
    const smallActions = table.actionButtons.filter(b => Number(b.split(' ').pop().split('x')[1]) < 44);
    if (smallActions.length) {
      note('P2', 'touch', `${smallActions.length} row action button(s) under 44px`, table.actionButtons.join('; '));
    }

    // The add-product form, on a phone.
    await page.click('.console-head button:has-text("Add Product")');
    await page.waitForSelector('dialog.form-dialog[open]', { timeout: 10000 });
    await page.waitForTimeout(600);
    const form = await page.evaluate(() => {
      const dlg = document.querySelector('dialog.form-dialog');
      const r = dlg.getBoundingClientRect();
      const fields = [...dlg.querySelectorAll('input, select, textarea')].filter(el => el.type !== 'hidden');
      const rowsOf = new Map();
      // Radios are one segmented control (the cm / in / ft unit switch), not
      // three fields side by side.
      for (const f of fields.filter(el => el.type !== 'radio' && el.type !== 'checkbox')) {
        const top = Math.round(f.getBoundingClientRect().top);
        rowsOf.set(top, (rowsOf.get(top) || 0) + 1);
      }
      return {
        dialogWidth: Math.round(r.width),
        overflowsViewport: r.right > window.innerWidth + 1 || r.left < -1,
        tallerThanScreen: r.height > window.innerHeight,
        fieldCount: fields.length,
        widestRow: Math.max(...rowsOf.values()),
        // inputmode="decimal"/"numeric" raises the number pad as surely as
        // type="number", without the spinner and scroll-wheel surprises.
        inputTypes: fields.map(f => `${f.name || f.id || f.type}:${f.getAttribute('type') || f.tagName.toLowerCase()}${f.inputMode ? `:${f.inputMode}` : ''}`),
        // Same rule as above: only fields somebody types into.
        smallFonts: fields.filter(f => {
          const typing = f.tagName !== 'INPUT'
            || ['text', 'email', 'password', 'number', 'search', 'tel', 'url'].includes(f.type);
          return typing && parseFloat(getComputedStyle(f).fontSize) < 16;
        }).map(f => `${f.name || f.type}:${getComputedStyle(f).fontSize}`)
      };
    });
    rows.push({ device: 'add-product form @360', route: '/portal', form });

    if (form.overflowsViewport) note('P0', 'layout', 'the add-product dialog is wider than the screen at 360px', '');
    if (form.smallFonts.length) {
      note('P1', 'forms', `${form.smallFonts.length} dialog field(s) under 16px — iOS zooms on focus`,
        form.smallFonts.join(', '));
    }
    if (form.widestRow > 2) {
      note('P2', 'mobile-ux', `the add-product form puts ${form.widestRow} fields side by side on a phone`, '');
    }
    // Numeric fields should raise the number pad.
    const numeric = form.inputTypes.filter(t => /width|height|depth|price|stock/.test(t));
    const wrongKeyboard = numeric.filter(t => !/:number|:tel|:decimal|:numeric/.test(t));
    if (wrongKeyboard.length) {
      note('P2', 'forms', 'numeric fields do not request a numeric keyboard', wrongKeyboard.join(', '));
    }
  }
  await context.close();
}

/* -------------------------------------------- AR chrome reachability ----- */
{
  const { context, page, viewport } = await phone(PHONES[3]);
  await page.goto(`${BASE}/plan`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__furnisharScan), null, { timeout: 15000 });
  const ar = await page.evaluate(() => {
    window.__furnisharScan.openPanel();
    const panel = document.querySelector('#scan-panel');
    const r = panel.getBoundingClientRect();
    const useRoom = document.getElementById('use-room')?.getBoundingClientRect();
    const exit = document.getElementById('exit-ar')?.getBoundingClientRect();
    return {
      panelTop: Math.round(r.top),
      panelBottom: Math.round(r.bottom),
      panelHeight: Math.round(r.height),
      screen: window.innerHeight,
      // A thumb comfortably reaches roughly the bottom 60% of a phone screen.
      useRoomInThumbReach: useRoom ? useRoom.top > window.innerHeight * 0.4 : null,
      useRoomSize: useRoom ? `${Math.round(useRoom.width)}x${Math.round(useRoom.height)}` : null,
      exitSize: exit ? `${Math.round(exit.width)}x${Math.round(exit.height)}` : null,
      cameraVisibleFraction: 1 - (r.height / window.innerHeight)
    };
  });
  rows.push({ device: 'AR scan @390', route: '/plan', ar });

  if (ar.panelBottom > ar.screen) {
    note('P1', 'ar', `the scan panel runs off the bottom of a ${viewport.height}px screen`,
      `panel ends at ${ar.panelBottom}px`);
  }
  if (ar.cameraVisibleFraction < 0.5) {
    note('P1', 'ar', 'the scan panel covers more than half the camera view',
      `${Math.round((1 - ar.cameraVisibleFraction) * 100)}% covered`);
  }
  if (ar.useRoomInThumbReach === false) {
    note('P2', 'ar', '"Use this room" sits in the top 40% of the screen, out of easy thumb reach', '');
  }
  await context.close();
}

/* ----------------------------------------------- hover-only affordances -- */
{
  const { context, page } = await phone(PHONES[1]);
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const hoverOnly = await page.evaluate(() => {
    // Rules that only reveal something on :hover, with no :focus-visible or
    // :active twin — on a phone that content is simply unreachable.
    const offenders = [];
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules) {
        if (!rule.selectorText || !rule.selectorText.includes(':hover')) continue;
        const style = rule.style;
        const reveals = ['opacity', 'visibility', 'display', 'transform', 'max-height']
          .some(prop => style.getPropertyValue(prop));
        if (!reveals) continue;
        const base = rule.selectorText.replace(/:hover/g, '');
        const hasTwin = [...rules].some(r =>
          r.selectorText && (r.selectorText.includes(':focus') || r.selectorText.includes(':active'))
          && r.selectorText.replace(/:focus-visible|:focus-within|:focus|:active/g, '') === base);
        if (!hasTwin) offenders.push(rule.selectorText);
      }
    }
    return [...new Set(offenders)];
  });
  rows.push({ device: 'hover @360', route: '/', hoverOnly: hoverOnly.slice(0, 10), count: hoverOnly.length });
  await context.close();
}

await browser.close();

/* ------------------------------------------------------------- report --- */
console.log('=== PER VIEWPORT ===');
console.log('  device                     width route                          ovf cols media tap<44 tiny zoom');
for (const r of rows.filter(r => r.overflow !== undefined)) {
  console.log(
    `  ${String(r.device).padEnd(26)} ${String(r.width).padEnd(5)} ${String(r.route).padEnd(30)} ` +
    `${String(r.overflow).padEnd(3)} ${String(r.columns ?? '-').padEnd(4)} ${String(r.cardMedia ?? '-').padEnd(5)} ` +
    `${String(r.smallCount).padEnd(6)} ${String(r.tinyCount).padEnd(4)} ${r.zoomy.length}`);
}

for (const r of rows.filter(r => r.overflow === undefined)) {
  console.log(`\n=== ${r.device.toUpperCase()} ===`);
  console.log('  ' + JSON.stringify(r, null, 1).split('\n').slice(1, -1).join('\n  '));
}

const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
findings.sort((a, b) => order[a.severity] - order[b.severity]);
console.log('\n=== FINDINGS ===');
if (!findings.length) console.log('  none');
for (const f of findings) {
  console.log(`  ${f.severity} [${f.area}] ${f.what}`);
  if (f.evidence) console.log(`       ${f.evidence}`);
}
process.exit(findings.some(f => f.severity === 'P0') ? 1 : 0);
