/**
 * The dashboard: every NHS trust's A&E month and waiting list, and every view
 * built from whichever trusts you tick.
 *
 * The shape of it is one stream and one Data Router. The saved copy is loaded
 * once, as a single array holding four kinds of record, and the router
 * partitions it:
 *
 *   'trust'    -> the trust table, the one you choose from
 *   'obs'      -> the four-hour chart's grid (the ticked trusts and England)
 *   'obs'      -> the waiting-list chart's grid (the ticked trusts)
 *   'obs'      -> England alone, which is what the national tiles read
 *   'obs'      -> the month-by-month table, as a rollup by month
 *   'band'     -> the waiting-time distribution
 *   'function' -> the treatment-function tab
 *
 * Four viewers of one partition value needs `overlap: true`; without it only
 * the first of them would ever receive a row.
 *
 * Ticking a trust does not reload anything. `router.link` makes the trust
 * table's selection a filter on what the other routes receive, so every chart,
 * tile and table is re-pushed through the same keyed diff and keeps its scroll
 * and its sort. The four-hour chart's link is a function rather than a key map,
 * because England has to stay on that chart whatever is ticked: it is the line
 * every trust is read against.
 *
 * Nothing here reaches for a global: every factory is handed in, so this file
 * would read the same if the library had arrived as an import.
 *
 * A classic script: it reads `NhsDemo`, put there by `nhs-data.js`, and adds
 * `buildDashboard` alongside it.
 */
