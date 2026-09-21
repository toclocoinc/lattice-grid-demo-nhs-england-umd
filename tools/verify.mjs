/**
 * Load the demo in a real browser and check that it works.
 *
 * It depends on jsDelivr, because that is where the page gets the grid from:
 * this edition has no local copy of the library at all, and a check that loaded
 * one would not be checking the page. It depends on NHS England too, because
 * the page does: the newest month of A&E is re-read live when the page opens,
 * and a check that skipped it would not be checking the half of the page that
 * talks to the source. Everything else is recomputed here, in Node, from the
 * files in `data/snapshot/` rather than read back off the screen.
 *
 * Beyond "it drew something", it asserts the things this demo exists to show:
 *
 *   - the library arrived by classic script tag: there is no `type="module"`
 *     script on the page, every library tag points at the pinned release on
 *     the CDN, and each one left the global it documents;
 *   - the trust table -- the main grid -- paints data rows, and no grid on the
 *     page shows the right-hand tool rail, a column menu or a filter funnel;
 *   - the figures on the national tiles agree with the saved data, recomputed
 *     here, and a movement in a percentage is stated in percentage points;
 *   - all four charts draw: the four-hour chart with England always on it and
 *     the 95 per cent standard as an annotation line, the waiting-list chart,
 *     the ranking chart and the waiting-time distribution;
 *   - ticking a trust moves the charts, the tables and the drill-down through
 *     the router's link, with no reload, and unticking takes it away again;
 *   - the live re-read of the newest A&E month actually happened and its rows
 *     went through the router;
 *   - the month-by-month table scrolls its own rows and every measure redraws it;
 *   - the drill-down tab paints a specialty table and a chart for the trust in
 *     focus;
 *   - every column heading carries its unit, and nothing says "NaN" or uses an
 *     em dash;
 *   - at 400px wide the page does not scroll sideways and the main grid still
 *     paints rows.
 *
 * Exits non-zero when any of that fails, so it can gate a deployment.
 *
 * Usage: node tools/verify.mjs [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const args = process.argv.slice(2);
const shotIndex = args.indexOf('--shots');
const shotDir = shotIndex >= 0 ? resolve(args[shotIndex + 1]) : null;

/** The release every library tag must name, and the globals each file leaves. */
const GRID_VERSION = '1.66.0';
const CDN_BASE = `https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@${GRID_VERSION}/`;
const LIBRARY_TAGS = [
  { file: 'lattice-grid.min.js', global: 'LatticeGrid', member: 'createGrid' },
  { file: 'modules/charts.min.js', global: 'LatticeGrid', member: 'createChart' },
  { file: 'modules/data-router.min.js', global: 'LatticeGridDataRouter', member: 'createDataRouter' },
  { file: 'modules/kpi.min.js', global: 'LatticeGridKPI', member: 'createKPI' },
  { file: 'modules/tabs.min.js', global: 'LatticeGridTabs', member: 'createTabs' },
];

/** The four-hour standard, restated here rather than read off the page. */
const FOUR_HOUR_STANDARD = 95;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean);

/** The first browser on this machine that actually exists. */
async function findChrome() {
  for (const path of CHROME_CANDIDATES) {
    try {
      await access(path);
      return path;
    } catch {}
  }
  throw new Error(`No browser found. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}\nSet CHROME_PATH to point at one.`);
}

/** This check needs Node's built-in WebSocket, which arrived in Node 22. */
function requireModernNode() {
  if (typeof WebSocket === 'undefined') {
    throw new Error(
      `This check needs Node 22 or newer. You are running ${process.version}, which has no built in WebSocket.`,
    );
  }
}

