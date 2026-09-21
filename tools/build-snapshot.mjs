/**
 * Build the saved copy of the two NHS England collections this page draws.
 *
 * Node 22, zero dependencies, nothing installed. Two collections, two shapes:
 *
 *   A&E attendances and emergency admissions
 *     One CSV a month, about 30KB, one row per provider plus a TOTAL row that
 *     NHS England computes itself. Linked from a page per financial year. Every
 *     month back to April 2019 has a CSV; earlier years are .xls only and are
 *     not read here.
 *
 *   Consultant-led referral to treatment (RTT) waiting times
 *     One ZIP a month, about 3.5MB, holding a single CSV of about 85MB: every
 *     provider, every commissioner, every treatment function, every weekly
 *     waiting band. It is unzipped here in Node with `node:zlib` and reduced to
 *     one row per provider per month before anything is written.
 *
 * What comes out is `data/snapshot/`, which the page reads and nothing else:
 *
 *   meta.json     what was built, when, from where, and the month ranges
 *   trusts.json   one row per provider, with the region it reports into
 *   months.json   one row per provider per month: A&E and RTT side by side
 *   bands.json    the latest month's waiting list by waiting-time bucket
 *   functions.json the latest month's waiting list by treatment function
 *
 * Usage:
 *   node tools/build-snapshot.mjs            top up: refetch only what moved
 *   node tools/build-snapshot.mjs --full     rebuild every month from source
 *   node tools/build-snapshot.mjs --from 2023-24   start at that financial year
 *
 * Topping up is the default because the RTT half is 88 downloads of 3.5MB and
 * an 85MB decompression each. `sources.json` inside the snapshot records the
 * exact file each month was built from, so a month whose URL has not changed is
 * carried over from the previous snapshot and a month NHS England has reissued
 * under a new name is fetched again. The three most recent months are always
 * refetched, because a revision can land under the same name.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(root, 'data', 'snapshot');

/* NHS England's web server answers a bare script with a 403 often enough to
   matter. It is not a block on automated use -- the files are open data under
   the Open Government Licence -- so the request says what a browser says. */
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const AE_AREA = 'https://www.england.nhs.uk/statistics/statistical-work-areas/'
  + 'ae-waiting-times-and-activity/';
const RTT_AREA = 'https://www.england.nhs.uk/statistics/statistical-work-areas/rtt-waiting-times/';

/** The financial years walked, earliest first. April 2019 is the first month
    published as a CSV; everything before it is .xls only. */
const YEARS = ['2019-20', '2020-21', '2021-22', '2022-23', '2023-24', '2024-25', '2025-26', '2026-27'];

/** How many of the most recent months are refetched even when their URL has
    not changed, because a revision can be reissued under the same name. */
const ALWAYS_REFETCH = 3;

/**
 * The waiting-time buckets the latest month's distribution is drawn in.
 *
 * The source counts every week separately, 105 of them. A hundred and five bars
 * is not a distribution anybody reads, and the bands that carry meaning in this
 * collection are the standards: eighteen weeks is the constitutional one,
 * fifty-two and sixty-five are the ones recovery plans are written against.
 * The median below is computed from the weekly bands, not from these.
 */
const BUCKETS = [
  { id: 'b00', label: '0 to 4', from: 0, to: 4 },
  { id: 'b04', label: '4 to 8', from: 4, to: 8 },
  { id: 'b08', label: '8 to 12', from: 8, to: 12 },
  { id: 'b12', label: '12 to 18', from: 12, to: 18 },
  { id: 'b18', label: '18 to 26', from: 18, to: 26 },
  { id: 'b26', label: '26 to 36', from: 26, to: 36 },
  { id: 'b36', label: '36 to 52', from: 36, to: 52 },
  { id: 'b52', label: '52 to 65', from: 52, to: 65 },
  { id: 'b65', label: '65 to 78', from: 65, to: 78 },
  { id: 'b78', label: '78 to 104', from: 78, to: 104 },
  { id: 'b104', label: 'over 104', from: 104, to: null },
];

/**
 * The fields of one provider-month row, in the order `months.json` writes them.
 *
 *   at   attendances, every A&E type and booked appointments together
 *   a1   of those, the ones at a Type 1 (consultant-led, 24 hour) department
 *   o4   attendances where the patient was there more than four hours
 *   o41  of those, the ones at a Type 1 department
 *   w4   patients waiting 4 to 12 hours from the decision to admit
 *   w12  patients waiting more than 12 hours from the decision to admit
 *   ea   emergency admissions, via A&E and otherwise
 *   tot  the referral-to-treatment waiting list: incomplete pathways
 *   w18  of those, the ones waiting less than 18 weeks
 *   g52  waiting more than 52 weeks; g65, more than 65
 *   med  the estimated median wait in weeks
 */
const MONTH_FIELDS = ['c', 'm', 'at', 'a1', 'o4', 'o41', 'w4', 'w12', 'ea', 'tot', 'w18', 'g52', 'g65', 'med'];

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/* ------------------------------------------------------------------ */
/* Fetching                                                            */
/* ------------------------------------------------------------------ */

/**
 * Fetch a URL, retrying a few times on a server error.
 *
 * @param {string} url the address
 * @param {'text'|'buffer'} as what to return
 * @returns {Promise<string|Buffer>} the body
 */
