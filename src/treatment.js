/**
 * The drill-down: one trust's waiting list broken into the specialties it is
 * waiting for.
 *
 * The headline number is one queue of seven million people, which it is not:
 * it is a hundred queues, and a trust whose list looks ordinary can be a year
 * behind in one specialty and a fortnight behind in every other. This tab is
 * that breakdown for the trust in focus, in the latest month the waiting-list
 * collection has been published for.
 *
 * It is the latest month only, deliberately. The treatment-function breakdown
 * is three and a half thousand rows for one month; keeping every month of it
 * would be a snapshot in the hundreds of megabytes for a view nobody opens on
 * a phone.
 *
 * The rows arrive through the same router as everything else, on the
 * `function` partition, narrowed by the same trust-table selection.
 *
 * A classic script: it reads `NhsDemo`, put there by `nhs-data.js`, and adds
 * `buildTreatment` alongside it.
 */
(function (root) {
  'use strict';

  const { monthLabel, EIGHTEEN_WEEK_STANDARD } = root.NhsDemo;

  /** How many specialties the chart draws, longest list first. */
  const CHARTED = 12;

  /** Make an element with a class and optional text. */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** A two-line column heading: a name, and the unit under it. */
  function twoLineHeading(main, sub) {
    return () => {
      const wrap = document.createElement('span');
      wrap.className = 'col-head';
      wrap.append(el('span', 'col-head-main', main));
      wrap.append(el('span', 'col-head-sub', sub));
      return wrap;
    };
  }

  /** A whole number with thousands separators. */
  function counted(value) {
    if (value == null || !Number.isFinite(value)) return 'no figure';
    return new Intl.NumberFormat('en-GB').format(Math.round(value));
  }

  /**
   * Build the treatment-function tab.
   *
   * @param {object} options everything it needs, all handed in
   * @param {HTMLElement} options.root where to draw
   * @param {Function} options.createGrid the grid factory
   * @param {Function} options.createChart the charts module's factory
   * @param {object} options.router the page's one router
   * @param {object} options.trustGrid the trust table, whose selection narrows this
   * @param {object} options.data the prepared data
   * @param {() => string} options.focus the trust in focus
   * @param {(code: string) => string} options.nameOf a provider's name
   * @returns {object} the tab's pieces
   */
  function buildTreatment(options) {
    const { root: host, createGrid, createChart, router, trustGrid, data, focus, nameOf } = options;
    const meta = data.meta;
    const month = monthLabel(meta.rtt.last);

    host.textContent = '';
    const caption = el('p', 'panel-caption');
    const split = el('div', 'treatment-split');
    const chartBox = el('div', 'chart-box tall');
    const gridPane = el('div', 'grid-pane');
    split.append(chartBox, gridPane);
    host.append(caption, split);

    const plain = { enabled: false };
    const grid = createGrid(gridPane, {
      rowKey: 'id',
      theme: 'light',
      density: 'compact',
      stripedRows: true,
      columnMenu: false,
      statusBar: true,
      find: true,
      title: 'The waiting list by specialty',
      selection: 'none',
      columns: [
        {
          id: 'fn',
          field: 'fn',
          title: 'Specialty',
          header: { render: twoLineHeading('Specialty', "NHS England's treatment function") },
          filter: plain,
          layout: { movable: false, width: 240, pin: 'start' },
        },
        {
          id: 'tot',
          field: 'tot',
          title: 'Waiting',
          header: { render: twoLineHeading('Waiting', 'incomplete pathways') },
          type: 'number',
          filter: plain,
          format: { type: 'number', decimals: 0 },
          layout: { movable: false, width: 140 },
        },
        {
          id: 'pct18',
          field: 'pct18',
          title: 'Waiting under 18 weeks',
          header: { render: twoLineHeading('Waiting under 18 weeks', 'per cent of that specialty') },
          type: 'number',
          filter: plain,
          format: { type: 'number', decimals: 1, suffix: '%' },
          cell: { decoration: { type: 'bar', min: 0, max: 100, origin: 0 } },
          layout: { movable: false, width: 190 },
        },
        {
          id: 'g52',
          field: 'g52',
          title: 'Waiting over 52 weeks',
          header: { render: twoLineHeading('Waiting over 52 weeks', 'people') },
          type: 'number',
          filter: plain,
          format: { type: 'number', decimals: 0 },
          layout: { movable: false, width: 160 },
        },
        {
          id: 'med',
          field: 'med',
          title: 'Median wait',
          header: { render: twoLineHeading('Median wait', 'weeks, estimated from the weekly bands') },
          type: 'number',
          filter: plain,
          format: { type: 'number', decimals: 1, suffix: ' wk' },
          layout: { movable: false, width: 170 },
        },
      ],
    });

    /* Longest queue first. Set through `grid.sort` rather than declared in the
       configuration: `createGrid({ sort: [...] })` is accepted without a word
       and does nothing. */
    grid.sort.set([{ col: 'tot', dir: 'desc' }]);

    router.attach(grid, 'function', { label: 'treatment functions' });
    router.link(trustGrid, grid, { from: 'c', to: 'c' });

    let chart = null;

    /**
     * Point the tab at the trust in focus and redraw it.
     *
     * The router has already narrowed this route to the ticked trusts; this
     * narrows it again to the first of them, because a table of a hundred
     * specialties across six trusts at once is not a drill-down, it is the
     * extract this page exists to avoid.
     *
     * @returns {void}
     */
    function follow() {
      const code = focus();
      grid.filters.where('focus', (row) => row.c === code);
      const rows = [];
      grid.rows.forEach((row) => { if (row && row.data) rows.push(row.data); });
      let waiting = 0;
      for (const row of rows) waiting += row.tot || 0;
      caption.textContent = rows.length
        ? `${nameOf(code)}, ${month}: ${counted(waiting)} people waiting across `
          + `${rows.length} specialt${rows.length === 1 ? 'y' : 'ies'}. `
          + `The standard is ${EIGHTEEN_WEEK_STANDARD} per cent of a list waiting under 18 weeks. `
          + 'The tab follows the first trust ticked in the table above.'
        : `${nameOf(code)} has no treatment-function breakdown in ${month}. `
          + 'The tab follows the first trust ticked in the table above; England itself is not broken '
          + 'down by specialty here, so tick a trust.';
      draw();
    }

    /**
     * Draw, or redraw, the specialty chart.
     *
     * @returns {void}
     */
    function draw() {
      if (chart) { chart.destroy(); chart = null; }
      chartBox.textContent = '';
      chart = createChart({
        grid,
        container: chartBox,
        type: 'horizontalBar',
        x: 'fn',
        y: 'tot',
        /* The grid's own display rows, not the data behind them: the chart's
           binder reads each value back through `grid.rows.value(row.key, ...)`,
           so a row with no key resolves to nothing. */
        rows: (bound) => {
          const rows = [];
          bound.rows.forEach((row) => { if (row && row.data && row.data.tot) rows.push(row); });
          rows.sort((a, b) => b.data.tot - a.data.tot);
          return rows.slice(0, CHARTED);
        },
        title: `The longest queues: ${nameOf(focus())}`,
        subtitle: `People waiting to start treatment, ${month}`,
        legend: false,
        scheme: 'colourblind',
        tooltip: true,
        /* No axis titles: a horizontal bar places `axis.y.title` on the left,
           where its categories are, and `axis.x.title` underneath, where its
           measure is, so each would name the axis it is not about. The subtitle
           carries the unit instead. */
        footnote: `The ${CHARTED} largest specialties. The table beside it holds every one.`,
      });
    }

    /* A grid mounted while its panel was hidden measured a box of nothing.
       Asking it to lay out again once it is on screen is all it needs. */
    function reveal() {
      grid.rows.refresh({ force: true });
      draw();
    }

    return {
      grid,
      follow,
      reveal,
      draw,
      chart: () => chart,
      destroy: () => {
        if (chart) chart.destroy();
        router.detach(grid);
        grid.destroy();
      },
    };
  }

  root.NhsDemo.buildTreatment = buildTreatment;
})(typeof globalThis !== 'undefined' ? globalThis : window);