(function (root) {
  'use strict';

  const {
    ENGLAND, FOUR_HOUR_STANDARD, EIGHTEEN_WEEK_STANDARD, prepare, monthLabel, mergeLive, fetchLatestAe,
  } = root.NhsDemo;

  /** How many tiles a reader is asked to take in at once. */
  const MAX_TILES = 6;

  /** How many trusts the ranking chart draws, largest A&E department first. */
  const RANKED = 15;

  /**
   * What the month-by-month table can show, one measure at a time.
   *
   * One column per trust and one measure across all of them, rather than every
   * measure for every trust: forty columns of mixed units is not a table anyone
   * reads across, and the unit belongs in the heading of the table rather than
   * in each of its cells.
   */
  const MEASURES = [
    { id: 'perf', label: 'Seen within four hours', unit: 'per cent of attendances', format: { type: 'number', decimals: 1, suffix: '%' } },
    { id: 'at', label: 'A&E attendances', unit: 'attendances', format: { type: 'number', decimals: 0 } },
    { id: 'w12', label: 'Waited 12 hours or more', unit: 'patients, from the decision to admit', format: { type: 'number', decimals: 0 } },
    { id: 'tot', label: 'On the waiting list', unit: 'incomplete pathways', format: { type: 'number', decimals: 0 } },
    { id: 'pct18', label: 'Waiting under 18 weeks', unit: 'per cent of the list', format: { type: 'number', decimals: 1, suffix: '%' } },
    { id: 'g52', label: 'Waiting over 52 weeks', unit: 'people', format: { type: 'number', decimals: 0 } },
    { id: 'med', label: 'Median wait', unit: 'weeks, estimated from the weekly bands', format: { type: 'number', decimals: 1, suffix: ' wk' } },
  ];

  const AE_AREA = 'https://www.england.nhs.uk/statistics/statistical-work-areas/'
    + 'ae-waiting-times-and-activity/';
  const RTT_AREA = 'https://www.england.nhs.uk/statistics/statistical-work-areas/rtt-waiting-times/';

  /** Make an element with a class and optional text, the long way round. */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** A whole number with thousands separators. */
  function counted(value) {
    if (value == null || !Number.isFinite(value)) return 'no figure';
    return new Intl.NumberFormat('en-GB').format(Math.round(value));
  }

  /**
   * A two-line column heading: a name, and a smaller line under it.
   *
   * `header.render` is handed the label element and may return a node for the
   * grid to attach, which is what puts the unit under the heading rather than
   * inside it, where it would set the width of every column to the length of a
   * sentence.
   *
   * @param {string} main the heading proper
   * @param {string} sub the second line, which is always the unit
   * @returns {() => HTMLElement} the renderer
   */
  function twoLineHeading(main, sub) {
    return () => {
      const wrap = document.createElement('span');
      wrap.className = 'col-head';
      wrap.append(el('span', 'col-head-main', main));
      wrap.append(el('span', 'col-head-sub', sub));
      return wrap;
    };
  }

  /**
   * A column's layout, with the two things every column on this page agrees on.
   *
   * Nothing here is drag-reorderable. The columns are a designed order carrying
   * a designed meaning, and a heading that offers to be dragged "to reorder, or
   * onto the group bar" is offering something this page has no use for, on
   * every hover, in front of the heading itself.
   *
   * @param {object} [extra] the column's own layout
   * @returns {object} the layout to declare
   */
  function fixedLayout(extra) {
    return Object.assign({ movable: false }, extra || {});
  }

  /**
   * The shared grid settings.
   *
   * No right-hand tool rail, no column menu and no filter funnel: the heading
   * keeps the sort arrow and nothing else, because the rest is furniture a
   * reader did not ask for that trades places with the heading on hover.
   *
   * @param {string} title the grid's title
   * @param {object} [extra] the rest of the configuration
   * @returns {object} the configuration
   */
  function baseGridConfig(title, extra) {
    return Object.assign(
      {
        rowKey: 'id',
        theme: 'light',
        density: 'compact',
        stripedRows: true,
        columnMenu: false,
        statusBar: true,
        find: true,
        title,
      },
      extra || {},
    );
  }

  /** A grid that is a data path rather than a view: it is never mounted. */
  function hiddenGrid(createGrid, title, columns, extra) {
    return createGrid(el('div', 'hidden-grid'), baseGridConfig(title, Object.assign({
      selection: 'none',
      statusBar: false,
      find: false,
      columns,
    }, extra || {})));
  }

  /* ------------------------------------------------------------------ */
  /* Columns                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * The trust table's columns: one row per provider, and where it stands this
   * month on each collection.
   *
   * Every format is a FormatSpec object rather than a function, which is the
   * only shape a column format takes. Every width is declared rather than
   * fitted, so the table is the same table at every size the page is read at.
   *
   * @param {object} meta the snapshot's meta, for the months in the headings
   * @returns {object[]} the column definitions
   */
  function trustColumns(meta) {
    const ae = monthLabel(meta.ae.last);
    const rtt = monthLabel(meta.rtt.last);
    const plain = { enabled: false };
    return [
      {
        id: 'name',
        field: 'name',
        title: 'Trust',
        cell: { render: 'twoline', props: { secondary: 'c' } },
        filter: plain,
        layout: fixedLayout({ width: 235, pin: 'start' }),
      },
      {
        id: 'region',
        field: 'region',
        title: 'Region',
        header: { render: twoLineHeading('Region', 'NHS England region') },
        filter: plain,
        layout: fixedLayout({ width: 140 }),
      },
      {
        id: 'at',
        field: 'at',
        title: `A&E attendances, ${ae}`,
        header: { render: twoLineHeading('A&E attendances', `attendances, ${ae}`) },
        type: 'number',
        filter: plain,
        format: { type: 'number', decimals: 0 },
        layout: fixedLayout({ width: 130 }),
      },
      {
        id: 'perf',
        field: 'perf',
        title: `Seen within four hours, ${ae}`,
        header: { render: twoLineHeading('Seen within four hours', `per cent of attendances, ${ae}`) },
        type: 'number',
        filter: plain,
        format: { type: 'number', decimals: 1, suffix: '%' },
        /* The bar runs the whole scale a percentage has, so a trust at 60 per
           cent and a trust at 95 are drawn against the same thing. */
        cell: { decoration: { type: 'bar', min: 0, max: 100, origin: 0 } },
        layout: fixedLayout({ width: 160 }),
      },
      {
        id: 'w12',
        field: 'w12',
        title: `Waited 12 hours or more, ${ae}`,
        header: { render: twoLineHeading('Waited 12 hours or more', 'patients, from the decision to admit') },
        type: 'number',
        filter: plain,
        format: { type: 'number', decimals: 0 },
        layout: fixedLayout({ width: 175 }),
      },
      {
        id: 'tot',
        field: 'tot',
        title: `On the waiting list, ${rtt}`,
        header: { render: twoLineHeading('On the waiting list', `incomplete pathways, ${rtt}`) },
        type: 'number',
        filter: plain,
        format: { type: 'number', decimals: 0 },
        layout: fixedLayout({ width: 150 }),
      },
      {
        id: 'pct18',
        field: 'pct18',
        title: `Waiting under 18 weeks, ${rtt}`,
        header: { render: twoLineHeading('Waiting under 18 weeks', 'per cent of the list') },
        type: 'number',
        filter: plain,
        format: { type: 'number', decimals: 1, suffix: '%' },
        cell: { decoration: { type: 'bar', min: 0, max: 100, origin: 0 } },
        layout: fixedLayout({ width: 165 }),
      },
      {
        id: 'g52',
        field: 'g52',
        title: `Waiting over 52 weeks, ${rtt}`,
        header: { render: twoLineHeading('Waiting over 52 weeks', 'people') },
        type: 'number',
        filter: plain,
        format: { type: 'number', decimals: 0 },
        layout: fixedLayout({ width: 140 }),
      },
    ];
  }

  /**
   * The columns of the grid behind a time chart.
   *
   * A chart may only plot a column the grid declares, so every field either
   * chart reads is a column here, named and typed, even though this grid is a
   * data path and is never drawn.
   *
   * @returns {object[]} the column definitions
   */
  function observationColumns() {
    return [
      { id: 'c', field: 'c', title: 'Provider code' },
      { id: 'n', field: 'n', title: 'Trust' },
      { id: 'm', field: 'm', title: 'Month' },
      { id: 'd', field: 'd', title: 'Month', type: 'date' },
      { id: 'at', field: 'at', title: 'A&E attendances', type: 'number' },
      { id: 'a1', field: 'a1', title: 'Type 1 attendances', type: 'number' },
      { id: 'perf', field: 'perf', title: 'Seen within four hours, per cent', type: 'number' },
      { id: 'perf1', field: 'perf1', title: 'Seen within four hours at a Type 1 department, per cent', type: 'number' },
      { id: 'w4', field: 'w4', title: 'Waited 4 to 12 hours from the decision to admit', type: 'number' },
      { id: 'w12', field: 'w12', title: 'Waited 12 hours or more from the decision to admit', type: 'number' },
      { id: 'ea', field: 'ea', title: 'Emergency admissions', type: 'number' },
      { id: 'tot', field: 'tot', title: 'On the waiting list', type: 'number' },
      { id: 'w18', field: 'w18', title: 'Waiting under 18 weeks', type: 'number' },
      { id: 'pct18', field: 'pct18', title: 'Waiting under 18 weeks, per cent', type: 'number' },
      { id: 'g52', field: 'g52', title: 'Waiting over 52 weeks', type: 'number' },
      { id: 'g65', field: 'g65', title: 'Waiting over 65 weeks', type: 'number' },
      { id: 'med', field: 'med', title: 'Median wait, weeks', type: 'number' },
    ];
  }

  /* ------------------------------------------------------------------ */
  /* The dashboard                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Build the whole page into `host`.
   *
   * @param {object} options everything the page needs, all handed in
   * @param {HTMLElement} options.root where the dashboard is drawn
   * @param {Function} options.createGrid the grid factory
   * @param {Function} options.createChart the charts module's factory
   * @param {Function} options.createKPI the KPI module's factory
   * @param {Function} options.createTabs the tabs module's factory
   * @param {Function} options.createDataRouter the data router's factory
   * @param {object} options.snapshot the saved copy, as read from disk
   * @returns {object} the pieces that were built, for a caller that wants them
   */
  function buildDashboard(options) {
    const {
      root: host, createGrid, createChart, createKPI, createTabs, createDataRouter, snapshot,
    } = options;

    host.textContent = '';
    const data = prepare(snapshot);
    const meta = data.meta;

    const built = {
      data,
      meta,
      trustGrid: null,
      perfGrid: null,
      listGrid: null,
      englandGrid: null,
      bandGrid: null,
      functionGrid: null,
      monthlyGrid: null,
      router: null,
      kpi: null,
      perfChart: null,
      listChart: null,
      rankChart: null,
      bandChart: null,
      tabs: null,
      treatment: null,
      measure: 'perf',
      live: { state: 'pending', reason: null, rows: 0, changed: 0 },
    };

    /* ---------------- the masthead ---------------- */

    const header = el('header', 'head');
    const heading = el('div', 'head-text');
    heading.append(el('h1', null, "England's hospitals, month by month"));
    heading.append(
      el(
        'p',
        'lede',
        `Every NHS trust's A&E month and elective waiting list, as NHS England publishes them: `
          + `${meta.counts.trusts} providers, ${meta.ae.months} months of A&E back to ${monthLabel(meta.ae.first)} `
          + `and ${meta.rtt.months} months of referral-to-treatment waiting lists. Tick the trusts you want. `
          + 'Built with Lattice Grid loaded by script tag: no install, no build step.',
      ),
    );
    header.append(heading);

    const provenance = el('div', 'head-note');
    const pill = el('span', 'pill', 'Saved copy');
    const freshness = el('span', 'freshness', 'Reading the latest A&E month from NHS England...');
    provenance.append(pill, freshness);
    header.append(provenance);
    host.append(header);

    /**
     * Say what the page is showing and where each half of it came from.
     *
     * The two collections are not live in the same way and the line says so.
     * The A&E CSVs allow a cross-origin read, so the newest month really is
     * re-read from NHS England when the page opens; the index pages that link
     * them do not, so a month published since the last rebuild cannot be found
     * from here, and the waiting-list extracts are 85MB apiece and are never
     * read in a browser at all.
     *
     * @returns {void}
     */
    function sayProvenance() {
      const taken = new Date(meta.builtAt).toLocaleString('en-GB');
      const live = built.live;
      if (live.state === 'pending') {
        freshness.textContent = 'Reading the latest A&E month from NHS England...';
        return;
      }
      if (live.state === 'ok') {
        pill.textContent = 'Live + saved copy';
        freshness.classList.remove('failed');
        freshness.textContent =
          `${monthLabel(meta.ae.last)} A&E re-read from NHS England just now: ${counted(live.rows)} providers, `
          + `${live.changed === 0 ? 'none changed' : `${counted(live.changed)} changed`}. `
          + `Everything else is a saved copy taken ${taken} and rebuilt nightly. `
          + 'NHS England does not allow a browser to read the pages that list new files, so a month published '
          + 'since that rebuild is not here until the next one. The waiting lists are never read in a browser: '
          + 'each month of them is an 85MB file.';
        return;
      }
      pill.textContent = 'Saved copy';
      freshness.classList.add('failed');
      freshness.textContent =
        `The live re-read of ${monthLabel(meta.ae.last)} did not happen (${live.reason}), so every figure here `
        + `is the saved copy taken ${taken} and rebuilt nightly.`;
    }
    sayProvenance();

    /* ---------------- the grids ---------------- */

    const trustPane = el('div', 'grid-pane');
    const trustGrid = createGrid(trustPane, baseGridConfig('Trusts', {
      columns: trustColumns(meta),
      /*
       * The checkbox is the only thing that selects. Clicking a cell used to
       * draw a focus ring, start a cell range and offer a fill handle to drag,
       * which is a spreadsheet's vocabulary offered on a table nobody is
       * editing: it looks like something is about to happen, and nothing is.
       */
      selection: {
        mode: 'multiple',
        checkbox: true,
        headerCheckbox: true,
        checkboxOnly: true,
        ranges: false,
        fillHandle: false,
      },
    }));
    built.trustGrid = trustGrid;
    /*
     * The sort is set through `grid.sort`, not declared in the configuration.
     * `createGrid({ sort: [...] })` is accepted without a word and does
     * nothing: the table then shows whatever order the rows arrived in, which
     * for a table sorted by the busiest department is a coincidence waiting to
     * stop being true.
     */
    trustGrid.sort.set([{ col: 'at', dir: 'desc' }]);

    const perfGrid = hiddenGrid(createGrid, 'Months, for the four-hour chart', observationColumns());
    const listGrid = hiddenGrid(createGrid, 'Months, for the waiting-list chart', observationColumns());
    const englandGrid = hiddenGrid(createGrid, 'England, month by month', observationColumns());
    built.perfGrid = perfGrid;
    built.listGrid = listGrid;
    built.englandGrid = englandGrid;

    /*
     * In date order, oldest first, and that is not decoration.
     *
     * A chart's line joins its points in the order the binder meets them, which
     * is the order of the grid's rows. NHS England's yearly pages do not list
     * their files chronologically, and a delta from the live re-read arrives
     * whenever it arrives, so "the order the rows came in" is not a time series
     * at all: it draws eighty-nine months as a thicket of lines doubling back
     * on themselves. The snapshot is written sorted too; this is the half that
     * survives a delta.
     */
    perfGrid.sort.set([{ col: 'd', dir: 'asc' }]);
    listGrid.sort.set([{ col: 'd', dir: 'asc' }]);
    englandGrid.sort.set([{ col: 'd', dir: 'asc' }]);

    const bandGrid = hiddenGrid(createGrid, 'The waiting list by waiting time', [
      { id: 'c', field: 'c', title: 'Provider code' },
      { id: 'n', field: 'n', title: 'Trust' },
      { id: 'label', field: 'label', title: 'Weeks waited' },
      { id: 'order', field: 'order', title: 'Order', type: 'number' },
      { id: 'people', field: 'people', title: 'People waiting', type: 'number' },
    ]);
    built.bandGrid = bandGrid;
    /* Shortest wait first, so the distribution reads left to right. */
    bandGrid.sort.set([{ col: 'order', dir: 'asc' }]);

    /* ---------------- the router ---------------- */

    const router = createDataRouter({
      key: 'kind',
      rowKey: 'id',
      /* Five routes want the same 'obs' partition: without this, only the first
         of them would ever receive a row. */
      overlap: true,
      selectionDebounce: 0,
    });
    built.router = router;

    router.attach(trustGrid, 'trust', { label: 'trusts' });
    router.attach(perfGrid, 'obs', { label: 'four-hour chart' });
    router.attach(listGrid, 'obs', { label: 'waiting-list chart' });
    /*
     * England's own rows travel in the same partition as the providers', under
     * the code ENG, and this route is the one that pulls them out. A route
     * filter rather than a filter on the grid, so the other four routes never
     * see the national row and no chart of trusts quietly draws England as a
     * sixth trust.
     */
    router.attach(englandGrid, 'obs', { label: 'England', filter: (row) => row.c === ENGLAND });
    router.attach(bandGrid, 'band', { label: 'waiting-time bands' });

    /*
     * The trust table's selection narrows what each of the others receives.
     *
     * The four-hour chart's relation is a function rather than the plain key
     * map the rest use, because England belongs on that chart whatever is
     * ticked: it is the line a trust is read against, and a key map has no way
     * to say "these, and also that one".
     */
    router.link(trustGrid, perfGrid, (selected) => {
      const wanted = new Set(selected.map((row) => row.c));
      wanted.add(ENGLAND);
      return (row) => wanted.has(row.c);
    });
    router.link(trustGrid, listGrid, { from: 'c', to: 'c' });
    router.link(trustGrid, bandGrid, { from: 'c', to: 'c' });

    /* ---------------- the national tiles ---------------- */

    const kpiHost = el('section', 'kpi-host');
    kpiHost.setAttribute('aria-label', 'England, the latest month');
    const kpiStrip = el('div', 'kpi-strip');
    const kpiCaption = el('p', 'panel-caption');
    kpiHost.append(kpiStrip, kpiCaption);
    host.append(kpiHost);

    /**
     * England's row for a month, out of the grid the England route feeds.
     *
     * @param {object[]} rows the routed rows
     * @param {string} month the `YYYY-MM` wanted
     * @returns {object|null} the row
     */
    function englandAt(rows, month) {
      for (const row of rows) if (row.m === month) return row;
      return null;
    }

    /**
     * Build the six national tiles.
     *
     * Every movement is written into the tile's own second line, in the unit it
     * is actually in: a count moves by a percentage, and a percentage moves by
     * PERCENTAGE POINTS, because "the four-hour figure fell 5 per cent" is a
     * sentence about a number rather than about a hospital.
     *
     * None of them uses the panel's own movement line, which is the one thing
     * on this page that was left on the table deliberately. That line colours a
     * rise green and a fall red, and there is no way to tell it otherwise; on
     * five of these six figures that reading is wrong or meaningless. A waiting
     * list of seven million falling by a hundred and seventy thousand people is
     * the best news on the page, and it would have been drawn in red.
     *
     * @returns {void}
     */
    function buildTiles() {
      if (built.kpi) built.kpi.destroy();
      kpiStrip.textContent = '';
      const rows = englandGrid.rows.data();
      const aeNow = englandAt(rows, meta.ae.last);
      const aeAgo = englandAt(rows, root.NhsDemo.yearBefore(meta.ae.last));
      const rttAgo = englandAt(rows, root.NhsDemo.yearBefore(meta.rtt.last));
      if (!aeNow) {
        kpiStrip.append(el('p', 'empty-note', 'England has no figures in the saved copy.'));
        built.kpi = null;
        return;
      }

      /** How a figure moved on the same month a year earlier, in words. */
      const movement = (now, ago, field, points) => {
        if (!now || !ago || now[field] == null || ago[field] == null) return '';
        const change = now[field] - ago[field];
        const sign = change > 0 ? '+' : '';
        if (points) return `\n${sign}${change.toFixed(1)} pp on a year earlier`;
        if (!ago[field]) return `\n${sign}${counted(change)} on a year earlier`;
        return `\n${sign}${counted(change)} (${sign}${((change / Math.abs(ago[field])) * 100).toFixed(1)}%) on a year earlier`;
      };

      /**
       * One tile: the England figure for a month, and how it moved on the year.
       *
       * @param {string} id the tile id
       * @param {string} label what it is
       * @param {string} unit what it is counted in
       * @param {string} month which month it reads
       * @param {string} field which figure
       * @param {object|null} ago the same month a year earlier
       * @param {boolean} points true when the figure is itself a percentage
       * @returns {object} the tile
       */
      const tile = (id, label, unit, month, field, ago, points) => ({
        id,
        label: `${label}: ${unit}${movement(englandAt(rows, month), ago, field, points)}`,
        aggregation: 'custom',
        /*
         * A percent format writes the sign on the figure, which a tile reading
         * "75.0" beside one reading "2.34M" badly needs. It takes a FRACTION
         * and multiplies by a hundred itself, so the tile is fed the figure
         * divided by a hundred and reports it that way to anything reading
         * `kpi.tiles()`.
         */
        format: points ? { type: 'percent', decimals: 1 } : { type: 'compact', decimals: 2 },
        compute: (all) => {
          const row = englandAt(all, month);
          if (!row || row[field] == null) return null;
          return points ? row[field] / 100 : row[field];
        },
      });

      const tiles = [
        tile('att', 'A&E attendances', `all types, ${monthLabel(meta.ae.last)}`, meta.ae.last, 'at', aeAgo, false),
        tile('perf', 'Seen within four hours', 'per cent of attendances', meta.ae.last, 'perf', aeAgo, true),
        tile('w12', 'Waited 12 hours or more', 'patients, from the decision to admit', meta.ae.last, 'w12', aeAgo, false),
        tile('ea', 'Emergency admissions', 'admissions', meta.ae.last, 'ea', aeAgo, false),
        tile('tot', 'On the waiting list', `incomplete pathways, ${monthLabel(meta.rtt.last)}`, meta.rtt.last, 'tot', rttAgo, false),
        tile('pct18', 'Waiting under 18 weeks', 'per cent of the list', meta.rtt.last, 'pct18', rttAgo, true),
      ];

      built.kpi = createKPI(kpiStrip, {
        grid: englandGrid,
        rowKey: 'id',
        fields: ['c', 'm', 'at', 'w12', 'ea', 'tot', 'perf', 'pct18'],
        columns: Math.min(MAX_TILES, tiles.length),
        ariaLabel: 'England, the latest month',
        tiles,
      });
      kpiCaption.textContent =
        `England, ${monthLabel(meta.ae.last)} for A&E and ${monthLabel(meta.rtt.last)} for the waiting list, `
        + 'which NHS England publishes a month behind it. Each movement is against the same month a year '
        + 'earlier: a count moves by a percentage, a percentage moves by percentage points. '
        + `The standards are ${FOUR_HOUR_STANDARD} per cent seen within four hours and `
        + `${EIGHTEEN_WEEK_STANDARD} per cent of the list waiting under 18 weeks.`;
    }

    /* ---------------- the charts over time ---------------- */

    const timeSection = el('section', 'chart-section');
    timeSection.setAttribute('aria-label', 'The ticked trusts over time');
    const timeRow = el('div', 'chart-row');
    const perfBox = el('div', 'chart-box tall');
    const listBox = el('div', 'chart-box tall');
    timeRow.append(perfBox, listBox);
    const timeNote = el('p', 'chart-note');
    timeSection.append(timeRow, timeNote);
    host.append(timeSection);

    const latestSection = el('section', 'chart-section');
    latestSection.setAttribute('aria-label', `The latest month`);
    const latestRow = el('div', 'chart-row');
    const rankBox = el('div', 'chart-box tall');
    const bandBox = el('div', 'chart-box tall');
    latestRow.append(rankBox, bandBox);
    const latestNote = el('p', 'chart-note');
    latestSection.append(latestRow, latestNote);
    host.append(latestSection);

    /** The provider codes ticked in the trust table, in table order. */
    function chosen() {
      const keys = new Set(trustGrid.selection.keys());
      return data.trusts.filter((trust) => keys.has(trust.id)).map((trust) => trust.c);
    }

    /** The one trust the two single-trust views are about. */
    function focus() {
      const picked = chosen();
      return picked.length ? picked[0] : ENGLAND;
    }

    /** That trust's name, for a caption. */
    function nameOf(code) {
      if (code === ENGLAND) return 'England';
      const trust = data.trustByCode.get(code);
      return trust ? trust.name : code;
    }

    /**
     * Draw, or redraw, the four-hour performance chart.
     *
     * The 95 per cent standard is a declared annotation on the chart's own
     * layer rather than anything drawn over the canvas, so it sits on the
     * measure axis it belongs to and is written into the chart's accessible
     * description with the rest of it.
     *
     * @returns {void}
     */
    function drawPerfChart() {
      if (built.perfChart) { built.perfChart.destroy(); built.perfChart = null; }
      perfBox.textContent = '';
      built.perfChart = createChart({
        grid: perfGrid,
        container: perfBox,
        type: 'line',
        x: 'd',
        y: 'perf',
        series: 'n',
        title: 'Seen within four hours',
        subtitle: 'Per cent of A&E attendances admitted, transferred or discharged within four hours',
        annotations: [{
          kind: 'line',
          value: FOUR_HOUR_STANDARD,
          axis: 'left',
          label: `${FOUR_HOUR_STANDARD}% standard`,
          colour: '#b42318',
        }],
        legend: { position: 'bottom', isolate: true },
        scheme: 'colourblind',
        tooltip: true,
        axis: { x: { title: '' }, y: { title: 'Per cent', min: 0, max: 100 } },
        footnote: 'England is always drawn, whatever is ticked. All A&E types together, '
          + 'including booked appointments.',
      });
    }

    /**
     * Draw, or redraw, the waiting-list chart.
     *
     * England is deliberately not on this one. Seven million people against a
     * trust's eighty thousand is one line and a flat floor, which is a chart
     * about the axis rather than about the hospitals; the national figure is on
     * a tile above, where it can be read.
     *
     * @returns {void}
     */
    function drawListChart() {
      if (built.listChart) { built.listChart.destroy(); built.listChart = null; }
      listBox.textContent = '';
      built.listChart = createChart({
        grid: listGrid,
        container: listBox,
        type: 'line',
        x: 'd',
        y: 'tot',
        series: 'n',
        title: 'On the waiting list',
        subtitle: 'Incomplete referral-to-treatment pathways: people waiting to start treatment',
        legend: { position: 'bottom', isolate: true },
        scheme: 'colourblind',
        tooltip: true,
        axis: { x: { title: '' }, y: { title: 'People' } },
        footnote: 'The ticked trusts only. England is seven million people and would flatten every '
          + 'other line on the chart; it is on the tile above instead.',
      });
    }

    /**
     * Draw, or redraw, the ranking chart for the latest month.
     *
     * It reads the trust table itself, so the Type 1 switch and the sort above
     * it are already applied, and takes the `RANKED` busiest A&E departments out
     * of whatever that leaves. Ranking every provider would be two hundred bars
     * two pixels apart.
     *
     * @returns {void}
     */
    function drawRankChart() {
      if (built.rankChart) { built.rankChart.destroy(); built.rankChart = null; }
      rankBox.textContent = '';
      built.rankChart = createChart({
        grid: trustGrid,
        container: rankBox,
        type: 'horizontalBar',
        x: 'name',
        y: 'perf',
        /*
         * The rows a chart is handed are the grid's own DISPLAY rows, not the
         * data behind them: the binder reads each value back through
         * `grid.rows.value(row.key, column)`, so a row without a key resolves
         * to nothing and the whole chart collapses to one empty category.
         */
        rows: (grid) => {
          const rows = [];
          grid.rows.forEach((row) => { if (row && row.data && row.data.perf != null) rows.push(row); });
          rows.sort((a, b) => (b.data.at || 0) - (a.data.at || 0));
          return rows.slice(0, RANKED).sort((a, b) => b.data.perf - a.data.perf);
        },
        title: `Four hours, ${monthLabel(meta.ae.last)}`,
        subtitle: `The ${RANKED} busiest A&E departments in the table, per cent of attendances seen `
          + 'within four hours, best first',
        annotations: [{
          kind: 'line',
          value: FOUR_HOUR_STANDARD,
          label: `${FOUR_HOUR_STANDARD}% standard`,
          colour: '#b42318',
        }],
        legend: false,
        scheme: 'colourblind',
        tooltip: true,
        selection: true,
        /*
         * No axis titles on this one. A horizontal bar draws its categories up
         * the left and its measure along the bottom, but it places
         * `axis.y.title` on the left and `axis.x.title` underneath exactly as a
         * vertical bar does, so each title ends up naming the axis it is not
         * about. The unit is in the subtitle instead, where it is right.
         */
        footnote: 'Ranked among the busiest departments only, because a trust with two thousand '
          + 'attendances and one with eighty thousand are not the same question.',
      });
    }

    /**
     * Draw, or redraw, the waiting-time distribution for the trust in focus.
     *
     * @returns {void}
     */
    function drawBandChart() {
      if (built.bandChart) { built.bandChart.destroy(); built.bandChart = null; }
      bandBox.textContent = '';
      const code = focus();
      bandGrid.filters.where('focus', (row) => row.c === code);
      built.bandChart = createChart({
        grid: bandGrid,
        container: bandBox,
        type: 'bar',
        x: 'label',
        y: 'people',
        title: `How long they have waited: ${nameOf(code)}`,
        subtitle: `Everyone on that waiting list in ${monthLabel(meta.rtt.last)}, by weeks waited so far`,
        legend: false,
        scheme: 'colourblind',
        tooltip: true,
        labels: false,
        axis: { x: { title: 'Weeks waited' }, y: { title: 'People waiting' } },
        footnote: longWaitNote(code),
      });
    }

    /**
     * The tail of the distribution, said in words.
     *
     * The bars past a year are a few hundred people against a list of ninety
     * thousand, which at the scale the first bar sets is under a pixel. A
     * reader who cannot see them should be told they are there and how many,
     * rather than left to read an empty band as missing data.
     *
     * @param {string} code the provider in focus
     * @returns {string} the footnote
     */
    function longWaitNote(code) {
      const row = data.byKey.get(`${code}@${meta.rtt.last}`);
      const base = 'The first trust ticked in the table below, or England when none is. '
        + 'The source counts each week separately; these are those weeks grouped. ';
      if (!row || row.tot == null || row.g52 == null) return base;
      return `${base}${counted(row.g52)} of the ${counted(row.tot)} on this list have waited more than `
        + `52 weeks${row.g65 == null ? '' : ` and ${counted(row.g65)} more than 65`}, which is too few to `
        + 'see against the bars on the left.';
    }

    /** What the charts are drawing, in one sentence each. */
    function sayCharts() {
      const picked = chosen();
      const rows = perfGrid.rows.count();
      timeNote.textContent = picked.length
        ? `${picked.length} trust${picked.length === 1 ? '' : 's'} ticked. `
          + `${counted(rows)} months on the four-hour chart, ${counted(listGrid.rows.count())} on the `
          + `waiting-list chart, routed from one stream of ${counted(data.observations.length)}. `
          + `${monthLabel(data.months[0])} to ${monthLabel(data.months[data.months.length - 1])}.`
        : 'Nothing is ticked, so the four-hour chart shows England alone and the waiting-list chart '
          + 'shows nothing. Tick a trust in the table below.';
      latestNote.textContent =
        `${monthLabel(meta.ae.last)} for A&E and ${monthLabel(meta.rtt.last)} for the waiting list. `
        + `The distribution on the right follows the first trust ticked, which is ${nameOf(focus())}.`;
    }

    /* ---------------- the trust table ---------------- */

    const trustPanel = el('section', 'panel primary-host');
    const trustBar = el('div', 'actions');
    trustBar.append(el('span', 'actions-label', 'Tick the trusts you want. Everything above and below follows.'));

    const typeButton = el('button', 'action toggle on', 'Type 1 departments only');
    typeButton.type = 'button';
    typeButton.setAttribute('aria-pressed', 'true');
    typeButton.addEventListener('click', () => {
      const on = typeButton.getAttribute('aria-pressed') === 'true';
      setTypeOne(!on);
    });
    trustBar.append(typeButton);

    const groupButton = el('button', 'action toggle', 'Group by region');
    groupButton.type = 'button';
    groupButton.setAttribute('aria-pressed', 'false');
    groupButton.addEventListener('click', () => {
      const on = groupButton.getAttribute('aria-pressed') === 'true';
      trustGrid.columns.group(on ? [] : ['region']);
      groupButton.setAttribute('aria-pressed', String(!on));
      groupButton.classList.toggle('on', !on);
    });
    trustBar.append(groupButton);
    built.groupButton = groupButton;
    built.typeButton = typeButton;

    const trustCaption = el('p', 'panel-caption');
    trustPanel.append(trustBar, trustCaption, trustPane);
    host.append(trustPanel);

    /**
     * Show only the trusts with a Type 1 A&E department, or every provider.
     *
     * A Type 1 department is the one people mean by "A&E": consultant-led, open
     * around the clock, with resuscitation facilities. The collection also
     * carries urgent treatment centres, minor injury units and the independent
     * hospitals that hold a waiting list and no A&E at all, and putting all of
     * them in one table ranked by four-hour performance compares a walk-in
     * centre with a major trauma centre.
     *
     * @param {boolean} only true for Type 1 only
     * @returns {void}
     */
    function setTypeOne(only) {
      typeButton.setAttribute('aria-pressed', String(only));
      typeButton.classList.toggle('on', only);
      trustGrid.filters.where('type1', only ? (row) => row.type1 : null);
      trustCaption.textContent = only
        ? `${counted(meta.counts.type1)} trusts with a Type 1 A&E department: consultant-led, open around the `
          + 'clock. Every other provider in the two collections, including the ones that hold a waiting '
          + 'list and run no A&E, is hidden.'
        : `All ${counted(meta.counts.trusts)} providers in the two collections, including urgent treatment `
          + 'centres, minor injury units and the independent hospitals that hold a waiting list and run no A&E.';
      /* The chart reads the grid's filtered rows, so what changed is what it
         draws; it only has to be told to draw again. */
      if (built.rankChart) built.rankChart.draw();
    }

    /* ---------------- the tabs ---------------- */

    const tabsHost = el('section', 'tabs-host');
    host.append(tabsHost);

    const monthlyPane = el('div', 'monthly-tab');
    const monthlyBar = el('div', 'actions');
    monthlyBar.append(el('span', 'actions-label', 'Show:'));
    const measureButtons = new Map();
    for (const measure of MEASURES) {
      const button = el('button', 'action toggle', measure.label);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(measure.id === built.measure));
      button.classList.toggle('on', measure.id === built.measure);
      button.addEventListener('click', () => setMeasure(measure.id));
      monthlyBar.append(button);
      measureButtons.set(measure.id, button);
    }
    const monthlyCaption = el('p', 'panel-caption');
    const monthlyHost = el('div', 'grid-pane');
    monthlyPane.append(monthlyBar, monthlyCaption, monthlyHost);

    const treatmentPane = el('div', 'treatment-tab');

    /**
     * Build, or rebuild, the month-by-month table for the chosen measure.
     *
     * It is rebuilt rather than reconfigured because the measure changes what
     * each cell IS: a percentage to one decimal place with a per-cent sign, or
     * a count with thousands separators. A column's format is declared when the
     * column is, so a new measure is a new set of columns, and a grid whose
     * columns are all replaced is a new grid.
     *
     * @returns {void}
     */
    function buildMonthly() {
      const measure = MEASURES.find((entry) => entry.id === built.measure);
      if (built.monthlyGrid) {
        router.detach(built.monthlyGrid);
        built.monthlyGrid.destroy();
        built.monthlyGrid = null;
      }
      monthlyHost.textContent = '';

      const columns = [{
        id: 'm',
        field: 'm',
        title: 'Month',
        header: { render: twoLineHeading('Month', 'year and month') },
        filter: { enabled: false },
        layout: fixedLayout({ width: 130, pin: 'start', resizable: false }),
      }];
      for (const trust of data.trusts) {
        columns.push({
          id: trust.c,
          field: trust.c,
          title: trust.name,
          header: { render: twoLineHeading(trust.name, `${measure.unit} · ${trust.c}`) },
          type: 'number',
          filter: { enabled: false },
          format: measure.format,
          /*
           * Declared, with a floor of 150px, which is what a two-line heading
           * needs to be read rather than ellipsised, and a flex share of
           * whatever the month column leaves. Past six or so ticked trusts the
           * floor wins and the table scrolls sideways, which is the right
           * answer: a heading cut to "University Hospi..." tells a reader
           * nothing.
           */
          layout: fixedLayout({ width: 160, min: 150, flex: 1, hidden: true }),
        });
      }

      const grid = createGrid(monthlyHost, baseGridConfig('Month by month', {
        rowKey: 'm',
        selection: 'none',
        columns,
        /*
         * Room for a name on two lines. "University Hospitals Birmingham" does
         * not fit across a fifth of a laptop screen on one line, and the answer
         * is not to cut it to "University Hospi..." -- a heading a reader
         * cannot finish is a column they cannot use. The styles let this one
         * table's headings wrap; this is the height that gives them.
         */
        headerHeight: 56,
      }));
      built.monthlyGrid = grid;
      grid.sort.set([{ col: 'm', dir: 'desc' }]);

      /*
       * One aggregate per trust, each picking that trust's reading for the
       * measure out of the month's rows. Every trust has one whether or not it
       * is ticked, because the link means an unticked trust's rows never reach
       * this route at all: its aggregate simply sees nothing, answers null, and
       * its column stays hidden.
       */
      const aggregate = {};
      for (const trust of data.trusts) {
        const code = trust.c;
        aggregate[code] = (rows) => {
          for (const row of rows) if (row.c === code) return row[measure.id];
          return null;
        };
      }
      router.attach(grid, 'obs', {
        label: 'month by month',
        rollup: { groupBy: 'm', aggregate },
        sort: { key: 'm', dir: 'desc' },
      });
      router.link(trustGrid, grid, { from: 'c', to: 'c' });

      monthlyCaption.textContent =
        `${measure.label}, one row a month, newest first, and a column for each trust you have ticked. `
        + `Every cell is ${measure.unit}. A blank cell is a month that trust made no return in, `
        + 'not a zero.';
      showMonthlyColumns();
    }

    /** Switch the month-by-month table to another measure. */
    function setMeasure(id) {
      built.measure = id;
      for (const [key, button] of measureButtons) {
        const on = key === id;
        button.setAttribute('aria-pressed', String(on));
        button.classList.toggle('on', on);
      }
      buildMonthly();
      router.load(data.stream);
    }
    built.setMeasure = setMeasure;

    /** Show a column in the month-by-month table for each ticked trust. */
    function showMonthlyColumns() {
      if (!built.monthlyGrid) return;
      const picked = new Set(chosen());
      const show = [];
      const hide = [];
      for (const trust of data.trusts) (picked.has(trust.c) ? show : hide).push(trust.c);
      if (hide.length) built.monthlyGrid.columns.hide(hide);
      if (show.length) built.monthlyGrid.columns.show(show);
    }

    const tabs = createTabs(tabsHost, {
      createGrid,
      tabs: [
        {
          id: 'monthly',
          label: 'Month by month',
          view: (element) => {
            element.append(monthlyPane);
            if (built.monthlyGrid) built.monthlyGrid.rows.refresh({ force: true });
            return built.monthlyGrid || {};
          },
          config: {},
        },
        {
          id: 'treatment',
          label: 'By treatment function',
          view: (element) => {
            element.append(treatmentPane);
            if (built.treatment) built.treatment.reveal();
            return built.treatment || {};
          },
          config: {},
        },
      ],
      onTabChange: () => {
        /* A grid mounted while its panel was hidden measured a box of nothing.
           Asking it to lay out again once it is on screen is all it needs. */
        window.requestAnimationFrame(() => {
          if (built.monthlyGrid) built.monthlyGrid.rows.refresh({ force: true });
          if (built.treatment) built.treatment.reveal();
        });
      },
    });
    built.tabs = tabs;

    built.treatment = root.NhsDemo.buildTreatment({
      root: treatmentPane,
      createGrid,
      createChart,
      router,
      trustGrid,
      data,
      focus,
      nameOf,
    });

    /* ---------------- the footer ---------------- */

    const footer = el('footer', 'foot');
    const credit = el('p', null, `${meta.citation} `);
    const aeLink = el('a', null, 'A&E attendances and emergency admissions');
    aeLink.href = AE_AREA;
    aeLink.target = '_blank';
    aeLink.rel = 'noopener';
    const rttLink = el('a', null, 'Referral to treatment waiting times');
    rttLink.href = RTT_AREA;
    rttLink.target = '_blank';
    rttLink.rel = 'noopener';
    credit.append(aeLink, document.createTextNode('. '), rttLink, document.createTextNode('.'));
    footer.append(credit);
    footer.append(el('p', null,
      'Every figure here is a figure NHS England published. Nothing on this page is modelled, except the '
      + 'median wait, which is estimated from the weekly waiting bands and is labelled as an estimate '
      + 'wherever it appears.'));
    host.append(footer);

    /* ---------------- keeping it all in step ---------------- */

    /**
     * Nothing ticked is not the same as everything ticked.
     *
     * With no selection the router shows a linked route its whole partition,
     * which is right for a table and wrong for a chart: five hundred and eighty
     * seven lines is not a chart. So the two time charts are narrowed here
     * instead, by a named filter on their own grids, and the page says what it
     * is doing rather than drawing a thicket.
     *
     * @returns {void}
     */
    function guardEmptySelection() {
      const none = chosen().length === 0;
      perfGrid.filters.where('none', none ? (row) => row.c === ENGLAND : null);
      listGrid.filters.where('none', none ? () => false : null);
    }

    trustGrid.on('selection:changed', () => {
      guardEmptySelection();
      showMonthlyColumns();
      drawPerfChart();
      drawListChart();
      drawBandChart();
      if (built.treatment) built.treatment.follow();
      sayCharts();
    });

    /* The trusts first, so the opening selection can be made before the
       forty-five thousand monthly rows arrive and every route is narrow from
       its first paint. */
    router.load(data.trusts);
    trustGrid.selection.set(meta.defaultSelection.map((code) => `T:${code}`));
    setTypeOne(true);
    buildMonthly();
    router.load(data.stream);

    guardEmptySelection();
    buildTiles();
    drawPerfChart();
    drawListChart();
    drawRankChart();
    drawBandChart();
    showMonthlyColumns();
    if (built.treatment) built.treatment.follow();
    sayCharts();

    /* ---------------- the live half ---------------- */

    /**
     * Re-read the newest A&E month from NHS England and route what comes back.
     *
     * One 30KB file, over the same keyed diff everything else on this page
     * arrives by: a figure NHS England has revised since the last rebuild moves,
     * and every other row is left alone, scroll, sort and tick included.
     *
     * @returns {Promise<void>} when the re-read has been applied or reported
     */
    async function topUp() {
      const result = await fetchLatestAe(meta);
      if (!result.ok) {
        built.live = { state: 'failed', reason: result.reason, rows: 0, changed: 0 };
        sayProvenance();
        return;
      }
      const merged = mergeLive(data, result.rows);
      router.apply(merged.rows.map((row) => ({ op: 'upsert', row })));
      built.live = { state: 'ok', reason: null, rows: merged.rows.length, changed: merged.changed + merged.added };
      sayProvenance();
      buildTiles();
      sayCharts();
    }
    built.topUp = topUp;

    built.chosen = chosen;
    built.focus = focus;
    built.drawRankChart = drawRankChart;
    built.setTypeOne = setTypeOne;
    built.buildTiles = buildTiles;

    built.destroy = () => {
      for (const chart of [built.perfChart, built.listChart, built.rankChart, built.bandChart]) {
        if (chart) chart.destroy();
      }
      if (built.kpi) built.kpi.destroy();
      if (built.treatment && built.treatment.destroy) built.treatment.destroy();
      tabs.destroy();
      router.destroy();
      for (const grid of [trustGrid, perfGrid, listGrid, englandGrid, bandGrid, built.monthlyGrid]) {
        if (grid) grid.destroy();
      }
    };

    return built;
  }

  root.NhsDemo.buildDashboard = buildDashboard;
})(typeof globalThis !== 'undefined' ? globalThis : window);