async function get(url, as) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt) await new Promise((done) => { setTimeout(done, 1500 * attempt); });
    try {
      const response = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: '*/*' } });
      if (!response.ok) {
        lastError = new Error(`${url} answered ${response.status}`);
        continue;
      }
      if (as === 'buffer') return Buffer.from(await response.arrayBuffer());
      return await response.text();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`${url} could not be read`);
}

/* ------------------------------------------------------------------ */
/* Reading the two file formats                                        */
/* ------------------------------------------------------------------ */

/**
 * Split one CSV line into its fields, honouring double quotes.
 *
 * Both collections quote a field that holds a comma -- a commissioner called
 * "NHS HAMPSHIRE, SOUTHAMPTON AND ISLE OF WIGHT", a provider with a comma in
 * its name -- so splitting on the comma alone shifts every field after it and
 * reads a waiting-time band out of a column of names.
 *
 * @param {string} line one line, without its terminator
 * @returns {string[]} the fields
 */
function splitLine(line) {
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

/**
 * Read a whole CSV into a header and its rows.
 *
 * @param {string} text the file
 * @returns {{header: string[], rows: string[][]}} the table
 */
function parseCsv(text) {
  const lines = text.split('\n');
  const header = splitLine(stripCr(lines[0]));
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = stripCr(lines[i]);
    if (!line) continue;
    rows.push(line.indexOf('"') < 0 ? line.split(',') : splitLine(line));
  }
  return { header, rows };
}

