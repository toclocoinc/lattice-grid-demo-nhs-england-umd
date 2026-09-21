/**
 * Reading the saved copy, topping it up from NHS England, and working out
 * everything the page derives from it.
 *
 * Two collections, two different answers about what a browser may read.
 *
 * The A&E monthly CSVs answer with `access-control-allow-origin: *`, so this
 * page really does re-read the latest month straight from NHS England when it
 * opens, and the router applies it as a keyed diff over the saved rows. The
 * yearly index pages that link those CSVs send no such header, so a month
 * published since the last rebuild cannot be discovered from here; the page
 * says so rather than implying it is live.
 *
 * The waiting-list extracts are a 3.5MB ZIP holding an 85MB CSV per month.
 * Nothing about that belongs in a browser, so they are read in Node by
 * `tools/build-snapshot.mjs` and reduced to a row per provider per month before
 * they are ever committed.
 *
 * Nothing in this file touches the DOM or the grid.
 *
 * A classic script: it defines the global `NhsDemo` for the files that follow.
 */
(function (root) {
  'use strict';

  const SNAPSHOT = 'data/snapshot';

  /** The key England's own figures are carried under, in the same rows the
      providers are. It is never a row in the trust table. */
  const ENGLAND = 'ENG';

  /** The four-hour standard, as a percentage of attendances. */
  const FOUR_HOUR_STANDARD = 95;

  /** The referral-to-treatment standard, as a percentage of the list. */
  const EIGHTEEN_WEEK_STANDARD = 92;

  /**
   * Read the five snapshot files.
   *
   * @param {(text: string, fraction: number) => void} [onProgress] progress sink
   * @returns {Promise<object>} the saved copy
   */
  async function readSnapshot(onProgress) {
    const names = ['meta', 'trusts', 'months', 'bands', 'functions'];
    const out = {};
    for (let i = 0; i < names.length; i += 1) {
      const name = names[i];
      if (onProgress) onProgress(`Reading the saved copy (${name})...`, i / names.length);
      const response = await fetch(`${SNAPSHOT}/${name}.json`, { cache: 'no-cache' });
      if (!response.ok) {
        throw new Error(`The saved copy could not be read: ${SNAPSHOT}/${name}.json answered ${response.status}.`);
      }
      out[name] = await response.json();
    }
    /*
     * `months.json` is written as a field list and an array of arrays, because
     * forty-five thousand rows carrying their own field names fourteen times
     * over is five megabytes of the same words. This is where it becomes rows
     * again, once, before anything else sees it.
     */
    const packed = out.months;
    out.months = packed.rows.map((values) => {
      const row = { kind: 'obs', id: `${values[0]}@${values[1]}` };
      for (let i = 0; i < packed.fields.length; i += 1) row[packed.fields[i]] = values[i];
      return row;
    });
    return out;
  }

  /**
   * Re-read the latest month of A&E straight from NHS England.
   *
   * This is the live half of the page, and it is one 30KB file. The rows it
   * produces have the same keys as the saved rows for that month, so handing
   * them to the router is a keyed diff: a figure NHS England has revised since
   * the last rebuild changes, and everything else is left exactly as it is,
   * scroll and selection included.
   *
   * It is allowed to fail. NHS England's server is not this demo's to promise,
   * and a page that cannot reach it is still a page showing every figure it
   * has; the caller is told what happened and says so on screen.
   *
   * @param {object} meta the snapshot's meta
   * @returns {Promise<{ok: boolean, month: string, rows: object[], reason: string|null}>} the result
   */
  async function fetchLatestAe(meta) {
    const url = meta.ae.lastUrl;
    const month = meta.ae.last;
    try {
      const response = await fetch(url, { cache: 'no-cache' });
      if (!response.ok) return { ok: false, month, rows: [], reason: `NHS England answered ${response.status}` };
      const rows = readAeCsv(await response.text(), month);
      if (!rows.length) return { ok: false, month, rows: [], reason: 'the file held no provider rows' };
      return { ok: true, month, rows, reason: null };
    } catch (error) {
      return { ok: false, month, rows: [], reason: String((error && error.message) || error) };
    }
  }

  /**
   * Read a monthly A&E CSV into the same row shape the snapshot holds.
   *
   * The same column-matching rule the build tool uses, written again here
   * because this file reads the published CSV itself: the headings have been
   * worded three ways since 2019, and a booked appointment is a separate count
   * added to the attendances rather than a subset already inside them.
   *
   * @param {string} text the CSV
   * @param {string} month the `YYYY-MM` the rows belong to
   * @returns {object[]} the provider rows, without England's own TOTAL row
   */
  function readAeCsv(text, month) {
    const lines = text.split('\n');
    if (!lines.length) return [];
    const header = splitCsvLine(lines[0].replace(/\r$/, '')).map(normaliseHeading);
    const at = (row, test) => {
      let total = 0;
      for (let i = 0; i < header.length; i += 1) if (test(header[i])) total += number(row[i]);
      return total;
    };
    const isAttendance = (key) => key.includes('attendances') && !key.includes('over4hrs') && !key.includes('emergencyadmissions');
    const isOver = (key) => key.includes('over4hrs');
    const type1 = (key) => key.includes('type1');

    const codeAt = header.indexOf('orgcode');
    const nameAt = header.indexOf('orgname');
    const rows = [];
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i].replace(/\r$/, '');
      if (!line) continue;
      const values = line.indexOf('"') < 0 ? line.split(',') : splitCsvLine(line);
      const code = String(values[codeAt] || '').trim();
      const name = String(values[nameAt] || '').trim();
      if (!code || code.toUpperCase() === 'TOTAL' || name.toUpperCase() === 'TOTAL') continue;
      rows.push({
        kind: 'obs',
        id: `${code}@${month}`,
        c: code,
        m: month,
        at: at(values, isAttendance),
        a1: at(values, (k) => isAttendance(k) && type1(k)),
        o4: at(values, isOver),
        o41: at(values, (k) => isOver(k) && type1(k)),
        w4: at(values, (k) => k.includes('waited') && k.includes('412')),
        w12: at(values, (k) => k.includes('waited') && k.includes('12') && !k.includes('412')),
        ea: at(values, (k) => k.includes('emergencyadmissions')),
      });
    }
    return rows;
  }

  /** A heading reduced to the letters and digits in it, lower case. */
  function normaliseHeading(heading) {
    return String(heading).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
  }

  /** One CSV line split into fields, honouring double quotes. */
  function splitCsvLine(line) {
    const fields = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"') {
          if (line[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
        } else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { fields.push(field); field = ''; }
      else field += ch;
    }
    fields.push(field);
    return fields;
  }

  /** A number out of a CSV cell; a blank is a zero, not a NaN. */
  function number(value) {
    if (value == null) return 0;
    const text = String(value).trim().replace(/,/g, '');
    if (!text) return 0;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * The four-hour figure, as a percentage of attendances.
   *
   * The published standard is that 95 per cent of people attending A&E are
   * admitted, transferred or discharged within four hours. The file counts the
   * ones who were not, so the figure on the page is what is left of the whole.
   *
   * @param {object} row a provider-month row
   * @returns {number|null} the percentage, or null where there were no attendances
   */
  function fourHour(row) {
    if (!row || row.at == null || !row.at) return null;
    return (1 - row.o4 / row.at) * 100;
  }

  /** The same figure for Type 1 departments alone: the major, consultant-led ones. */
  function fourHourType1(row) {
    if (!row || row.a1 == null || !row.a1) return null;
    return (1 - row.o41 / row.a1) * 100;
  }

  /** The share of the waiting list that has been waiting less than 18 weeks. */
  function withinEighteen(row) {
    if (!row || row.tot == null || !row.tot) return null;
    return (row.w18 / row.tot) * 100;
  }

  /** `YYYY-MM` a year earlier. */
  function yearBefore(month) {
    return `${Number(month.slice(0, 4)) - 1}${month.slice(4)}`;
  }

  /** Milliseconds at UTC midnight on the first of a month, for a time axis. */
  function monthTime(month) {
    return Date.parse(`${month}-01T00:00:00Z`);
  }

  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  /** Words a trust's name keeps in lower case when it is written out. */
  const SMALL_WORDS = new Set(['and', 'of', 'the', 'for', 'in', 'on', 'upon', 'at']);
  /** Words a trust's name keeps in capitals. */
  const SHOUTED = new Set(['NHS', 'UK', 'GP', 'ICB', 'CIC', 'LLP', 'UCC', 'UTC', 'MIU', 'PHL', 'STHK']);

  /**
   * A provider's name as a person would write it.
   *
   * Both collections publish names in capitals, and a chart legend of
   * "UNIVERSITY HOSPITALS BIRMINGHAM NHS FOUNDATION TRUST" in capitals is four
   * inches of shouting for one line. The legal suffix goes too: every one of
   * them is an NHS trust, so saying so on each tells a reader nothing and costs
   * the part of the name that does.
   *
   * @param {string} name the name as published
   * @returns {string} the name as written here
   */
  function prettyName(name) {
    const trimmed = String(name || '').trim()
      .replace(/\s+NHS\s+FOUNDATION\s+TRUST$/i, '')
      .replace(/\s+NHS\s+TRUST$/i, '')
      .replace(/\s+FOUNDATION\s+TRUST$/i, '')
      .replace(/\s+TRUST$/i, '');
    if (!trimmed) return String(name || '').trim();
    /* A name already in mixed case was written by a person; leave it alone. */
    if (/[a-z]/.test(trimmed)) return trimmed;
    return trimmed.toLowerCase().split(/\s+/).map((word, index) => {
      const bare = word.replace(/[^a-z]/g, '');
      if (SHOUTED.has(bare.toUpperCase())) return word.toUpperCase();
      if (index > 0 && SMALL_WORDS.has(bare)) return word;
      return word.replace(/^[a-z]/, (ch) => ch.toUpperCase())
        .replace(/(['-])([a-z])/g, (all, mark, ch) => `${mark}${bare.length > 3 ? ch : ch.toUpperCase()}`);
    }).join(' ');
  }

  /** A month written out: `2026-08` becomes `August 2026`. */
  function monthLabel(month) {
    if (!month) return 'no month';
    return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
  }

  /**
   * The words every trust's name has in common, which is to say the words that
   * do not say which trust it is.
   *
   * "University Hospitals of Derby and Burton" is a name; "Derby and Burton"
   * is which one. The full published name is 51 characters at its longest and
   * the room a chart has for a category label is capped at two fifths of its
   * width, so the difference between shortening here and not is the difference
   * between a row of names and a row of "Barking, Havering and Redbridge U...".
   * The org code sits under the name in the table and the full published name
   * is on the cell, so nothing is lost, only unsaid.
   */
  const COMMON_WORDS = [
    /\bUniversity Hospitals\b/gi,
    /\bUniversity Healthcare\b/gi,
    /\bUniversity Hospital\b/gi,
    /\bTeaching Hospitals\b/gi,
    /\bHospitals\b/gi,
    /\bHospital\b/gi,
    /\bHealthcare\b/gi,
    /\bHealth Services\b/gi,
    /\bHealth\b/gi,
  ];

  /**
   * A provider's name with the words every provider shares taken out.
   *
   * Falls back to the whole name when what is left is too short to be a name
   * at all, which is what stops "Royal Free Hospital" becoming "Royal Free"
   * becoming nothing. Two providers that end up sharing a shortened name are
   * told apart afterwards, in `prepare`, by their org code.
   *
   * @param {string} name the name as this page writes it
   * @returns {string} the short form
   */
  function shortName(name) {
    let out = String(name || '');
    for (const word of COMMON_WORDS) out = out.replace(word, ' ');
    out = out.replace(/\s+/g, ' ')
      .replace(/^\s*(of|and|the)\s+/i, '')
      .replace(/\s+(of|and|the)\s*$/i, '')
      .replace(/\s+,/g, ',')
      .trim();
    return out.length >= 3 ? out : String(name || '').trim();
  }

  /**
   * Turn the saved copy into the rows the router is fed, and the lookups the
   * page reads.
   *
   * One stream, four kinds, all keyed by `id`:
   *
   *   `trust`     one row per provider: the table you choose from
   *   `obs`       one row per provider per month, A&E and waiting list together,
   *               plus England's own row under the code `ENG`
   *   `band`      the latest month's waiting list by waiting-time bucket
   *   `function`  the latest month's waiting list by treatment function
   *
   * Every figure the page draws is computed here, once, rather than in a chart
   * binding that would redo it on every redraw.
   *
   * @param {object} snapshot the saved copy
   * @returns {object} the prepared rows and lookups
   */
  function prepare(snapshot) {
    const meta = snapshot.meta;
    const months = [...new Set(snapshot.months.map((row) => row.m))].sort();

    const trusts = snapshot.trusts.map((trust) => {
      const published = prettyName(trust.name);
      return { ...trust, published, name: shortName(published) };
    });
    /*
     * Two providers can share a name: there are two Duchy Hospitals in the
     * waiting-list collection, under two org codes. A chart keys its series by
     * what it is called, so two rows a month would land on one line and the
     * line would double back between them every month. Where a name is shared,
     * the org code goes on the end of it -- on both of them, so neither is the
     * one that looks ordinary.
     */
    const counts = new Map();
    for (const trust of trusts) counts.set(trust.name, (counts.get(trust.name) || 0) + 1);
    for (const trust of trusts) if (counts.get(trust.name) > 1) trust.name = `${trust.name} (${trust.c})`;
    const trustByCode = new Map(trusts.map((trust) => [trust.c, trust]));
    /** The name a chart's legend shows for a provider code. */
    const labelOf = (code) => (code === ENGLAND ? 'England' : (trustByCode.get(code) || {}).name || code);

    const byKey = new Map();
    const observations = [];
    for (const row of snapshot.months) {
      const prepared = {
        ...row,
        /* `d` is the month as a date the first of, because a chart draws a time
           axis for a column the grid types as a date and a row of labels for
           one it types as text, and eighty-nine labels is not an axis. */
        d: `${row.m}-01`,
        t: monthTime(row.m),
        n: labelOf(row.c),
        perf: fourHour(row),
        perf1: fourHourType1(row),
        pct18: withinEighteen(row),
      };
      byKey.set(prepared.id, prepared);
      observations.push(prepared);
    }

    /* A month-on-a-year-earlier movement for every row that has one. It is a
       second pass because the row a year back is only in hand once every row
       is. */
    for (const row of observations) {
      const ago = byKey.get(`${row.c}@${yearBefore(row.m)}`);
      row.atYoy = ago && ago.at != null && row.at != null && ago.at ? ((row.at - ago.at) / ago.at) * 100 : null;
      row.perfYoy = ago && ago.perf != null && row.perf != null ? row.perf - ago.perf : null;
      row.totYoy = ago && ago.tot != null && row.tot != null && ago.tot ? ((row.tot - ago.tot) / ago.tot) * 100 : null;
    }

    /*
     * The waiting-time distribution arrives as one row per provider carrying a
     * column per bucket, because that is the compact way to store it. A bar
     * chart wants the other shape -- one row per bar -- so this is where it
     * becomes that, once, rather than in a chart binding that would redo it on
     * every redraw.
     */
    const bands = [];
    for (const row of snapshot.bands) {
      meta.buckets.forEach((bucket, order) => {
        bands.push({
          kind: 'band',
          id: `${row.id}|${bucket.id}`,
          c: row.c,
          n: labelOf(row.c),
          label: bucket.label,
          order,
          people: row[bucket.id] == null ? 0 : row[bucket.id],
        });
      });
    }

    const functions = snapshot.functions.map((row) => ({
      ...row,
      n: labelOf(row.c),
    }));

    const england = new Map();
    for (const row of observations) if (row.c === ENGLAND) england.set(row.m, row);

    return {
      meta,
      months,
      trusts,
      observations,
      bands,
      functions,
      byKey,
      trustByCode,
      england,
      latestAe: meta.ae.last,
      latestRtt: meta.rtt.last,
      stream: [].concat(trusts, observations, bands, functions),
    };
  }

  /**
   * Apply a freshly fetched month over the prepared rows.
   *
   * The fetched rows carry only the A&E half of a month; the waiting-list half
   * of the same provider-month is already in hand and is kept, because nothing
   * in the live file speaks to it. What comes back is the full rows, ready to
   * hand to the router, and a count of how many actually differ.
   *
   * @param {object} data the prepared data
   * @param {object[]} fetched the rows read from NHS England
   * @returns {{rows: object[], changed: number, added: number}} what to route
   */
  function mergeLive(data, fetched) {
    const rows = [];
    let changed = 0;
    let added = 0;
    for (const incoming of fetched) {
      const existing = data.byKey.get(incoming.id);
      const merged = {
        ...(existing || {
          kind: 'obs',
          id: incoming.id,
          c: incoming.c,
          m: incoming.m,
          d: `${incoming.m}-01`,
          n: incoming.c === ENGLAND ? 'England' : ((data.trustByCode.get(incoming.c) || {}).name || incoming.c),
          tot: null,
          w18: null,
          g52: null,
          g65: null,
          med: null,
        }),
        at: incoming.at,
        a1: incoming.a1,
        o4: incoming.o4,
        o41: incoming.o41,
        w4: incoming.w4,
        w12: incoming.w12,
        ea: incoming.ea,
      };
      merged.t = monthTime(merged.m);
      merged.perf = fourHour(merged);
      merged.perf1 = fourHourType1(merged);
      merged.pct18 = withinEighteen(merged);
      if (!existing) added += 1;
      else if (existing.at !== merged.at || existing.o4 !== merged.o4 || existing.w12 !== merged.w12
        || existing.ea !== merged.ea || existing.a1 !== merged.a1 || existing.o41 !== merged.o41) changed += 1;
      data.byKey.set(merged.id, merged);
      rows.push(merged);
    }
    return { rows, changed, added };
  }

  root.NhsDemo = {
    SNAPSHOT,
    ENGLAND,
    FOUR_HOUR_STANDARD,
    EIGHTEEN_WEEK_STANDARD,
    readSnapshot,
    readAeCsv,
    fetchLatestAe,
    mergeLive,
    prepare,
    prettyName,
    shortName,
    fourHour,
    fourHourType1,
    withinEighteen,
    monthLabel,
    monthTime,
    yearBefore,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
