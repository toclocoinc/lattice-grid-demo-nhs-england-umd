# England's hospitals, month by month

**Live page:** https://toclocoinc.github.io/lattice-grid-demo-nhs-england-umd/

Every NHS trust's A&E month and elective waiting list, as NHS England publishes
them: 587 providers, 89 months of A&E back to April 2019, and 88 months of
referral-to-treatment waiting lists. The national picture on top, a trust picker
driving everything below it.

Built on Lattice Grid loaded by `<script>` tag: no npm install, no bundler, no
build step, no `type="module"`.

| | |
| --- | --- |
| Live page | [toclocoinc.github.io/lattice-grid-demo-nhs-england-umd](https://toclocoinc.github.io/lattice-grid-demo-nhs-england-umd/) |
| Grid on npm | [@toclocoinc/lattice-grid](https://www.npmjs.com/package/@toclocoinc/lattice-grid) |
| Grid repository | [toclocoinc/latticegrid](https://github.com/toclocoinc/latticegrid) |
| Product site | [latticegrid.dev](https://www.latticegrid.dev) |

Two NHS England statistical collections sit behind almost every headline written
about the health service: the monthly A&E return, which says how many people
turned up at each hospital and how long they were there, and the
referral-to-treatment return, which says how many are waiting to start treatment
and for how long. Both are published openly, by provider, every month. Both are
awkward enough to read that almost nobody does.

This page reads them.

## A note on the data, up front

The two halves of this page reach NHS England differently, and the page says
which is which rather than implying both are live.

**The A&E monthly CSVs allow a browser to read them.** Each one answers with
`access-control-allow-origin: *`, so the newest month is genuinely re-read from
`england.nhs.uk` when you open the page, and the result is applied over the
saved rows through the Data Router's keyed diff. The banner reports what came
back: how many providers were re-read, and how many figures moved.

**The pages that list those CSVs do not.** The yearly index pages send no
cross-origin header, so a browser cannot discover a file it has not been told
about. A month published since the last nightly rebuild is therefore not on this
page until the next one.

**The waiting lists are never read in a browser.** Each month is a 3.5MB ZIP
holding an 85MB CSV: every provider, every commissioner, every treatment
function, every weekly waiting band, about 180,000 rows. `tools/build-snapshot.mjs`
unzips it in Node with `node:zlib` and reduces it to one row per provider per
month before anything is committed.

## How the grid gets onto the page

Six tags in `index.html`, and that is the whole of the library setup:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.66.0/lattice-grid.min.css">

<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.66.0/lattice-grid.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.66.0/modules/charts.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.66.0/modules/data-router.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.66.0/modules/kpi.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.66.0/modules/tabs.min.js"></script>
```

Each file is the package's UMD build and leaves a global behind:

| File | Global | Used here for |
| --- | --- | --- |
| `lattice-grid.min.js` | `LatticeGrid` | the trust table, the month-by-month table, the specialty table, and four grids that are never drawn |
| `modules/charts.min.js` | `LatticeGrid.createChart` | the four-hour chart, the waiting-list chart, the ranking chart, the two distributions |
| `modules/data-router.min.js` | `LatticeGridDataRouter` | one stream, seven views |
| `modules/kpi.min.js` | `LatticeGridKPI` | the six national tiles |
| `modules/tabs.min.js` | `LatticeGridTabs` | the two tabs under the table |

The charts module folds itself into the core global rather than defining its
own, so it has to be loaded after the core. Every tag names the exact release
and carries an `integrity` hash, so the page cannot quietly pick up a different
build than the one it was checked against.

## One stream, seven views

The whole page is fed by a single Data Router. `data/snapshot/` is read once,
turned into one array holding four kinds of record, and handed over:

```js
const router = createDataRouter({ key: 'kind', rowKey: 'id', overlap: true });

router.attach(trustGrid, 'trust');                         // the table you choose from
router.attach(perfGrid, 'obs');                            // the four-hour chart
router.attach(listGrid, 'obs');                            // the waiting-list chart
router.attach(englandGrid, 'obs', { filter: (r) => r.c === 'ENG' });   // the tiles
router.attach(monthlyGrid, 'obs', { rollup: { groupBy: 'm', aggregate } });
router.attach(bandGrid, 'band');                           // the waiting-time distribution
router.attach(functionGrid, 'function');                   // the drill-down tab
```

`overlap: true` is what makes five viewers of the `obs` partition possible; with
the default, only the first of them would ever receive a row.

Ticking a trust reloads nothing. `router.link` makes the trust table's selection
a filter on what the other routes *receive*, so every chart and table is
re-pushed through the same keyed diff and keeps its scroll and its sort:

```js
router.link(trustGrid, listGrid, { from: 'c', to: 'c' });

// England has to stay on the four-hour chart whatever is ticked, because it is
// the line a trust is read against, and a key map has no way to say
// "these, and also that one".
router.link(trustGrid, perfGrid, (selected) => {
  const wanted = new Set(selected.map((row) => row.c));
  wanted.add('ENG');
  return (row) => wanted.has(row.c);
});
```

## What is on the page

**Six national tiles.** England's own figures for the newest month of each
collection: attendances, the four-hour figure, twelve-hour waits from the
decision to admit, emergency admissions, the waiting list, and the share of it
waiting under eighteen weeks. Every movement is against the same month a year
earlier, and is stated in the unit it is actually in: a count moves by a
percentage, a percentage moves by **percentage points**.

**The trust table.** One row per provider: region, attendances, the four-hour
figure, twelve-hour waits, the waiting list, the share under eighteen weeks and
the number past fifty-two weeks. Tick as many as you like; group by region; or
turn off the Type 1 filter and see all 587 providers in the two collections,
including the urgent treatment centres and the independent hospitals that hold a
waiting list and run no A&E at all.

**Four charts, all driven by that selection.** The four-hour figure over time
with England always on it and the 95 per cent standard drawn as an annotation
line; the waiting list over time; the fifteen busiest A&E departments ranked;
and the waiting-time distribution of one trust's list.

**Month by month.** One row a month, one column per ticked trust, and a switch
for which of seven measures the columns hold.

**By treatment function.** One trust's waiting list split into the specialties
it is waiting for, for the newest month, with the twelve longest queues charted
beside it. The headline number is one queue of seven million people, which it is
not: it is a hundred queues, and a trust whose list looks ordinary can be a year
behind in one specialty and a fortnight behind in every other.

## The snapshot

`tools/build-snapshot.mjs` builds `data/snapshot/`. Node 22, zero dependencies,
no key.

```
node tools/build-snapshot.mjs            # top up: refetch only what moved
node tools/build-snapshot.mjs --full     # rebuild every month from source
node tools/build-snapshot.mjs --from 2023-24
```

| File | What is in it |
| --- | --- |
| `meta.json` | what was built, when, the month ranges, the buckets, the opening selection |
| `trusts.json` | one row per provider, with the region it reports to |
| `months.json` | one row per provider per month: A&E and waiting list side by side |
| `bands.json` | the newest month's waiting list by waiting-time bucket |
| `functions.json` | the newest month's waiting list by treatment function |
| `sources.json` | the exact file each month was built from |

About 3.8MB in all, of which `months.json` is 3.1MB. It is written as a field
list and an array of arrays rather than as objects: 44,844 rows carrying their
own field names fourteen times over is five megabytes of the same words, and the
page turns it back into rows in one pass before anything sees it.

Three things in the build are worth knowing, because each of them is a way to
get the arithmetic wrong:

- **The A&E file carries its own TOTAL row.** It is England as NHS England
  computes it, and it is taken as the national figure and kept out of the
  provider rows. Adding it in doubles every England number on the page. (The
  browser check asserts that the providers add up to exactly that row.)
- **Booked appointments are a separate count, not a subset.** There are
  providers reporting booked appointments in a department type whose ordinary
  attendance count is zero, which could not happen if they were already inside
  it. Total attendances are the six columns added.
- **The waiting bands are not the same in every month.** Up to 2020 the last
  band was "Gt 52 Weeks", everything past a year in one bucket; the extracts now
  run week by week to "Gt 104 Weeks". A "more than 65 weeks" figure needs a band
  edge at 65, so a month that has none reports nothing there rather than a zero.

The median wait is an estimate. Everyone in a band waited somewhere between its
two edges and the file does not say where, so it is the point at which the
running count passes half the list, placed inside its band in proportion. It is
labelled an estimate everywhere it appears.

A scheduled workflow (`.github/workflows/refresh.yml`) rebuilds the snapshot
nightly and commits it if anything changed. It tops up rather than rebuilding:
`sources.json` records the exact file each month came from, so only a month at a
new address, and the three most recent, are read again.

## Running it

Nothing to install.

```
node tools/serve.mjs
```

Then open the address it prints. A copy running on your own machine needs no
licence key at all; the key in `src/licence.js` is tied to the domain the demo
is published on and has no effect anywhere else.

## Checking it

```
node tools/verify.mjs [--shots <dir>]
```

Opens the page in a real headless browser and asserts what it is supposed to do:
that the library arrived by classic script tag from the pinned release, that the
trust table paints rows, that the tiles agree with the saved files recomputed in
Node, that all four charts draw, that ticking a trust moves everything through
the router with no reload, that the live re-read of the newest A&E month
actually happened, that grouping by region draws a group row per region, that
every heading carries its unit, and that at 400px the page does not scroll
sideways. Exits non-zero when any of it fails, which is what gates the publish.

It needs Node 22 (for the built-in `WebSocket`), a Chrome or Chromium on the
machine, and the internet: it talks to jsDelivr because the page does, and to
NHS England because the page does.

## Source and licence

Source: NHS England, A&E Attendances and Emergency Admissions; Consultant-led
Referral to Treatment Waiting Times. Contains public sector information licensed
under the Open Government Licence v3.0.

- [A&E attendances and emergency admissions](https://www.england.nhs.uk/statistics/statistical-work-areas/ae-waiting-times-and-activity/)
- [Referral to treatment waiting times](https://www.england.nhs.uk/statistics/statistical-work-areas/rtt-waiting-times/)
- [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/)

Every figure on the page is a figure NHS England published. Nothing is modelled
except the median wait, which is described above.

The demo's own code is MIT licensed (see `LICENSE`). Lattice Grid itself is a
commercial product and is not.