/** Drop a trailing carriage return, for a file written on Windows. */
function stripCr(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Read the single deflated entry out of a ZIP, with no dependency.
 *
 * NHS England's RTT ZIPs hold exactly one member, deflated, written with a data
 * descriptor: the local header's compressed and uncompressed sizes are both
 * zero and the real sizes follow the compressed bytes. That is why this reads
 * the name and the extra-field length out of the local header and then hands
 * everything after it to `inflateRawSync`, which stops of its own accord at the
 * end of the deflate stream and ignores the descriptor and central directory
 * that follow. A stored (uncompressed) entry is handled too, because a future
 * month written that way should not be a crash.
 *
 * @param {Buffer} zip the whole file
 * @returns {{name: string, text: string}} the member's name and its contents
 */
function readZip(zip) {
  if (zip.readUInt32LE(0) !== 0x04034b50) throw new Error('that is not a ZIP file');
  const method = zip.readUInt16LE(8);
  const compressedSize = zip.readUInt32LE(18);
  const nameLength = zip.readUInt16LE(26);
  const extraLength = zip.readUInt16LE(28);
  const name = zip.subarray(30, 30 + nameLength).toString('latin1');
  const start = 30 + nameLength + extraLength;
  const body = compressedSize ? zip.subarray(start, start + compressedSize) : zip.subarray(start);
  if (method === 0) return { name, text: body.toString('latin1') };
  if (method !== 8) throw new Error(`${name} uses compression method ${method}, which this reader does not do`);
  const inflated = inflateRawSync(body, { maxOutputLength: 512 * 1024 * 1024 });
  /*
   * latin1 rather than utf8: the extract is a Windows-1252 file and every
   * character that matters in it is ASCII. Decoding 85MB as latin1 is a byte
   * map rather than a scan, which is most of the time this step takes.
   */
  return { name, text: inflated.toString('latin1') };
}

/* ------------------------------------------------------------------ */
/* Small shared helpers                                                */
/* ------------------------------------------------------------------ */

/** A number out of a CSV cell, with thousands separators and blanks allowed. */
function num(value) {
  if (value == null) return 0;
  const text = String(value).trim().replace(/,/g, '');
  if (!text) return 0;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** `YYYY-MM` from a month name and a year. */
function monthKey(name, year) {
  const index = MONTH_NAMES.indexOf(String(name).toLowerCase());
  if (index < 0) return null;
  return `${year}-${String(index + 1).padStart(2, '0')}`;
}

/** A month written out, for a caption. */
function monthLabel(key) {
  const [year, month] = key.split('-');
  const name = MONTH_NAMES[Number(month) - 1];
  return `${name[0].toUpperCase()}${name.slice(1)} ${year}`;
}

/** Round to a fixed number of places, or null for nothing to round. */
function round(value, places) {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Every `.csv`/`.zip` address on a page, in the order they appear.
 *
 * @param {string} html the page
 * @param {string} extension the suffix to match
 * @returns {string[]} the absolute addresses, de-duplicated
 */
function linksTo(html, extension) {
  const found = new Set();
  const pattern = new RegExp(`href="(https://[^"]+\\${extension})"`, 'gi');
  let match;
  while ((match = pattern.exec(html))) found.add(match[1]);
  return [...found];
}

/* ------------------------------------------------------------------ */
/* A&E                                                                 */
/* ------------------------------------------------------------------ */

/**
 * The column a heading names, whatever year's wording it is in.
 *
 * The same figure has been headed three ways since 2019: "Number of A&E
 * attendances Type 1" became "A&E attendances Type 1", "Other A&E Department"
 * became "Other Department" in some columns and not others, and the booked
 * appointment columns did not exist at all before 2023. Matching on a
 * normalised heading rather than an exact string is what lets one reader take
 * every month; a heading this does not recognise is reported rather than
 * ignored, because a silently unread column is a silently wrong total.
 *
 * @param {string} heading the column heading as published
 * @returns {string|null} the field it feeds, or null for one not used here
 */
function aeField(heading) {
  const key = String(heading).toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');
  const is = (...parts) => parts.every((part) => key.includes(part));
  if (is('period') && key === 'period') return 'period';
  if (key === 'orgcode') return 'code';
  if (key === 'parentorg') return 'parent';
  if (key === 'orgname') return 'name';

  const booked = key.includes('bookedappointment');
  const over = key.includes('over4hrs') || key.includes('over4hours');
  const admission = key.includes('emergencyadmissions');

  if (admission) {
    if (key.includes('otheremergencyadmissions')) return 'admissionsOther';
    if (key.includes('type1')) return 'admissionsType1';
    if (key.includes('type2')) return 'admissionsType2';
    return 'admissionsType3';
  }
  if (is('waited', '412')) return 'wait4to12';
  if (is('waited', '12')) return 'wait12plus';
  if (over) {
    if (key.includes('type1')) return booked ? 'over4BookedType1' : 'over4Type1';
    if (key.includes('type2')) return booked ? 'over4BookedType2' : 'over4Type2';
    return booked ? 'over4BookedType3' : 'over4Type3';
  }
  if (key.includes('attendances')) {
    if (key.includes('type1')) return booked ? 'bookedType1' : 'attendType1';
    if (key.includes('type2')) return booked ? 'bookedType2' : 'attendType2';
    return booked ? 'bookedType3' : 'attendType3';
  }
  return null;
}

/**
 * Reduce one month's A&E CSV to a row per provider, plus England's own total.
 *
 * Two facts about this file shape everything below. The booked-appointment
 * columns are a separate count and not a subset: there are providers reporting
 * booked appointments in a type whose ordinary attendance count is zero, which
 * could not happen if they were already inside it, so total attendances are the
 * six columns added. And the file carries its own TOTAL row, which is England
 * as NHS England computes it; it is taken as the national figure rather than
 * recomputed, and it is kept out of the provider rows, where adding it in would
 * double every England number on the page.
 *
 * @param {string} text the CSV
 * @param {string} url where it came from
 * @returns {{month: string, providers: object[], england: object, unknown: string[]}} the month
 */
function readAeMonth(text, url) {
  const { header, rows } = parseCsv(text);
  const fields = header.map(aeField);
  const unknown = header.filter((heading, index) => fields[index] === null);

  let month = null;
  const providers = [];
  let england = null;

  for (const row of rows) {
    const record = {};
    for (let i = 0; i < fields.length && i < row.length; i += 1) {
      if (!fields[i]) continue;
      record[fields[i]] = row[i];
    }
    /* `MSitAE-AUGUST-2025`, and on the TOTAL row of an older file, empty. */
    if (!month && record.period) {
      const match = /([A-Za-z]+)-(\d{4})/.exec(record.period);
      if (match) month = monthKey(match[1], match[2]);
    }
    const name = String(record.name || '').trim();
    const code = String(record.code || '').trim();
    const total = name.toUpperCase() === 'TOTAL' || code.toUpperCase() === 'TOTAL';

    const attend = num(record.attendType1) + num(record.attendType2) + num(record.attendType3)
      + num(record.bookedType1) + num(record.bookedType2) + num(record.bookedType3);
    const attendType1 = num(record.attendType1) + num(record.bookedType1);
    const over4 = num(record.over4Type1) + num(record.over4Type2) + num(record.over4Type3)
      + num(record.over4BookedType1) + num(record.over4BookedType2) + num(record.over4BookedType3);
    const over4Type1 = num(record.over4Type1) + num(record.over4BookedType1);
    const admissions = num(record.admissionsType1) + num(record.admissionsType2)
      + num(record.admissionsType3) + num(record.admissionsOther);

    const figures = {
      at: attend,
      a1: attendType1,
      o4: over4,
      o41: over4Type1,
      w4: num(record.wait4to12),
      w12: num(record.wait12plus),
      ea: admissions,
    };
    if (total) { england = figures; continue; }
    if (!code) continue;
    providers.push({ code, name, parent: String(record.parent || '').trim(), ...figures });
  }

  if (!month) throw new Error(`no period could be read out of ${url}`);
  return { month, providers, england, unknown };
}

/**
 * The region a provider reports into, from the parent NHS England names.
 *
 * Published as "NHS ENGLAND SOUTH EAST " today and as
 * "NHS ENGLAND SOUTH EAST (KENT, SURREY AND SUSSEX)" in 2019, when the regions
 * still had sub-regions inside them. The seven regions are the level the page
 * groups by, so the sub-region in brackets is dropped and the name is written
 * the way NHS England writes it in prose.
 *
 * @param {string} parent the parent organisation as published
 * @returns {string|null} the region, or null when there is nothing to read
 */
function regionOf(parent) {
  const text = String(parent || '').replace(/\(.*$/, '').replace(/^NHS ENGLAND/i, '').trim();
  if (!text || text.toUpperCase() === 'TOTAL') return null;
  return text.toLowerCase().split(/\s+/)
    .map((word) => (word === 'of' || word === 'and' ? word : `${word[0].toUpperCase()}${word.slice(1)}`))
    .join(' ');
}

/* ------------------------------------------------------------------ */
/* RTT                                                                 */
/* ------------------------------------------------------------------ */

/**
 * The weekly waiting bands a month's extract carries, read off its headings.
 *
 * The band set is not the same in every month. Up to 2020 the last band was
 * "Gt 52 Weeks SUM 1", everything past a year in one open bucket; the extracts
 * now run week by week to "Gt 103 To 104 Weeks" and close with "Gt 104 Weeks".
 * Reading the bands rather than assuming them is what lets the same code take
 * both, and it is what tells the caller honestly that a sixty-five week figure
 * cannot be had from a month whose bands stop at fifty-two.
 *
 * @param {string[]} header the extract's headings
 * @returns {{index: number, from: number, to: number|null}[]} the bands, in order
 */
function readBands(header) {
  const bands = [];
  header.forEach((heading, index) => {
    const closed = /^Gt\s+(\d+)\s+To\s+(\d+)\s+Weeks/i.exec(String(heading).trim());
    if (closed) { bands.push({ index, from: Number(closed[1]), to: Number(closed[2]) }); return; }
    const open = /^Gt\s+(\d+)\s+Weeks/i.exec(String(heading).trim());
    if (open) bands.push({ index, from: Number(open[1]), to: null });
  });
  return bands;
}

/**
 * The median wait in weeks, estimated from the weekly bands.
 *
 * Every patient in a band waited somewhere between its two edges, and the file
 * does not say where, so the median is the point at which the running count
 * passes half the list, placed inside its band in proportion to how far through
 * it the halfway point falls. That is an estimate and the page says so. A
 * median that would land in the open-ended last band has no upper edge to
 * interpolate against and is reported as nothing rather than as a number that
 * would be invented.
 *
 * @param {number[]} counts the count in each band, in band order
 * @param {{from: number, to: number|null}[]} bands the band edges
 * @returns {number|null} the median wait in weeks
 */
function medianWeeks(counts, bands) {
  let total = 0;
  for (const count of counts) total += count;
  if (!total) return null;
  const half = total / 2;
  let running = 0;
  for (let i = 0; i < bands.length; i += 1) {
    const next = running + counts[i];
    if (next >= half) {
      if (bands[i].to == null) return null;
      const within = counts[i] ? (half - running) / counts[i] : 0;
      return bands[i].from + within * (bands[i].to - bands[i].from);
    }
    running = next;
  }
  return null;
}

/**
 * Reduce one month's RTT extract to a row per provider.
 *
 * The extract is one row per provider per commissioner per treatment function
 * per pathway type, which is where its 85MB go. What is kept is the incomplete
 * pathways -- the people on the list now, which is what "the waiting list"
 * means -- summed over every commissioner, at the file's own "Total" treatment
 * function so the specialties are not added up twice.
 *
 * @param {string} text the extract
 * @param {string} url where it came from
 * @param {boolean} detail whether to keep the per-treatment-function breakdown
 * @returns {{month: string, providers: Map<string, object>, functions: object[],
 *   bands: {from: number, to: number|null}[]}} the month
 */
function readRttMonth(text, url, detail) {
  const firstBreak = text.indexOf('\n');
  const header = splitLine(stripCr(text.slice(0, firstBreak))).map((h) => h.replace(/^"|"$/g, ''));
  const bands = readBands(header);
  if (!bands.length) throw new Error(`no waiting bands found in ${url}`);

  const column = (name) => {
    const index = header.findIndex((h) => h.trim().toLowerCase() === name);
    if (index < 0) throw new Error(`${url} has no "${name}" column`);
    return index;
  };
  const iPeriod = column('period');
  const iCode = column('provider org code');
  const iName = column('provider org name');
  const iParent = column('provider parent name');
  const iDescription = column('rtt part description');
  const iFunctionCode = column('treatment function code');
  const iFunctionName = column('treatment function name');

  let month = null;
  const providers = new Map();
  const functions = new Map();

  let position = firstBreak + 1;
  while (position < text.length) {
    let end = text.indexOf('\n', position);
    if (end < 0) end = text.length;
    const line = stripCr(text.slice(position, end));
    position = end + 1;
    if (!line) continue;
    const row = line.indexOf('"') < 0 ? line.split(',') : splitLine(line);
    if (row.length < header.length) continue;

    if (!month) {
      const match = /([A-Za-z]+)-(\d{4})/.exec(row[iPeriod]);
      if (match) month = monthKey(match[1], match[2]);
    }
    /* Incomplete pathways only: people still waiting, rather than people whose
       treatment has already started. "Incomplete Pathways with DTA" is a subset
       of them and would double the list if it were added. */
    if (row[iDescription] !== 'Incomplete Pathways') continue;

    const code = row[iCode].trim();
    if (!code || /^(total|england|eng)$/i.test(code)) continue;
    const isTotalFunction = row[iFunctionCode] === 'C_999';

    if (isTotalFunction) {
      let provider = providers.get(code);
      if (!provider) {
        provider = { code, name: row[iName].trim(), icb: row[iParent].trim(), counts: new Array(bands.length).fill(0) };
        providers.set(code, provider);
      }
      for (let b = 0; b < bands.length; b += 1) {
        const cell = row[bands[b].index];
        if (cell) provider.counts[b] += num(cell);
      }
    } else if (detail) {
      const key = `${code}|${row[iFunctionCode]}`;
      let entry = functions.get(key);
      if (!entry) {
        entry = { code, fc: row[iFunctionCode], fn: row[iFunctionName].trim(), counts: new Array(bands.length).fill(0) };
        functions.set(key, entry);
      }
      for (let b = 0; b < bands.length; b += 1) {
        const cell = row[bands[b].index];
        if (cell) entry.counts[b] += num(cell);
      }
    }
  }

  if (!month) throw new Error(`no period could be read out of ${url}`);
  return { month, providers, functions: [...functions.values()], bands };
}

/**
 * Turn one provider's weekly band counts into the figures the page shows.
 *
 * @param {number[]} counts the count in each band
 * @param {{from: number, to: number|null}[]} bands the band edges
 * @returns {{tot: number, w18: number, g52: number, g65: number|null, med: number|null}} the figures
 */
function summariseBands(counts, bands) {
  let total = 0;
  let within18 = 0;
  let over52 = 0;
  let over65 = 0;
  /* A "more than 65 weeks" figure needs a band edge at 65. A month whose bands
     close at "Gt 52" has everyone past a year in one bucket, and no honest
     number can be pulled out of it, so the page is told there is none rather
     than shown a zero. */
  const hasEdgeAt = (weeks) => bands.some((band) => band.from === weeks);
  for (let i = 0; i < bands.length; i += 1) {
    const count = counts[i];
    total += count;
    if (bands[i].to !== null && bands[i].to <= 18) within18 += count;
    if (bands[i].from >= 52) over52 += count;
    if (bands[i].from >= 65) over65 += count;
  }
  return {
    tot: total,
    w18: within18,
    g52: hasEdgeAt(52) ? over52 : null,
    g65: hasEdgeAt(65) ? over65 : null,
    med: round(medianWeeks(counts, bands), 1),
  };
}

/**
 * The same counts collapsed into the buckets the distribution chart draws.
 *
 * @param {number[]} counts the count in each weekly band
 * @param {{from: number, to: number|null}[]} bands the band edges
 * @returns {number[]} one count per bucket, in `BUCKETS` order
 */
function bucketBands(counts, bands) {
  const totals = BUCKETS.map(() => 0);
  for (let i = 0; i < bands.length; i += 1) {
    const from = bands[i].from;
    let index = BUCKETS.findIndex((bucket) => from >= bucket.from && (bucket.to === null || from < bucket.to));
    if (index < 0) index = BUCKETS.length - 1;
    totals[index] += counts[i];
  }
  return totals;
}

/* ------------------------------------------------------------------ */
/* Walking the yearly pages                                            */
/* ------------------------------------------------------------------ */

/**
 * Every monthly A&E CSV NHS England links, by financial year.
 *
 * @param {string[]} years the financial years to walk
 * @returns {Promise<{year: string, url: string}[]>} the files
 */
async function findAeFiles(years) {
  const files = [];
  for (const year of years) {
    const page = await get(`${AE_AREA}ae-attendances-and-emergency-admissions-${year}/`, 'text');
    for (const url of linksTo(page, '.csv')) files.push({ year, url });
  }
  return files;
}

/**
 * Every monthly RTT ZIP NHS England links, with the month its name states.
 *
 * The month is read from the file name (`Full-CSV-data-file-Nov25-ZIP-...`)
 * rather than from inside the ZIP, because knowing the month before the
 * download is what makes topping up possible: a month already held at the same
 * address is never fetched at all.
 *
 * @param {string[]} years the financial years to walk
 * @returns {Promise<{month: string, url: string}[]>} the files, newest last
 */
async function findRttFiles(years) {
  const files = new Map();
  for (const year of years) {
    const page = await get(`${RTT_AREA}rtt-data-${year}/`, 'text');
    for (const url of linksTo(page, '.zip')) {
      const name = url.split('/').pop();
      const match = /-([A-Za-z]{3})(\d{2})-/.exec(name);
      if (!match) continue;
      const index = MONTH_ABBR.indexOf(match[1].toLowerCase());
      if (index < 0) continue;
      const month = `20${match[2]}-${String(index + 1).padStart(2, '0')}`;
      /* Two links for one month means one is a revision. The pages list the
         revision second, so the later link wins. */
      files.set(month, { month, url });
    }
  }
  return [...files.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
}

/* ------------------------------------------------------------------ */
/* The build                                                           */
/* ------------------------------------------------------------------ */

/** Read the previous snapshot, for a top-up. Missing is not an error. */
async function readPrevious() {
  try {
    const [sources, months, trusts] = await Promise.all([
      readFile(join(out, 'sources.json'), 'utf8'),
      readFile(join(out, 'months.json'), 'utf8'),
      readFile(join(out, 'trusts.json'), 'utf8'),
    ]);
    const packed = JSON.parse(months);
    const unpacked = packed.rows.map((row) => Object.fromEntries(packed.fields.map((f, i) => [f, row[i]])));
    return { sources: JSON.parse(sources), months: unpacked, trusts: JSON.parse(trusts) };
  } catch {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const full = args.includes('--full');
  const fromIndex = args.indexOf('--from');
  const years = fromIndex >= 0 ? YEARS.slice(YEARS.indexOf(args[fromIndex + 1])) : YEARS;
  if (fromIndex >= 0 && !YEARS.includes(args[fromIndex + 1])) {
    throw new Error(`--from wants one of ${YEARS.join(', ')}`);
  }

  const started = Date.now();
  const previous = full ? null : await readPrevious();
  console.log(previous ? 'Topping up the saved copy.' : 'Building the saved copy from scratch.');

  /* ---------------- A&E ---------------- */

  console.log(`\nA&E: reading the yearly pages for ${years[0]} to ${years[years.length - 1]}...`);
  const aeFiles = await findAeFiles(years);
  console.log(`A&E: ${aeFiles.length} monthly CSVs linked.`);

  const aeByMonth = new Map();
  const aeSources = {};
  const aeEngland = new Map();
  const unknownHeadings = new Set();
  const providerNames = new Map();
  const providerRegions = new Map();

  for (const file of aeFiles) {
    const text = await get(file.url, 'text');
    const month = readAeMonth(text, file.url);
    for (const heading of month.unknown) unknownHeadings.add(heading);
    /* A month linked twice -- an original and a revision -- keeps whichever
       file the page lists last, which is the revision. */
    aeByMonth.set(month.month, month.providers);
    aeSources[month.month] = file.url;
    if (month.england) aeEngland.set(month.month, month.england);
    for (const provider of month.providers) {
      providerNames.set(provider.code, provider.name);
      const region = regionOf(provider.parent);
      if (region) providerRegions.set(provider.code, region);
    }
    process.stdout.write(`\r  ${month.month}  ${month.providers.length} providers   `);
  }
  const aeMonths = [...aeByMonth.keys()].sort();
  console.log(`\nA&E: ${aeMonths.length} months, ${aeMonths[0]} to ${aeMonths[aeMonths.length - 1]}.`);
  if (unknownHeadings.size) {
    console.log(`A&E: headings not read into any figure: ${[...unknownHeadings].join(' | ')}`);
  }

  /* ---------------- RTT ---------------- */

  console.log(`\nRTT: reading the yearly pages for ${years[0]} to ${years[years.length - 1]}...`);
  const rttFiles = await findRttFiles(years);
  console.log(`RTT: ${rttFiles.length} monthly ZIPs linked.`);

  const latestRttMonth = rttFiles.length ? rttFiles[rttFiles.length - 1].month : null;
  const refetchFrom = rttFiles.length > ALWAYS_REFETCH ? rttFiles[rttFiles.length - ALWAYS_REFETCH].month : '0000-00';

  /* Carry over the rows of a month whose file has not changed. */
  const carried = new Map();
  if (previous) {
    for (const row of previous.months) {
      if (row.tot == null && row.w18 == null) continue;
      if (!carried.has(row.m)) carried.set(row.m, []);
      carried.get(row.m).push(row);
    }

  }

  const rttByMonth = new Map();
  const rttSources = {};
  let bandSet = null;
  let latestFunctions = [];
  let latestBuckets = [];
  let downloaded = 0;
  let carriedMonths = 0;

  for (const file of rttFiles) {
    const sameFile = previous && previous.sources && previous.sources.rtt
      && previous.sources.rtt[file.month] === file.url;
    const recent = file.month >= refetchFrom;
    const needDetail = file.month === latestRttMonth;
    if (sameFile && !recent && !needDetail && carried.has(file.month)) {
      rttByMonth.set(file.month, carried.get(file.month).map((row) => ({
        code: row.c, tot: row.tot, w18: row.w18, g52: row.g52, g65: row.g65, med: row.med,
      })));
      rttSources[file.month] = file.url;
      carriedMonths += 1;
      continue;
    }

    const zip = await get(file.url, 'buffer');
    const entry = readZip(zip);
    const month = readRttMonth(entry.text, file.url, needDetail);
    if (month.month !== file.month) {
      console.log(`\n  note: ${file.url} is named ${file.month} and holds ${month.month}; using ${month.month}.`);
    }
    const rows = [];
    for (const provider of month.providers.values()) {
      const summary = summariseBands(provider.counts, month.bands);
      if (!summary.tot) continue;
      rows.push({ code: provider.code, ...summary });
      if (!providerNames.has(provider.code)) providerNames.set(provider.code, provider.name);
    }
    rttByMonth.set(month.month, rows);
    rttSources[month.month] = file.url;
    downloaded += 1;

    if (needDetail) {
      bandSet = month.bands.map((band) => ({ from: band.from, to: band.to }));
      latestBuckets = [...month.providers.values()]
        .map((provider) => ({ code: provider.code, counts: bucketBands(provider.counts, month.bands) }))
        .filter((entry_) => entry_.counts.some((count) => count > 0));
      latestFunctions = month.functions
        .map((entry_) => ({ code: entry_.code, fc: entry_.fc, fn: entry_.fn, ...summariseBands(entry_.counts, month.bands) }))
        .filter((entry_) => entry_.tot > 0);
    }
    process.stdout.write(`\r  ${month.month}  ${rows.length} providers, ${Math.round(zip.length / 1024)}KB zipped   `);
  }
  const rttMonths = [...rttByMonth.keys()].sort();
  console.log(`\nRTT: ${rttMonths.length} months, ${rttMonths[0]} to ${rttMonths[rttMonths.length - 1]}; `
    + `${downloaded} fetched, ${carriedMonths} carried over unchanged.`);

  /* ---------------- one row per provider per month ---------------- */

  const rows = [];
  const seen = new Map();
  for (const [month, providers] of aeByMonth) {
    for (const provider of providers) {
      const key = `${provider.code}@${month}`;
      const row = {
        id: key, kind: 'obs', c: provider.code, m: month,
        at: provider.at, a1: provider.a1, o4: provider.o4, o41: provider.o41,
        w4: provider.w4, w12: provider.w12, ea: provider.ea,
        tot: null, w18: null, g52: null, g65: null, med: null,
      };
      seen.set(key, row);
      rows.push(row);
    }
  }
  for (const [month, providers] of rttByMonth) {
    for (const provider of providers) {
      const key = `${provider.code}@${month}`;
      const existing = seen.get(key);
      if (existing) {
        Object.assign(existing, { tot: provider.tot, w18: provider.w18, g52: provider.g52, g65: provider.g65, med: provider.med });
        continue;
      }
      const row = {
        id: key, kind: 'obs', c: provider.code, m: month,
        at: null, a1: null, o4: null, o41: null, w4: null, w12: null, ea: null,
        tot: provider.tot, w18: provider.w18, g52: provider.g52, g65: provider.g65, med: provider.med,
      };
      seen.set(key, row);
      rows.push(row);
    }
  }

  /* England, month by month: the A&E figures are the file's own TOTAL row, and
     the RTT ones are the sum of the providers, which is what "the England
     waiting list" is -- the extract publishes no total row of its own. */
  const englandRows = [];
  const allMonths = [...new Set([...aeMonths, ...rttMonths])].sort();
  for (const month of allMonths) {
    const ae = aeEngland.get(month) || {};
    let tot = null;
    let w18 = null;
    let g52 = null;
    let g65 = null;
    const providers = rttByMonth.get(month) || [];
    if (providers.length) {
      tot = 0; w18 = 0; g52 = 0; g65 = 0;
      let has52 = false;
      let has65 = false;
      for (const provider of providers) {
        tot += provider.tot;
        w18 += provider.w18;
        if (provider.g52 != null) { g52 += provider.g52; has52 = true; }
        if (provider.g65 != null) { g65 += provider.g65; has65 = true; }
      }
      if (!has52) g52 = null;
      if (!has65) g65 = null;
    }
    englandRows.push({
      id: `ENG@${month}`, kind: 'obs', c: 'ENG', m: month,
      at: ae.at ?? null, a1: ae.a1 ?? null, o4: ae.o4 ?? null, o41: ae.o41 ?? null,
      w4: ae.w4 ?? null, w12: ae.w12 ?? null, ea: ae.ea ?? null,
      tot, w18, g52, g65, med: null,
    });
  }
  rows.push(...englandRows);

  /* ---------------- one row per provider ---------------- */

  const latestAeMonth = aeMonths[aeMonths.length - 1];
  const latestAe = new Map((aeByMonth.get(latestAeMonth) || []).map((p) => [p.code, p]));
  const latestRtt = new Map((rttByMonth.get(latestRttMonth) || []).map((p) => [p.code, p]));
  const inAe = new Set();
  for (const providers of aeByMonth.values()) for (const p of providers) inAe.add(p.code);

  const trusts = [];
  for (const [code, name] of providerNames) {
    const ae = latestAe.get(code) || null;
    const rtt = latestRtt.get(code) || null;
    if (!ae && !rtt) continue;
    trusts.push({
      id: `T:${code}`,
      kind: 'trust',
      c: code,
      name,
      /* A provider that has never made an A&E return has no NHS England region
         in either collection: the waiting-list extract names the integrated
         care board that commissions it, not a region. Saying which it is beats
         showing an empty cell that reads as missing data. */
      region: providerRegions.get(code) || (inAe.has(code) ? null : 'No A&E return'),
      type1: !!(ae && ae.a1 > 0),
      hasAe: !!ae,
      at: ae ? ae.at : null,
      a1: ae ? ae.a1 : null,
      perf: ae && ae.at ? round((1 - ae.o4 / ae.at) * 100, 1) : null,
      perf1: ae && ae.a1 ? round((1 - ae.o41 / ae.a1) * 100, 1) : null,
      w12: ae ? ae.w12 : null,
      ea: ae ? ae.ea : null,
      tot: rtt ? rtt.tot : null,
      pct18: rtt && rtt.tot ? round((rtt.w18 / rtt.tot) * 100, 1) : null,
      g52: rtt ? rtt.g52 : null,
      g65: rtt ? rtt.g65 : null,
      med: rtt ? rtt.med : null,
    });
  }
  trusts.sort((a, b) => (b.at || 0) - (a.at || 0) || (b.tot || 0) - (a.tot || 0));

  /* ---------------- the latest month's detail ---------------- */

  const knownTrust = new Set(trusts.map((trust) => trust.c));
  const bands = latestBuckets
    .filter((entry) => knownTrust.has(entry.code))
    .map((entry) => ({
      id: `B:${entry.code}`, kind: 'band', c: entry.code,
      ...Object.fromEntries(BUCKETS.map((bucket, i) => [bucket.id, entry.counts[i]])),
    }));
  /* England's distribution, as the sum of every provider's. */
  if (bands.length) {
    const englandBand = { id: 'B:ENG', kind: 'band', c: 'ENG' };
    for (const bucket of BUCKETS) englandBand[bucket.id] = bands.reduce((sum, row) => sum + row[bucket.id], 0);
    bands.push(englandBand);
  }

  const functions = latestFunctions
    .filter((entry) => knownTrust.has(entry.code))
    .map((entry) => ({
      id: `F:${entry.code}|${entry.fc}`, kind: 'function', c: entry.code,
      fc: entry.fc, fn: entry.fn, tot: entry.tot, w18: entry.w18,
      pct18: entry.tot ? round((entry.w18 / entry.tot) * 100, 1) : null,
      g52: entry.g52, g65: entry.g65, med: entry.med,
    }));

  /* ---------------- write it ---------------- */

  const meta = {
    builtAt: new Date().toISOString(),
    buildSeconds: Math.round((Date.now() - started) / 1000),
    citation: 'Source: NHS England, A&E Attendances and Emergency Admissions; Consultant-led Referral to '
      + 'Treatment Waiting Times. Contains public sector information licensed under the Open Government '
      + 'Licence v3.0.',
    licence: 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
    areas: {
      ae: `${AE_AREA}`,
      rtt: `${RTT_AREA}`,
    },
    years,
    ae: {
      months: aeMonths.length,
      first: aeMonths[0],
      last: latestAeMonth,
      lastLabel: monthLabel(latestAeMonth),
      /* The one file the page re-reads live. The CSVs answer with
         `access-control-allow-origin: *`, so a browser may read this address;
         the yearly index pages do not, so a month published since this build
         cannot be discovered from the page. */
      lastUrl: aeSources[latestAeMonth],
      providers: (aeByMonth.get(latestAeMonth) || []).length,
    },
    rtt: {
      months: rttMonths.length,
      first: rttMonths[0],
      last: latestRttMonth,
      lastLabel: monthLabel(latestRttMonth),
      providers: (rttByMonth.get(latestRttMonth) || []).length,
      bands: bandSet ? bandSet.length : 0,
      bandsTo: bandSet && bandSet.length ? bandSet[bandSet.length - 1].from : null,
    },
    buckets: BUCKETS,
    counts: {
      trusts: trusts.length,
      type1: trusts.filter((trust) => trust.type1).length,
      rows: rows.length,
      bands: bands.length,
      functions: functions.length,
    },
    /* The page opens on the five largest A&E departments by attendances, which
       is a chart with something in it rather than an empty axis. */
    defaultSelection: trusts.filter((trust) => trust.type1).slice(0, 5).map((trust) => trust.c),
  };

  await mkdir(out, { recursive: true });
  const write = async (name, value) => {
    const text = `${JSON.stringify(value)}\n`;
    await writeFile(join(out, name), text);
    return text.length;
  };
  /*
   * The monthly rows are written as a header and an array of arrays rather than
   * as objects. Forty-five thousand rows of fourteen fields carry their own
   * field names forty-five thousand times, which is two thirds of the file and
   * nothing a reader of it gains: as arrays the same rows are 3MB rather than
   * 8MB, which is the difference between a page that opens and one that does
   * not. `fields` names the columns in order, and the page turns them back into
   * rows in one pass before anything sees them.
   */
  const packed = {
    fields: MONTH_FIELDS,
    rows: rows.map((row) => MONTH_FIELDS.map((field) => (row[field] === undefined ? null : row[field]))),
  };

  const sizes = {};
  sizes['meta.json'] = await write('meta.json', meta);
  sizes['trusts.json'] = await write('trusts.json', trusts);
  sizes['months.json'] = await write('months.json', packed);
  sizes['bands.json'] = await write('bands.json', bands);
  sizes['functions.json'] = await write('functions.json', functions);
  sizes['sources.json'] = await write('sources.json', { ae: aeSources, rtt: rttSources });

  console.log('\nWritten:');
  let total = 0;
  for (const [name, size] of Object.entries(sizes)) {
    total += size;
    console.log(`  ${name.padEnd(16)} ${(size / 1024).toFixed(0).padStart(7)} KB`);
  }
  console.log(`  ${'total'.padEnd(16)} ${(total / 1024 / 1024).toFixed(2).padStart(7)} MB`);
  console.log(`\n${meta.counts.trusts} providers (${meta.counts.type1} with a Type 1 A&E), `
    + `${meta.counts.rows} provider-months, ${meta.counts.functions} treatment-function rows.`);
  console.log(`A&E ${meta.ae.first} to ${meta.ae.last}; RTT ${meta.rtt.first} to ${meta.rtt.last}.`);
  console.log(`Built in ${meta.buildSeconds}s.`);
}

await main();