/** A free TCP port, asked of the operating system. */
function freePort() {
  return new Promise((ok, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

/** `YYYY-MM` a year earlier. */
function yearBefore(month) {
  return `${Number(month.slice(0, 4)) - 1}${month.slice(4)}`;
}

const failures = [];
const notes = [];

/** Record a check and its outcome. */
function check(ok, description, detail) {
  if (ok) {
    notes.push(`  ok   ${description}${detail ? ` (${detail})` : ''}`);
  } else {
    failures.push(`${description}${detail ? ` (${detail})` : ''}`);
    notes.push(`  FAIL ${description}${detail ? ` (${detail})` : ''}`);
  }
}

let browser;
let browserPid = null;
let profile;
let server;

try {
  requireModernNode();
  const chromePath = await findChrome();
  const started = await startServer(0);
  server = started.server;
  const origin = `http://127.0.0.1:${started.port}`;
  console.log(`Browser: ${chromePath}`);
  console.log(`Serving: ${origin}`);

  profile = await mkdtemp(join(tmpdir(), 'nhs-umd-demo-verify-'));
  const port = await freePort();
  browser = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  browserPid = browser.pid;
  browser.stderr.on('data', () => {});

  let wsUrl;
  for (let i = 0; i < 150 && !wsUrl; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) wsUrl = (await response.json()).webSocketDebuggerUrl;
    } catch {}
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) throw new Error('the browser never opened its debugging port');

  const socket = new WebSocket(wsUrl);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = () => fail(new Error('could not attach to the browser'));
  });

  let nextId = 0;
  const pending = new Map();
  let consoleErrors = [];
  let consoleWarnings = [];
  let pageErrors = [];

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id != null && pending.has(message.id)) {
      const { resolve: ok, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else ok(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'warning') {
      consoleWarnings.push(message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      pageErrors.push(details.exception?.description || details.text);
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      consoleErrors.push(message.params.entry.text);
    }
  };

  const send = (method, params = {}, sessionId) =>
    new Promise((ok, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: ok, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Log.enable');
  await call('Network.enable');
  /* 1280 is the width the demo is reviewed and screenshotted at. */
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text + ' ' + (result.exceptionDetails.exception?.description || ''));
    }
    return result.result.value;
  };

  const waitFor = async (expression, timeout, what) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      let value;
      try {
        value = await evaluate(expression);
      } catch {}
      if (value) return value;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  /** Open the page with a clean error log and wait for it to report in. */
  const open = async (url, label) => {
    consoleErrors = [];
    consoleWarnings = [];
    pageErrors = [];
    console.log(`\n--- ${label} ---\n${url}`);
    await call('Page.navigate', { url });
    await waitFor('!!(window.__nhsDemo)', 180000, `${label} to load`);
    const state = await evaluate('({ ready: window.__nhsDemo.ready, error: window.__nhsDemo.error || null })');
    if (!state.ready) throw new Error(`${label} reported a failure: ${state.error}`);
    await waitFor('window.__nhsDemo.trustGrid && window.__nhsDemo.trustGrid.rows.count() > 0', 60000, `${label} trust rows`);
    /* The live re-read runs after the page is on screen; wait for it to land so
       nothing below reads a half-applied month. */
    await waitFor('window.__nhsDemo.liveDone === true', 120000, `${label} live re-read`);
  };

  /** Save a screenshot, when a directory was asked for. */
  const shoot = async (name) => {
    if (!shotDir) return;
    await mkdir(shotDir, { recursive: true });
    const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const file = join(shotDir, `${name}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    console.log(`  shot ${file}`);
  };

  /** Complain about anything the page logged. */
  const noErrors = (label) => {
    check(consoleErrors.length === 0, `${label}: no console errors`, consoleErrors.slice(0, 3).join(' | '));
    check(pageErrors.length === 0, `${label}: no page errors`, pageErrors.slice(0, 3).join(' | '));
    /*
     * The grid's own diagnostics, which say when a configuration key had no
     * effect, a column was read that is not projected, or a value could not be
     * formatted. They are warnings rather than errors, so nothing stops; a page
     * that ignores them is a page quietly not doing what its code says. One
     * `sort:` in a config that the grid does not take cost this demo three
     * unsorted tables before anyone read the console.
     */
    const lattice = consoleWarnings.filter((line) => line.includes('[lattice]'));
    check(lattice.length === 0, `${label}: the grid logged no diagnostics`, lattice.slice(0, 3).join(' | '));
  };

  /* =================================================================== */
  /* The saved data, recomputed here so the page's figures are checked    */
  /* against something other than the page.                              */
  /* =================================================================== */

  const read = async (name) => JSON.parse(await readFile(join(root, 'data', 'snapshot', `${name}.json`), 'utf8'));
  const meta = await read('meta');
  const trusts = await read('trusts');
  const packed = await read('months');
  const bands = await read('bands');
  const functions = await read('functions');

  const months = packed.rows.map((values) => {
    const row = {};
    for (let i = 0; i < packed.fields.length; i += 1) row[packed.fields[i]] = values[i];
    return row;
  });
  const byKey = new Map(months.map((row) => [`${row.c}@${row.m}`, row]));
  const at = (code, month) => byKey.get(`${code}@${month}`) || null;
  /** The four-hour figure, recomputed here from the saved counts. */
  const fourHour = (row) => (row && row.at ? (1 - row.o4 / row.at) * 100 : null);
  const within18 = (row) => (row && row.tot ? (row.w18 / row.tot) * 100 : null);
  const near = (a, b, eps) => a != null && b != null && Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

  console.log(`  snapshot: built ${meta.builtAt}; ${meta.counts.trusts} providers `
    + `(${meta.counts.type1} Type 1), ${months.length} provider-months, ${bands.length} band rows, `
    + `${functions.length} treatment-function rows`);
  console.log(`  A&E ${meta.ae.first} to ${meta.ae.last} (${meta.ae.months} months); `
    + `RTT ${meta.rtt.first} to ${meta.rtt.last} (${meta.rtt.months} months)`);

  /* The provider rows and England's own TOTAL row must be the same total: if
     they are not, the build read a TOTAL row into the providers or dropped
     one. */
  let providerAttendances = 0;
  for (const row of months) if (row.c !== 'ENG' && row.m === meta.ae.last && row.at != null) providerAttendances += row.at;
  const englandLatest = at('ENG', meta.ae.last);
  check(englandLatest && englandLatest.at === providerAttendances,
    "England's A&E total is exactly the sum of the providers under it",
    `${englandLatest && englandLatest.at} against ${providerAttendances}`);

  /* =================================================================== */
  /* 1. The page.                                                        */
  /* =================================================================== */

  await open(`${origin}/index.html`, 'the dashboard');

  /* ---- how the library arrived ---- */

  const delivery = await evaluate(`(() => {
    const scripts = [...document.querySelectorAll('script')];
    return {
      moduleScripts: scripts.filter((s) => s.type === 'module').length,
      importmaps: scripts.filter((s) => s.type === 'importmap').length,
      librarySrcs: scripts.map((s) => s.getAttribute('src') || '').filter((src) => /cdn\\.jsdelivr\\.net/.test(src)),
      withIntegrity: scripts.filter((s) => /cdn\\.jsdelivr\\.net/.test(s.src) && s.integrity).length,
      stylesheetSrc: (document.querySelector('link[rel=stylesheet][href*="cdn.jsdelivr.net"]') || {}).href || null,
      stylesheetIntegrity: (document.querySelector('link[rel=stylesheet][href*="cdn.jsdelivr.net"]') || {}).integrity || null,
      members: {
        createGrid: typeof (window.LatticeGrid || {}).createGrid,
        createChart: typeof (window.LatticeGrid || {}).createChart,
        createDataRouter: typeof (window.LatticeGridDataRouter || {}).createDataRouter,
        createKPI: typeof (window.LatticeGridKPI || {}).createKPI,
        createTabs: typeof (window.LatticeGridTabs || {}).createTabs,
      },
    };
  })()`);
  console.log(`  library tags: ${delivery.librarySrcs.length} from the CDN, ${delivery.withIntegrity} with an integrity hash; module scripts on the page: ${delivery.moduleScripts}`);
  check(delivery.moduleScripts === 0, 'delivery: no type="module" script on the page', `${delivery.moduleScripts}`);
  check(delivery.importmaps === 0, 'delivery: no import map on the page', `${delivery.importmaps}`);
  check(delivery.librarySrcs.length === LIBRARY_TAGS.length,
    `delivery: ${LIBRARY_TAGS.length} library script tags point at the CDN`, `${delivery.librarySrcs.length}`);
  for (const tag of LIBRARY_TAGS) {
    const wanted = `${CDN_BASE}${tag.file}`;
    check(delivery.librarySrcs.includes(wanted), `delivery: ${tag.file} is loaded from the pinned ${GRID_VERSION} release`, wanted);
    check(delivery.members[tag.member] === 'function', `delivery: ${tag.file} left ${tag.global}.${tag.member} behind`, delivery.members[tag.member]);
  }
  check(delivery.withIntegrity === LIBRARY_TAGS.length, 'delivery: every library tag carries an integrity hash',
    `${delivery.withIntegrity} of ${LIBRARY_TAGS.length}`);
  check(delivery.stylesheetSrc === `${CDN_BASE}lattice-grid.min.css`,
    `delivery: the stylesheet is loaded from the pinned ${GRID_VERSION} release`, delivery.stylesheetSrc);
  check(!!delivery.stylesheetIntegrity, 'delivery: the stylesheet carries an integrity hash');

  /* ---- what was loaded, and where it went ---- */

  const loaded = await evaluate(`(() => {
    const d = window.__nhsDemo;
    return {
      trustRows: d.trustGrid.rows.count(),
      perfRows: d.perfGrid.rows.count(),
      listRows: d.listGrid.rows.count(),
      englandRows: d.englandGrid.rows.count(),
      monthlyRows: d.monthlyGrid.rows.count(),
      bandRows: d.bandGrid.rows.count(),
      chosen: d.chosen(),
      focus: d.focus(),
      watermark: d.trustGrid.licence.watermark(),
      licenceState: d.trustGrid.licence.state(),
      routes: d.router.metrics().routes.map((r) => ({ label: r.label, rows: r.rows })),
      timings: d.timings,
    };
  })()`);
  console.log(`  ${loaded.trustRows} trust rows shown, ${loaded.perfRows} months on the four-hour chart, `
    + `${loaded.listRows} on the waiting-list chart, ${loaded.englandRows} England months, `
    + `${loaded.monthlyRows} months in the table, ${loaded.bandRows} band rows`);
  console.log(`  routes: ${JSON.stringify(loaded.routes)}`);
  console.log(`  timings: ${JSON.stringify(loaded.timings)}`);
  check(loaded.trustRows === meta.counts.type1,
    'the trust table opens on the Type 1 departments alone',
    `${loaded.trustRows} of ${meta.counts.trusts}, expected ${meta.counts.type1}`);
  check(loaded.englandRows === meta.ae.months,
    "the England route holds one row a month and nothing else",
    `${loaded.englandRows}, expected ${meta.ae.months}`);
  check(loaded.chosen.length === meta.defaultSelection.length
    && meta.defaultSelection.every((code) => loaded.chosen.includes(code)),
    'the opening selection is the one the snapshot names',
    `${loaded.chosen.join(', ')}; expected ${meta.defaultSelection.join(', ')}`);
  check(loaded.watermark === false, 'no watermark on localhost', `state ${loaded.licenceState}`);
  check(loaded.routes.length >= 6, 'the router is driving every view off the one stream', `${loaded.routes.length} routes`);
  /* The four-hour chart's route carries England as well as the ticked trusts;
     the waiting-list chart's carries only the ticked ones. That difference is
     the function relation, and it is what this asserts. */
  const expectedPerf = loaded.chosen.concat(['ENG'])
    .reduce((sum, code) => sum + months.filter((row) => row.c === code).length, 0);
  const expectedList = loaded.chosen
    .reduce((sum, code) => sum + months.filter((row) => row.c === code).length, 0);
  check(loaded.perfRows === expectedPerf,
    'the four-hour route holds the ticked trusts and England', `${loaded.perfRows}, expected ${expectedPerf}`);
  check(loaded.listRows === expectedList,
    'the waiting-list route holds the ticked trusts and not England', `${loaded.listRows}, expected ${expectedList}`);

  /* One row per provider per month, in the file itself: a second row for the
     same pair is what would put two points on one month and fold a line back. */
  const pairs = new Set();
  let duplicates = 0;
  for (const row of months) {
    const key = `${row.c}@${row.m}`;
    if (pairs.has(key)) duplicates += 1;
    pairs.add(key);
  }
  check(duplicates === 0, 'the saved copy holds exactly one row per provider per month',
    `${duplicates} duplicates in ${months.length} rows`);
  /* And a trust's rows are written in date order, so a viewer that does not
     sort still gets a time series. */
  const ordered = months.filter((row) => row.c === meta.defaultSelection[0]).map((row) => row.m);
  check(ordered.every((m, i) => i === 0 || ordered[i - 1] < m),
    'and each provider\u2019s months are written oldest first', ordered.slice(0, 6).join(', '));
  /* Two providers sharing a display name would be drawn as one line with two
     points a month, which is the other way a line doubles back. The names the
     page draws are not the names in the file -- it shortens them -- so this
     reads the ones it draws. */
  const shared = await evaluate(`(() => {
    const seen = new Map();
    for (const trust of window.__nhsDemo.data.trusts) seen.set(trust.n || trust.name, (seen.get(trust.n || trust.name) || 0) + 1);
    return [...seen].filter(([, count]) => count > 1).map(([name, count]) => name + ' x' + count);
  })()`);
  const rawShared = new Map();
  for (const trust of trusts) rawShared.set(trust.name, (rawShared.get(trust.name) || 0) + 1);
  const rawDuplicates = [...rawShared].filter(([, count]) => count > 1);
  console.log(`  providers sharing a published name: ${rawDuplicates.length}`
    + `${rawDuplicates.length ? ` (${rawDuplicates.map(([n, c]) => `${n} x${c}`).join(', ')})` : ''}`);
  check(shared.length === 0, 'no two providers are drawn under one name, so no two land on one line',
    shared.slice(0, 3).join(', '));

  /* ---- the live re-read really happened ---- */

  const live = await evaluate('window.__nhsDemo.live');
  console.log(`  live re-read: ${JSON.stringify(live)}`);
  check(live.state === 'ok', 'the newest A&E month was re-read live from NHS England', live.reason || `state ${live.state}`);
  check(live.rows === meta.ae.providers,
    'the live file held every provider the saved copy holds for that month',
    `${live.rows}, expected ${meta.ae.providers}`);
  const banner = await evaluate('(document.querySelector(".freshness") || {}).textContent || ""');
  check(/re-read from NHS England/.test(banner), 'the page says the newest month came off the wire', banner.slice(0, 90));
  check(/saved copy/i.test(banner), 'and that everything else is a saved copy', banner.slice(0, 120));
  check(/never read in a browser/.test(banner),
    'and that the waiting lists are never read in a browser', banner.slice(-110));

  /* ---- the main grid, specifically ---- */

  const mainGrid = await evaluate(`(() => {
    const host = document.querySelector('.primary-host');
    const root = host && host.querySelector('.lattice');
    const viewport = root && root.querySelector('.lat-body-viewport');
    if (!root) return { found: false };
    return {
      found: true,
      dataRows: viewport ? viewport.querySelectorAll('.lat-row[data-index]').length : 0,
      bodyCells: viewport ? viewport.querySelectorAll('[role="gridcell"]').length : 0,
      columnHeaders: root.querySelectorAll('[role="columnheader"]').length,
      viewportHeight: viewport ? Math.round(viewport.getBoundingClientRect().height) : 0,
      headings: [...root.querySelectorAll('[role="columnheader"]')].map((c) => ({
        id: c.getAttribute('data-col'),
        main: (c.querySelector('.col-head-main') || {}).textContent || null,
        sub: (c.querySelector('.col-head-sub') || {}).textContent || null,
      })),
    };
  })()`);
  console.log(`  main grid: ${mainGrid.dataRows} data rows, ${mainGrid.bodyCells} body cells, `
    + `${mainGrid.columnHeaders} column headers, body ${mainGrid.viewportHeight}px tall`);
  check(mainGrid.found, 'the main grid exists');
  check(mainGrid.dataRows > 0, 'the main grid painted at least one data row',
    `${mainGrid.dataRows} data rows in a body ${mainGrid.viewportHeight}px tall`);
  check(mainGrid.bodyCells > 0, 'the main grid painted cells', `${mainGrid.bodyCells}`);

  /* Every column that carries a number says what the number is counted in. */
  const numeric = ['at', 'perf', 'w12', 'tot', 'pct18', 'g52'];
  for (const id of numeric) {
    const head = mainGrid.headings.find((h) => h.id === id);
    check(!!head && !!head.sub && head.sub.length > 0,
      `the ${id} heading carries the unit it is counted in`, head ? `${head.main} / ${head.sub}` : 'not found');
  }
  const monthly = mainGrid.headings.filter((h) => h.sub && /2\d{3}/.test(h.sub)).length;
  check(monthly >= 3, 'and the ones that are a single month say which month', `${monthly} headings name a month`);

  /* The table is sorted, and sorted by the column it says. This is not the
     order the rows arrived in: the sort is set through `grid.sort`. */
  const sorted = await evaluate(`(() => {
    const rows = [];
    window.__nhsDemo.trustGrid.rows.forEach((r) => { if (r && r.data) rows.push(r.data.at); });
    return { first: rows.slice(0, 8), descending: rows.every((v, i) => i === 0 || rows[i - 1] >= v) };
  })()`);
  console.log(`  trust table, busiest first: ${sorted.first.join(', ')}`);
  check(sorted.descending, 'the trust table is sorted by attendances, busiest first', sorted.first.join(', '));
  const busiest = trusts.filter((t) => t.type1).sort((a2, b2) => b2.at - a2.at)[0];
  check(sorted.first[0] === busiest.at, 'and the top of it is the busiest Type 1 department in the saved copy',
    `${sorted.first[0]}, expected ${busiest.at} (${busiest.name})`);

  const rails = await evaluate(`document.querySelectorAll('.lat-panel-dock').length`);
  const furniture = await evaluate(`(() => ({
    menus: document.querySelectorAll('.lat-header-menu').length,
    filters: document.querySelectorAll('.lat-header-filter').length,
    sorts: document.querySelectorAll('.lat-header-sort').length,
    movable: document.querySelectorAll('[data-movable="true"]').length,
    reorderTips: [...document.querySelectorAll('[title]')].filter((e) => /to reorder/i.test(e.getAttribute('title') || '')).length,
  }))()`);
  console.log(`  tool rails: ${rails}; header furniture: ${JSON.stringify(furniture)}`);
  check(rails === 0, 'no grid shows the right-hand tool rail', `${rails} rail(s)`);
  check(furniture.menus === 0, 'no heading carries a column menu', `${furniture.menus}`);
  check(furniture.filters === 0, 'no heading carries a filter funnel', `${furniture.filters}`);
  check(furniture.reorderTips === 0, 'no heading offers to be dragged to reorder', `${furniture.reorderTips}`);
  check(furniture.movable === 0, 'and none is marked as draggable', `${furniture.movable}`);
  check(furniture.sorts > 0, 'the sort control is still there, which is the one worth keeping', `${furniture.sorts}`);

  /* ---- the trust table says what the saved data says ---- */

  for (const code of loaded.chosen) {
    const saved = at(code, meta.ae.last);
    const shown = await evaluate(`window.__nhsDemo.trustGrid.rows.value(${JSON.stringify(`T:${code}`)}, 'at')`);
    check(shown === saved.at, `the ${code} row shows the attendances the saved copy holds`,
      `${shown}, expected ${saved.at}`);
    const perf = await evaluate(`window.__nhsDemo.trustGrid.rows.value(${JSON.stringify(`T:${code}`)}, 'perf')`);
    check(near(perf, fourHour(saved), 5e-3), `and the four-hour figure recomputed from those counts`,
      `${perf}, expected ${fourHour(saved).toFixed(1)}`);
  }

  /* ---- nothing reads NaN, nothing uses an em dash ---- */

  const textFaults = await evaluate(`(() => {
    const nan = [];
    const dashes = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walk.nextNode())) {
      const text = node.nodeValue || '';
      if (/\\bNaN\\b/.test(text)) nan.push(text.trim().slice(0, 60));
      if (text.includes('\\u2014')) dashes.push(text.trim().slice(0, 70));
    }
    return { nan: nan.slice(0, 5), dashes: dashes.slice(0, 5) };
  })()`);
  check(textFaults.nan.length === 0, 'nothing on the page reads "NaN"', textFaults.nan.join(' | '));
  check(textFaults.dashes.length === 0, 'no visible text on the page uses an em dash', textFaults.dashes.join(' | '));

  /* ---- the national tiles agree with the saved data ---- */

  const tiles = await evaluate(`(() => {
    const d = window.__nhsDemo;
    const models = d.kpi.tiles().map((t) => ({ id: t.id, value: t.value, formatted: t.formatted, label: t.label, delta: t.delta }));
    const painted = [...document.querySelectorAll('.kpi-strip .lat-kpi__value')].map((e) => ({
      text: e.textContent,
      clipped: e.scrollWidth > e.clientWidth + 1,
      bg: getComputedStyle(e.closest('.lat-kpi__tile') || e).backgroundColor,
      height: Math.round((e.closest('.lat-kpi__tile') || e).getBoundingClientRect().height),
    }));
    return { models, painted, caption: (document.querySelector('.kpi-host .panel-caption') || {}).textContent || '' };
  })()`);
  console.log(`  tiles: ${tiles.painted.map((p) => p.text).join(', ')}`);
  check(tiles.models.length === 6, 'six national tiles', `${tiles.models.length}`);
  const clipped = tiles.painted.filter((p) => p.clipped);
  check(clipped.length === 0, 'no tile figure is cut short by an ellipsis', clipped.map((p) => p.text).join(', '));
  const white = tiles.painted.filter((p) => p.bg === 'rgb(255, 255, 255)').length;
  check(white === tiles.painted.length, 'every tile is drawn on a white card', `${white} of ${tiles.painted.length}`);
  const heights = new Set(tiles.painted.map((p) => p.height));
  check(heights.size === 1, 'every tile is the same height', [...heights].join(', '));

  const englandNow = at('ENG', meta.ae.last);
  const englandAgo = at('ENG', yearBefore(meta.ae.last));
  const rttNow = at('ENG', meta.rtt.last);
  const rttAgo = at('ENG', yearBefore(meta.rtt.last));
  const tileOf = (id) => tiles.models.find((t) => t.id === id);
  check(tileOf('att') && tileOf('att').value === englandNow.at,
    'the attendances tile is England’s own published total',
    `${tileOf('att') && tileOf('att').value}, expected ${englandNow.at}`);
  check(tileOf('w12') && tileOf('w12').value === englandNow.w12,
    'the twelve-hour tile is that month’s figure', `${tileOf('w12') && tileOf('w12').value}, expected ${englandNow.w12}`);
  check(tileOf('ea') && tileOf('ea').value === englandNow.ea,
    'the emergency-admissions tile is that month’s figure', `${tileOf('ea') && tileOf('ea').value}, expected ${englandNow.ea}`);
  check(tileOf('tot') && tileOf('tot').value === rttNow.tot,
    'the waiting-list tile is the newest waiting-list month', `${tileOf('tot') && tileOf('tot').value}, expected ${rttNow.tot}`);
  /* The two percentage tiles are fed the fraction, because that is what a
     percent format takes; a hundred times it is the figure on screen. */
  check(tileOf('perf') && near(tileOf('perf').value * 100, fourHour(englandNow), 1e-6),
    'the four-hour tile is the figure recomputed from the counts',
    `${tileOf('perf') && tileOf('perf').value * 100}, expected ${fourHour(englandNow)}`);
  check(tileOf('pct18') && near(tileOf('pct18').value * 100, within18(rttNow), 1e-6),
    'the eighteen-week tile is the figure recomputed from the counts',
    `${tileOf('pct18') && tileOf('pct18').value * 100}, expected ${within18(rttNow)}`);
  check(/%$/.test((tileOf('perf') || {}).formatted || ''),
    'and it is written with a per-cent sign on it', (tileOf('perf') || {}).formatted);

  /* A movement in a percentage is in POINTS, and a movement in a count is not. */
  const perfPoints = fourHour(englandNow) - fourHour(englandAgo);
  check(/pp on a year earlier/.test((tileOf('perf') || {}).label || ''),
    'the four-hour tile states its movement in percentage points', (tileOf('perf') || {}).label);
  check(((tileOf('perf') || {}).label || '').includes(`${perfPoints > 0 ? '+' : ''}${perfPoints.toFixed(1)} pp`),
    'and that is the change in points, not a percentage of the figure',
    `${(tileOf('perf') || {}).label}; expected ${perfPoints.toFixed(1)} pp `
      + `(a percentage would be ${((perfPoints / fourHour(englandAgo)) * 100).toFixed(1)})`);
  const pct18Points = within18(rttNow) - within18(rttAgo);
  check(((tileOf('pct18') || {}).label || '').includes(`${pct18Points > 0 ? '+' : ''}${pct18Points.toFixed(1)} pp`),
    'so does the eighteen-week tile', (tileOf('pct18') || {}).label);
  const attChange = englandNow.at - englandAgo.at;
  check(((tileOf('att') || {}).label || '').includes(`${((attChange / Math.abs(englandAgo.at)) * 100).toFixed(1)}%`),
    'a count moves by a percentage, which is the right reading for it', (tileOf('att') || {}).label);
  check(!/pp\b/.test((tileOf('att') || {}).label || ''), 'and a count is never given a points line', (tileOf('att') || {}).label);
  check(tiles.models.every((t) => t.delta === null || t.delta === undefined),
    'no tile draws the panel’s own movement line, which colours every fall red',
    tiles.models.map((t) => `${t.id}:${t.delta}`).join(', '));
  check(/percentage points/.test(tiles.caption), 'the tiles say which movement is in which unit', tiles.caption.slice(0, 90));
  check(tiles.caption.includes(meta.rtt.lastLabel) && tiles.caption.includes(meta.ae.lastLabel),
    'and which month each half of them is', tiles.caption.slice(0, 140));

  /* ---- the four charts ---- */

  const chartsOf = `(() => {
    const d = window.__nhsDemo;
    const read = (chart) => {
      if (!chart) return null;
      const data = chart.data();
      return {
        kind: data && data.kind,
        series: (data.series || []).map((s) => ({ key: String(s.key), withValue: s.points.filter((p) => p.y != null).length })),
        lines: chart.element.querySelectorAll('path.lat-chartview__line').length,
        legend: [...chart.element.parentElement.querySelectorAll('.lat-chartview__legend-item, .lat-chartview__legend-label')]
          .map((e) => e.textContent.trim()).filter(Boolean),
        bars: chart.element.querySelectorAll('rect.lat-chartview__bar, rect.lat-chartview__mark').length,
        annotations: chart.element.querySelectorAll('line.lat-chartview__annotation-line, path.lat-chartview__annotation-line').length,
        annotationLabels: [...chart.element.querySelectorAll('text')].map((t) => t.textContent).filter((t) => /standard/.test(t)),
        empty: !!(data && data.empty),
        title: [...chart.element.querySelectorAll('text.lat-chartview__title')].map((t) => t.textContent),
      };
    };
    return { perf: read(d.perfChart), list: read(d.listChart), rank: read(d.rankChart), band: read(d.bandChart) };
  })()`;
  const charts = await evaluate(chartsOf);
  for (const [name, chart] of Object.entries(charts)) {
    console.log(`  ${name} chart: ${chart.kind}, ${chart.series.length} series, ${chart.lines} lines, `
      + `${chart.bars} bars, ${chart.annotations} annotation lines`);
  }
  check(charts.perf.kind === 'time', 'the four-hour chart draws a time axis rather than a row of labels', String(charts.perf.kind));
  check(charts.perf.series.length === loaded.chosen.length + 1,
    'the four-hour chart draws a line per ticked trust and one for England',
    `${charts.perf.series.length} for ${loaded.chosen.length} ticked`);
  check(charts.perf.series.every((s) => s.withValue > 0), 'every four-hour line carries readings',
    charts.perf.series.map((s) => `${s.key}:${s.withValue}`).join(', '));
  check(charts.perf.series.some((s) => s.key === 'England'), 'and England is one of them',
    charts.perf.series.map((s) => s.key).join(', '));
  check(charts.perf.annotations > 0, 'the four-hour chart draws the 95 per cent standard as an annotation line',
    `${charts.perf.annotations}`);
  check(charts.perf.annotationLabels.some((t) => t.includes(`${FOUR_HOUR_STANDARD}%`)),
    'and labels it with the standard it is', charts.perf.annotationLabels.join(' | '));
  check(charts.perf.empty === false, 'the four-hour chart is not showing its empty state');

  /*
   * A line joins its points in the order the chart met them, so a grid whose
   * rows are not in date order draws a month-by-month series as a thicket
   * doubling back on itself. These two assert the thing that stops it: each
   * series' x values strictly increasing, no month twice, and exactly as many
   * lines on the plot as there are names under it.
   */
  const timeOrder = await evaluate(`(() => {
    const read = (chart, name) => {
      const out = [];
      for (const s of chart.data().series) {
        /* A date column hands the chart the cell it holds, which here is the
           string YYYY-MM-01. ISO dates order correctly as text, so that is
           what this compares; turning them into numbers gives NaN, and NaN is
           never greater than NaN, which would make this pass on anything. */
        const xs = s.points.map((p) => String(p.x instanceof Date ? p.x.toISOString().slice(0, 10) : p.x));
        let increasing = true;
        let back = null;
        for (let i = 1; i < xs.length; i += 1) {
          if (!(xs[i] > xs[i - 1])) { increasing = false; if (back === null) back = i; }
        }
        out.push({ chart: name, key: String(s.key), points: xs.length,
          distinct: new Set(xs).size, increasing, firstBreak: back });
      }
      return out;
    };
    const d = window.__nhsDemo;
    return { series: read(d.perfChart, 'four-hour').concat(read(d.listChart, 'waiting list')),
      perfLegend: d.perfChart.element.parentElement.querySelectorAll('.lat-chartview__legend-item').length,
      listLegend: d.listChart.element.parentElement.querySelectorAll('.lat-chartview__legend-item').length,
      perfLines: d.perfChart.element.querySelectorAll('path.lat-chartview__line').length,
      listLines: d.listChart.element.querySelectorAll('path.lat-chartview__line').length };
  })()`);
  for (const entry of timeOrder.series) {
    console.log(`  ${entry.chart} / ${entry.key}: ${entry.points} points, ${entry.distinct} distinct months, `
      + `increasing ${entry.increasing}`);
  }
  const notIncreasing = timeOrder.series.filter((e) => !e.increasing);
  check(notIncreasing.length === 0,
    'every line on both time charts runs strictly left to right, so none doubles back on itself',
    notIncreasing.map((e) => `${e.chart}/${e.key} breaks at point ${e.firstBreak}`).join(', '));
  const repeated = timeOrder.series.filter((e) => e.distinct !== e.points);
  check(repeated.length === 0, 'and no line visits the same month twice',
    repeated.map((e) => `${e.chart}/${e.key}: ${e.points} points, ${e.distinct} months`).join(', '));
  console.log(`  legend entries: four-hour ${timeOrder.perfLegend} for ${timeOrder.perfLines} lines, `
    + `waiting list ${timeOrder.listLegend} for ${timeOrder.listLines} lines`);
  check(timeOrder.perfLegend === timeOrder.perfLines && timeOrder.perfLegend > 0,
    'the four-hour chart draws exactly one line per name in its legend',
    `${timeOrder.perfLines} lines, ${timeOrder.perfLegend} legend entries`);
  check(timeOrder.listLegend === timeOrder.listLines && timeOrder.listLegend > 0,
    'and so does the waiting-list chart',
    `${timeOrder.listLines} lines, ${timeOrder.listLegend} legend entries`);
  check(timeOrder.perfLines === loaded.chosen.length + 1,
    'which is one per ticked trust plus England', `${timeOrder.perfLines} for ${loaded.chosen.length} ticked`);

  check(charts.list.kind === 'time', 'the waiting-list chart draws a time axis', String(charts.list.kind));
  check(charts.list.series.length === loaded.chosen.length,
    'the waiting-list chart draws a line per ticked trust and NOT England',
    `${charts.list.series.length} for ${loaded.chosen.length} ticked`);
  check(!charts.list.series.some((s) => s.key === 'England'), 'England is off that chart on purpose',
    charts.list.series.map((s) => s.key).join(', '));
  check(charts.list.empty === false, 'the waiting-list chart is not showing its empty state');

  check(charts.rank.bars >= 15, 'the ranking chart draws a bar per trust it ranks', `${charts.rank.bars}`);
  check(charts.rank.series.length === 1 && charts.rank.series[0].withValue === 15,
    'and it ranks exactly fifteen of them', JSON.stringify(charts.rank.series));
  check(charts.rank.annotations > 0, 'the ranking chart draws the standard too', `${charts.rank.annotations}`);
  check(charts.band.bars >= 8, 'the waiting-time distribution draws a bar per bucket', `${charts.band.bars}`);
  check(charts.band.series.length === 1 && charts.band.series[0].withValue === meta.buckets.length,
    'one bar for every bucket the snapshot holds',
    `${charts.band.series[0] && charts.band.series[0].withValue}, expected ${meta.buckets.length}`);

  /* The distribution's bars are the saved counts for the trust in focus. */
  const focusBands = bands.find((row) => row.c === loaded.focus);
  const bandTotal = meta.buckets.reduce((sum, bucket) => sum + (focusBands ? focusBands[bucket.id] : 0), 0);
  const drawnBandTotal = await evaluate(`(() => {
    const s = window.__nhsDemo.bandChart.data().series[0];
    return s.points.reduce((sum, p) => sum + (p.y || 0), 0);
  })()`);
  console.log(`  distribution for ${loaded.focus}: ${drawnBandTotal} drawn, ${bandTotal} saved`);
  check(drawnBandTotal === bandTotal, 'the distribution adds up to that trust’s whole waiting list',
    `${drawnBandTotal}, expected ${bandTotal}`);
  const bandOrder = await evaluate(`window.__nhsDemo.bandChart.data().series[0].points.map((p) => String(p.label ?? p.x))`);
  check(bandOrder.join('|') === meta.buckets.map((b2) => b2.label).join('|'),
    'the distribution runs shortest wait to longest, not in whatever order the rows arrived',
    bandOrder.join(', '));

  const tailNote = await evaluate(`(window.__nhsDemo.bandChart.element.parentElement || document.body).textContent`);
  const focusRow = at(loaded.focus, meta.rtt.last);
  check(tailNote.includes('52 weeks'),
    'the distribution says in words how many have waited more than a year, because at this scale the bar is under a pixel',
    tailNote.slice(-160));

  const focusMonth = at(loaded.focus, meta.rtt.last);
  check(focusMonth && drawnBandTotal === focusMonth.tot,
    'which is the same list the table beside it reports', `${drawnBandTotal}, expected ${focusMonth && focusMonth.tot}`);

  await shoot('01-dashboard');

  /* ---- ticking a trust drives everything, through the router's link ---- */

  const before = await evaluate(`(() => {
    const d = window.__nhsDemo;
    return {
      perfRows: d.perfGrid.rows.count(),
      listRows: d.listGrid.rows.count(),
      perfSeries: d.perfChart.data().series.length,
      listSeries: d.listChart.data().series.length,
      monthlyColumns: d.monthlyGrid.columns.visible().map((c) => c.id),
      treatmentRows: d.treatment.grid.rows.count(),
    };
  })()`);
  const extra = trusts.find((trust) => trust.type1 && !meta.defaultSelection.includes(trust.c) && trust.tot);
  console.log(`  the extra trust ticked below: ${extra.c} (${extra.name})`);
  await evaluate(`(() => {
    const d = window.__nhsDemo;
    const keys = d.trustGrid.selection.keys();
    d.trustGrid.selection.set([...keys, 'T:' + ${JSON.stringify(extra.c)}]);
  })()`);
  await sleep(900);
  const after = await evaluate(`(() => {
    const d = window.__nhsDemo;
    return {
      perfRows: d.perfGrid.rows.count(),
      listRows: d.listGrid.rows.count(),
      perfSeries: d.perfChart.data().series.length,
      listSeries: d.listChart.data().series.length,
      monthlyColumns: d.monthlyGrid.columns.visible().map((c) => c.id),
      treatmentRows: d.treatment.grid.rows.count(),
      chosen: d.chosen(),
    };
  })()`);
  const extraMonths = months.filter((row) => row.c === extra.c).length;
  console.log(`  ticking ${extra.c}: four-hour rows ${before.perfRows} -> ${after.perfRows}, `
    + `lines ${before.perfSeries} -> ${after.perfSeries}, `
    + `month-by-month columns ${before.monthlyColumns.length} -> ${after.monthlyColumns.length}`);
  check(after.perfRows - before.perfRows === extraMonths,
    'exactly that trust’s months arrived on the four-hour route, and no others',
    `${after.perfRows - before.perfRows}, expected ${extraMonths}`);
  check(after.listRows - before.listRows === extraMonths,
    'and on the waiting-list route', `${after.listRows - before.listRows}, expected ${extraMonths}`);
  check(after.perfSeries === before.perfSeries + 1, 'ticking a trust draws one more four-hour line',
    `${before.perfSeries} -> ${after.perfSeries}`);
  check(after.listSeries === before.listSeries + 1, 'and one more waiting-list line',
    `${before.listSeries} -> ${after.listSeries}`);
  check(after.monthlyColumns.includes(extra.c), 'and shows its column in the month-by-month table',
    after.monthlyColumns.join(', '));

  await evaluate(`window.__nhsDemo.trustGrid.selection.set(${JSON.stringify(meta.defaultSelection.map((c) => `T:${c}`))})`);
  await sleep(900);
  const restored = await evaluate(`(() => {
    const d = window.__nhsDemo;
    return { perfRows: d.perfGrid.rows.count(), listRows: d.listGrid.rows.count(),
      columns: d.monthlyGrid.columns.visible().map((c) => c.id) };
  })()`);
  check(restored.perfRows === before.perfRows, 'unticking takes those months away again', `${restored.perfRows}`);
  check(restored.listRows === before.listRows, 'on both routes', `${restored.listRows}`);
  check(!restored.columns.includes(extra.c), 'and hides the column again', restored.columns.join(', '));

  /* ---- the Type 1 switch changes what the table and the ranking hold ---- */

  const typeSwitch = await evaluate(`(async () => {
    const d = window.__nhsDemo;
    d.setTypeOne(false);
    await new Promise((r) => setTimeout(r, 700));
    const all = { rows: d.trustGrid.rows.count(), caption: (document.querySelector('.primary-host .panel-caption') || {}).textContent };
    d.setTypeOne(true);
    await new Promise((r) => setTimeout(r, 700));
    const one = { rows: d.trustGrid.rows.count(), caption: (document.querySelector('.primary-host .panel-caption') || {}).textContent };
    return { all, one };
  })()`);
  console.log(`  Type 1 switch: ${typeSwitch.one.rows} of ${typeSwitch.all.rows} providers`);
  check(typeSwitch.all.rows === meta.counts.trusts, 'the switch off shows every provider in the two collections',
    `${typeSwitch.all.rows}, expected ${meta.counts.trusts}`);
  check(typeSwitch.one.rows === meta.counts.type1, 'and on, the Type 1 departments alone',
    `${typeSwitch.one.rows}, expected ${meta.counts.type1}`);
  check(/Type 1/.test(typeSwitch.one.caption || ''), 'the caption says which it is showing', typeSwitch.one.caption);

  /* ---- grouping by region is a real grouping ---- */

  const regions = new Set(trusts.filter((trust) => trust.type1).map((trust) => trust.region));
  const grouped = await evaluate(`(async () => {
    const d = window.__nhsDemo;
    d.groupButton.click();
    await new Promise((r) => setTimeout(r, 900));
    const on = {
      rows: d.trustGrid.rows.count(),
      groupRows: document.querySelectorAll('.primary-host .lat-row--group').length,
      labels: [...document.querySelectorAll('.primary-host .lat-row--group .lat-group-label')].map((e) => e.textContent.trim()),
      pressed: d.groupButton.getAttribute('aria-pressed'),
    };
    d.groupButton.click();
    await new Promise((r) => setTimeout(r, 900));
    return { on, offRows: d.trustGrid.rows.count(), offGroupRows: document.querySelectorAll('.primary-host .lat-row--group').length };
  })()`);
  console.log(`  grouping by region: ${grouped.on.rows} rows with ${grouped.on.groupRows} group rows drawn; `
    + `labels ${grouped.on.labels.slice(0, 4).join(', ')}`);
  check(grouped.on.groupRows > 0, 'grouping by region draws group rows', `${grouped.on.groupRows}`);
  check(grouped.on.rows === meta.counts.type1 + regions.size,
    'one group row for each region the trusts report to, on top of the trusts',
    `${grouped.on.rows}, expected ${meta.counts.type1} + ${regions.size}`);
  check(grouped.on.labels.some((label) => [...regions].some((region) => label.startsWith(region))),
    'and each group row is headed by its region', grouped.on.labels.slice(0, 3).join(' | '));
  check(grouped.on.pressed === 'true', 'the button says it is on', grouped.on.pressed);
  check(grouped.offRows === meta.counts.type1 && grouped.offGroupRows === 0,
    'and ungrouping puts the table back', `${grouped.offRows} rows, ${grouped.offGroupRows} group rows`);

  /* ---- nothing ticked is not everything ticked ---- */

  const emptied = await evaluate(`(async () => {
    const d = window.__nhsDemo;
    d.trustGrid.selection.set([]);
    await new Promise((r) => setTimeout(r, 900));
    const out = {
      perfSeries: d.perfChart.data().series.map((s) => String(s.key)),
      listRows: d.listGrid.rows.count(),
      note: (document.querySelector('.chart-note') || {}).textContent || '',
    };
    d.trustGrid.selection.set(${JSON.stringify(meta.defaultSelection.map((c) => `T:${c}`))});
    await new Promise((r) => setTimeout(r, 900));
    return out;
  })()`);
  console.log(`  nothing ticked: four-hour lines ${emptied.perfSeries.join(', ')}, waiting-list rows ${emptied.listRows}`);
  check(emptied.perfSeries.length === 1 && emptied.perfSeries[0] === 'England',
    'with nothing ticked the four-hour chart is England alone, not five hundred lines',
    emptied.perfSeries.join(', '));
  check(emptied.listRows === 0, 'and the waiting-list chart holds nothing', `${emptied.listRows}`);
  check(/Nothing is ticked/.test(emptied.note), 'and the page says so', emptied.note.slice(0, 80));

  noErrors('the dashboard');

  /* =================================================================== */
  /* 2. The month-by-month tab.                                          */
  /* =================================================================== */

  await evaluate("window.__nhsDemo.tabs.activate('monthly')");
  await sleep(900);

  const table = await evaluate(`(async () => {
    const d = window.__nhsDemo;
    const pane = document.querySelector('.monthly-tab .grid-pane');
    const root = pane && pane.querySelector('.lattice');
    const body = root && root.querySelector('.lat-body-viewport');
    const panel = document.querySelector('.tabs-host .lat-tabs__panel:not([hidden])');
    if (!body) return { found: false };
    const before = { top: body.scrollTop, panel: panel ? panel.scrollTop : 0, page: window.scrollY };
    body.scrollTop = 800;
    await new Promise((r) => setTimeout(r, 400));
    const after = { top: body.scrollTop, panel: panel ? panel.scrollTop : 0, page: window.scrollY };
    const firstVisible = body.querySelector('.lat-row[data-index]');
    const rowAt800 = firstVisible ? firstVisible.getAttribute('data-index') : null;
    body.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 300));
    return {
      found: true,
      rows: d.monthlyGrid.rows.count(),
      scrollHeight: body.scrollHeight,
      clientHeight: body.clientHeight,
      paneHeight: Math.round(pane.getBoundingClientRect().height),
      panelScrollHeight: panel ? panel.scrollHeight : 0,
      panelClientHeight: panel ? panel.clientHeight : 0,
      before, after, rowAt800,
      deadBand: panel ? Math.round(panel.getBoundingClientRect().bottom - pane.getBoundingClientRect().bottom) : null,
      bodyScrollsSideways: body.scrollWidth > body.clientWidth + 1,
      headings: [...root.querySelectorAll('[role="columnheader"]')].map((c) => ({
        id: c.getAttribute('data-col'),
        main: (c.querySelector('.col-head-main') || {}).textContent || null,
        sub: (c.querySelector('.col-head-sub') || {}).textContent || null,
        width: Math.round(c.getBoundingClientRect().width),
        clipped: (() => { const t = c.querySelector('.col-head-main'); return t ? t.scrollWidth > t.clientWidth + 1 : false; })(),
      })),
      caption: (document.querySelector('.monthly-tab .panel-caption') || {}).textContent || '',
    };
  })()`);
  console.log(`  month-by-month: ${table.rows} rows, pane ${table.paneHeight}px, body ${table.clientHeight}px of `
    + `${table.scrollHeight}px; scrollTop ${table.before.top} -> ${table.after.top}, first row then ${table.rowAt800}`);
  check(table.found, 'the month-by-month table is on its tab');
  check(table.rows === new Set(months.map((row) => row.m)).size,
    'it holds one row for every month either collection has', `${table.rows}`);
  check(table.paneHeight > 300, 'the table has a height of its own', `${table.paneHeight}px`);
  check(table.deadBand !== null && table.deadBand <= 16, 'it fills its panel, with no empty band under it',
    `${table.deadBand}px left over`);
  check(table.scrollHeight > table.clientHeight, 'it has more rows than it can show at once',
    `${table.scrollHeight} > ${table.clientHeight}`);
  check(table.after.top > 0, 'scrolling it moves its own rows', `scrollTop ${table.before.top} -> ${table.after.top}`);
  check(Number(table.rowAt800) > 0, 'and the rows underneath are reachable', `first drawn row index ${table.rowAt800}`);
  check(table.after.panel === table.before.panel && table.after.page === table.before.page,
    'the tab panel and the page itself stay put while it scrolls',
    `panel ${table.before.panel} -> ${table.after.panel}, page ${table.before.page} -> ${table.after.page}`);
  check(table.panelScrollHeight <= table.panelClientHeight + 1, 'the tab panel is not scrolling the whole table instead',
    `${table.panelScrollHeight} vs ${table.panelClientHeight}`);
  check(!table.bodyScrollsSideways, 'five ticked trusts fit across it without a sideways scroll');
  const trustHeadings = table.headings.filter((h) => h.id !== 'm');
  check(trustHeadings.length === meta.defaultSelection.length,
    'a column for each ticked trust and no more', `${trustHeadings.length}`);
  for (const head of trustHeadings) {
    check(!!head.sub && head.sub.length > 0, `the ${head.id} column says what its numbers are counted in`,
      `${head.main} / ${head.sub}`);
  }
  const cut = trustHeadings.filter((h) => h.clipped);
  check(cut.length === 0, 'no trust heading is cut short at this width', cut.map((h) => h.id).join(', '));
  check(/blank cell/i.test(table.caption), 'the table says what a blank cell means', table.caption.slice(0, 100));

  /* Its newest cell is the newest saved reading, recomputed here. */
  const newestMonth = meta.ae.last;
  for (const code of meta.defaultSelection) {
    const saved = at(code, newestMonth);
    const cell = await evaluate(`window.__nhsDemo.monthlyGrid.rows.value(${JSON.stringify(newestMonth)}, ${JSON.stringify(code)})`);
    check(near(cell, fourHour(saved), 5e-3), `the table holds ${code}'s newest four-hour figure`,
      `${cell}, expected ${fourHour(saved)} in ${newestMonth}`);
  }

  /* Every measure redraws it, in its own unit. */
  for (const measure of ['at', 'tot', 'pct18', 'g52', 'med', 'w12', 'perf']) {
    await evaluate(`window.__nhsDemo.setMeasure(${JSON.stringify(measure)})`);
    await sleep(700);
    const drawn = await evaluate(`(() => {
      const d = window.__nhsDemo;
      const root = document.querySelector('.monthly-tab .grid-pane .lattice');
      const code = d.chosen()[0];
      return {
        rows: d.monthlyGrid.rows.count(),
        painted: root.querySelectorAll('.lat-row[data-index]').length,
        value: d.monthlyGrid.rows.value(${JSON.stringify(newestMonth)}, code),
        code,
        sub: (root.querySelector('[role="columnheader"]:not([data-col="m"]) .col-head-sub') || {}).textContent || '',
        caption: (document.querySelector('.monthly-tab .panel-caption') || {}).textContent || '',
      };
    })()`);
    const saved = at(drawn.code, measure === 'tot' || measure === 'pct18' || measure === 'g52' || measure === 'med'
      ? meta.rtt.last : newestMonth);
    check(drawn.rows > 0 && drawn.painted > 0, `the "${measure}" measure paints rows`,
      `${drawn.painted} painted of ${drawn.rows}`);
    check(drawn.sub.length > 0, `the "${measure}" measure names its unit in every heading`, drawn.sub);
    check(drawn.caption.includes(drawn.sub.split(' · ')[0]), 'and the caption agrees with it',
      `${drawn.caption.slice(0, 70)} / ${drawn.sub}`);
    if (measure === 'at') {
      check(drawn.value === saved.at, 'and the attendances measure is the saved count',
        `${drawn.value}, expected ${saved.at}`);
    }
  }
  await evaluate("window.__nhsDemo.setMeasure('perf')");
  await sleep(700);

  noErrors('the month-by-month tab');

  /* =================================================================== */
  /* 3. The treatment-function tab.                                      */
  /* =================================================================== */

  await evaluate("window.__nhsDemo.tabs.activate('treatment')");
  await sleep(1400);

  const drill = await evaluate(`(() => {
    const d = window.__nhsDemo;
    const t = d.treatment;
    const chart = t.chart();
    const data = chart && chart.data();
    return {
      focus: d.focus(),
      rows: t.grid.rows.count(),
      painted: document.querySelectorAll('.treatment-tab .lat-row[data-index]').length,
      bars: chart ? chart.element.querySelectorAll('rect.lat-chartview__bar, rect.lat-chartview__mark').length : 0,
      points: data && data.series[0] ? data.series[0].points.length : 0,
      caption: (document.querySelector('.treatment-tab .panel-caption') || {}).textContent || '',
      headings: [...document.querySelectorAll('.treatment-tab [role="columnheader"]')].map((c) => ({
        id: c.getAttribute('data-col'),
        sub: (c.querySelector('.col-head-sub') || {}).textContent || null,
      })),
      first: t.grid.rows.data()[0] || null,
    };
  })()`);
  const savedFunctions = functions.filter((row) => row.c === drill.focus);
  console.log(`  drill-down: ${drill.focus}, ${drill.rows} specialties, ${drill.painted} painted, ${drill.bars} bars`);
  check(drill.rows === savedFunctions.length,
    'the drill-down holds every specialty the saved copy has for that trust',
    `${drill.rows}, expected ${savedFunctions.length}`);
  check(drill.painted > 0, 'and it painted rows', `${drill.painted}`);
  check(drill.bars >= 8, 'the specialty chart drew its bars', `${drill.bars}`);
  check(drill.points === Math.min(12, savedFunctions.length), 'twelve of them, longest queue first',
    `${drill.points}`);
  check(drill.caption.includes(meta.rtt.lastLabel), 'the caption says which month it is', drill.caption.slice(0, 110));
  for (const head of drill.headings) {
    check(!!head.sub && head.sub.length > 0, `the ${head.id} heading carries its unit`, head.sub);
  }
  const drillOrder = await evaluate(`(() => {
    const rows = [];
    window.__nhsDemo.treatment.grid.rows.forEach((r) => { if (r && r.data) rows.push(r.data.tot); });
    return { first: rows.slice(0, 5), descending: rows.every((v, i) => i === 0 || rows[i - 1] >= v) };
  })()`);
  console.log(`  drill-down, longest queue first: ${drillOrder.first.join(', ')}`);
  check(drillOrder.descending, 'the specialty table is sorted by the size of the queue, longest first',
    drillOrder.first.join(', '));

  const biggest = savedFunctions.slice().sort((a, b) => b.tot - a.tot)[0];
  const drillValue = await evaluate(`window.__nhsDemo.treatment.grid.rows.value(${JSON.stringify(biggest.id)}, 'tot')`);
  check(drillValue === biggest.tot, `the ${biggest.fn} row holds the saved figure`,
    `${drillValue}, expected ${biggest.tot}`);

  /* And it follows the selection: ticking a different trust first changes it. */
  const followed = await evaluate(`(async () => {
    const d = window.__nhsDemo;
    const other = ${JSON.stringify(extra.c)};
    d.trustGrid.selection.set(['T:' + other]);
    await new Promise((r) => setTimeout(r, 1200));
    const out = { focus: d.focus(), rows: d.treatment.grid.rows.count(),
      caption: (document.querySelector('.treatment-tab .panel-caption') || {}).textContent || '' };
    d.trustGrid.selection.set(${JSON.stringify(meta.defaultSelection.map((c) => `T:${c}`))});
    await new Promise((r) => setTimeout(r, 1200));
    return out;
  })()`);
  const otherFunctions = functions.filter((row) => row.c === extra.c);
  console.log(`  drill-down follows the selection: ${followed.focus}, ${followed.rows} specialties`);
  check(followed.focus === extra.c, 'ticking another trust moves the drill-down to it', followed.focus);
  check(followed.rows === otherFunctions.length, 'and it holds that trust’s specialties',
    `${followed.rows}, expected ${otherFunctions.length}`);

  await shoot('02-treatment');
  noErrors('the treatment-function tab');

  /* =================================================================== */
  /* 4. On a phone.                                                      */
  /* =================================================================== */

  await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 900, deviceScaleFactor: 1, mobile: true });
  await open(`${origin}/index.html`, 'the dashboard, 400px wide');

  const narrow = await evaluate(`(() => {
    const de = document.documentElement;
    const host = document.querySelector('.primary-host');
    const root = host && host.querySelector('.lattice');
    const viewport = root && root.querySelector('.lat-body-viewport');
    const widest = [];
    const clipped = (e) => getComputedStyle(e).overflowX !== 'visible';
    const walk = (e) => {
      for (const child of e.children) {
        const box = child.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;
        if (box.right > de.clientWidth + 1) {
          widest.push(String(child.className || child.tagName).slice(0, 40) + ' @' + Math.round(box.right));
        }
        if (!clipped(child)) walk(child);
      }
    };
    walk(document.body);
    return {
      clientWidth: de.clientWidth,
      scrollWidth: de.scrollWidth,
      dataRows: viewport ? viewport.querySelectorAll('.lat-row[data-index]').length : 0,
      tiles: document.querySelectorAll('.kpi-strip .lat-kpi__tile').length,
      charts: document.querySelectorAll('.chart-box svg').length,
      sticking: widest.slice(0, 5),
    };
  })()`);
  console.log(`  at 400px: scrollWidth ${narrow.scrollWidth} vs clientWidth ${narrow.clientWidth}, `
    + `${narrow.dataRows} data rows, ${narrow.tiles} tiles, ${narrow.charts} charts`);
  if (narrow.sticking.length) console.log(`  sticking out: ${narrow.sticking.join(', ')}`);
  check(narrow.scrollWidth <= narrow.clientWidth, 'at 400px: the page does not scroll sideways',
    `scrollWidth ${narrow.scrollWidth} > clientWidth ${narrow.clientWidth}; ${narrow.sticking.join(', ')}`);
  check(narrow.dataRows > 0, 'at 400px: the main grid still paints data rows', `${narrow.dataRows}`);
  check(narrow.tiles === 6, 'at 400px: the six tiles are still drawn', `${narrow.tiles}`);
  check(narrow.charts >= 4, 'at 400px: all four charts are still drawn', `${narrow.charts}`);
  await shoot('03-dashboard-400');

  await evaluate("window.__nhsDemo.tabs.activate('treatment')");
  await sleep(1400);
  const narrowDrill = await evaluate(`(() => {
    const de = document.documentElement;
    const t = window.__nhsDemo.treatment;
    return {
      scrollWidth: de.scrollWidth,
      clientWidth: de.clientWidth,
      rows: t.grid.rows.count(),
      painted: document.querySelectorAll('.treatment-tab .lat-row[data-index]').length,
      bars: t.chart() ? t.chart().element.querySelectorAll('rect.lat-chartview__bar, rect.lat-chartview__mark').length : 0,
    };
  })()`);
  console.log(`  at 400px, drill-down: scrollWidth ${narrowDrill.scrollWidth} vs ${narrowDrill.clientWidth}, `
    + `${narrowDrill.painted} painted rows, ${narrowDrill.bars} bars`);
  check(narrowDrill.scrollWidth <= narrowDrill.clientWidth, 'at 400px: the drill-down does not scroll sideways',
    `${narrowDrill.scrollWidth} > ${narrowDrill.clientWidth}`);
  check(narrowDrill.painted > 0, 'at 400px: the drill-down still paints rows', `${narrowDrill.painted}`);
  check(narrowDrill.bars >= 8, 'at 400px: the specialty chart still draws its bars', `${narrowDrill.bars}`);
  await shoot('04-treatment-400');

  noErrors('at 400px');

  socket.close();
} catch (error) {
  failures.push(String((error && error.stack) || error));
} finally {
  if (browserPid) {
    try { process.kill(-browserPid, 'SIGKILL'); } catch {}
    try { process.kill(browserPid, 'SIGKILL'); } catch {}
  }
  if (server) server.close();
  await sleep(400);
  if (profile) await rm(profile, { recursive: true, force: true });
}

console.log('\nChecks:');
for (const note of notes) console.log(note);

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`\nAll ${notes.length} checks passed.`);
process.exit(0);
