#!/usr/bin/env node
//
// Regenerates data/mrt.json — the static rail network the map, station search
// and disruption alerts are built on.
//
//   node scripts/build-mrt-data.js
//
// Why a committed file rather than a runtime fetch: LTA's own station dataset
// ships as an ESRI shapefile inside a zip, which is impractical to parse in a
// serverless function on every request, and the rail network changes a handful
// of times a year. Static is the right shape for data that stable — run this
// when a line or station opens.
//
// Two sources, because neither is complete on its own:
//
//   HEAVY_RAIL_URL  MRT lines (NS/EW/NE/CC/DT/TE), derived from LTA and URA
//                   open data and kept current — it has the full Thomson–East
//                   Coast Line and the closed Circle Line loop.
//   LRT_URL         The LRT lines (Bukit Panjang, Sengkang, Punggol), which
//                   the heavy-rail source omits. This is LTA's Master Plan
//                   rail station layer; it's older, but the LRT network hasn't
//                   changed since Teck Lee opened.
//
// Pass local paths to build offline:
//   node scripts/build-mrt-data.js ./mrt_network.json ./mrtsg.csv

const fs = require("fs");
const path = require("path");

const HEAVY_RAIL_URL =
  "https://raw.githubusercontent.com/ayaka14732/singapore-hdb-map/main/data/mrt_network.json";
const LRT_URL =
  "https://raw.githubusercontent.com/hxchua/datadoubleconfirm/master/datasets/mrtsg.csv";

const OUT = path.join(__dirname, "..", "data", "mrt.json");

// Official line liveries, so the map reads the way the network map does.
const LINE_META = {
  NS: { id: "NSL", name: "North South Line", colour: "#d42e12" },
  EW: { id: "EWL", name: "East West Line", colour: "#009645" },
  NE: { id: "NEL", name: "North East Line", colour: "#9900aa" },
  CC: { id: "CCL", name: "Circle Line", colour: "#fa9e0d" },
  DT: { id: "DTL", name: "Downtown Line", colour: "#005ec4" },
  TE: { id: "TEL", name: "Thomson–East Coast Line", colour: "#9d5b25" },
};

const LRT_GREY = "#748477";

// Each LRT line is a loop or a spur off a town-centre hub, not a straight
// sequence, so the segments are spelled out rather than derived from code
// order. Bukit Panjang runs a trunk from Choa Chu Kang to Bukit Panjang and
// then a one-way loop that returns to it.
const LRT_LINES = [
  {
    id: "BPLRT",
    name: "Bukit Panjang LRT",
    prefixes: ["BP"],
    segments: [
      ["BP1", "BP2", "BP3", "BP4", "BP5", "BP6"],
      ["BP6", "BP7", "BP8", "BP9", "BP10", "BP11", "BP12", "BP13", "BP6"],
    ],
  },
  {
    id: "SKLRT",
    name: "Sengkang LRT",
    prefixes: ["STC", "SW", "SE"],
    segments: [
      ["STC", "SW1", "SW2", "SW3", "SW4", "SW5", "SW6", "SW7", "SW8", "STC"],
      ["STC", "SE1", "SE2", "SE3", "SE4", "SE5", "STC"],
    ],
  },
  {
    id: "PGLRT",
    name: "Punggol LRT",
    prefixes: ["PTC", "PW", "PE"],
    segments: [
      ["PTC", "PW1", "PW2", "PW3", "PW4", "PW5", "PW6", "PW7", "PTC"],
      ["PTC", "PE1", "PE2", "PE3", "PE4", "PE5", "PE6", "PE7", "PTC"],
    ],
  },
];

// Ten Mile Junction closed in 2019 but is still in the Master Plan layer.
const CLOSED_STATIONS = new Set(["BP14"]);

const NAME_FIXES = {
  "CHOA CHU KANG": "Choa Chu Kang",
  "BUKIT PANJANG": "Bukit Panjang",
  "SENGKANG": "Sengkang",
  "PUNGGOL": "Punggol",
  "CORAL EDGE": "Coral Edge",
  "SAM KEE": "Sam Kee",
  "TECK LEE": "Teck Lee",
  "SOO TECK": "Soo Teck",
  "SOUTH VIEW": "South View",
  "KEAT HONG": "Keat Hong",
  "TECK WHYE": "Teck Whye",
  "PUNGGOL POINT": "Punggol Point",
};

function titleCase(raw) {
  const upper = raw.toUpperCase().trim();
  if (NAME_FIXES[upper]) return NAME_FIXES[upper];
  return upper.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function parseCsv(text) {
  const [header, ...rows] = text.trim().split(/\r?\n/);
  const cols = header.split(",");
  return rows
    .filter(Boolean)
    .map((line) => Object.fromEntries(line.split(",").map((v, i) => [cols[i], v])));
}

async function load(arg, url) {
  if (arg) return fs.readFileSync(arg, "utf8");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.text();
}

function codePrefix(code) {
  const m = code.match(/^[A-Z]+/);
  return m ? m[0] : null;
}

async function main() {
  const [heavyRaw, lrtRaw] = await Promise.all([
    load(process.argv[2], HEAVY_RAIL_URL),
    load(process.argv[3], LRT_URL),
  ]);
  const heavy = JSON.parse(heavyRaw);

  const stations = {};
  const codesByName = new Map();

  function addStation(code, name, lat, lng, lineId) {
    stations[code] = {
      code,
      name,
      line: lineId,
      lat: Number(lat.toFixed(6)),
      lng: Number(lng.toFixed(6)),
      interchange: [],
    };
    if (!codesByName.has(name)) codesByName.set(name, []);
    codesByName.get(name).push(code);
  }

  // ── Heavy rail ──
  for (const s of heavy.stations || []) {
    for (const code of s.codes || []) {
      const prefix = codePrefix(code);
      // CG (Changi branch) belongs to the EW line, CE to the Circle Line.
      const owner = prefix === "CG" ? "EW" : prefix === "CE" ? "CC" : prefix;
      if (!LINE_META[owner]) continue;
      addStation(code, s.name, s.lat, s.lng, LINE_META[owner].id);
    }
  }

  const lines = (heavy.lines || [])
    .filter((l) => LINE_META[l.id])
    .map((l) => ({
      id: LINE_META[l.id].id,
      name: LINE_META[l.id].name,
      colour: LINE_META[l.id].colour,
      lrt: false,
      // Segments, not one flat list: branches (Changi Airport, Bayfront) and
      // the Circle Line's closed loop can't be drawn as a single polyline.
      segments: (l.segments || []).map((seg) => seg.filter((c) => stations[c])),
    }));

  // ── LRT ──
  const lrtPrefixes = new Set(LRT_LINES.flatMap((l) => l.prefixes));
  for (const r of parseCsv(lrtRaw)) {
    const code = (r.STN_NO || "").trim().toUpperCase();
    const prefix = code.match(/^[A-Z]+/)?.[0];
    if (!code || !lrtPrefixes.has(prefix) || CLOSED_STATIONS.has(code)) continue;
    if (stations[code]) continue;
    const lat = parseFloat(r.Latitude);
    const lng = parseFloat(r.Longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const line = LRT_LINES.find((l) => l.prefixes.includes(prefix));
    const name = titleCase((r.STN_NAME || "").replace(/\s+(MRT|LRT)\s+STATION$/i, ""));
    addStation(code, name, lat, lng, line.id);
  }

  for (const l of LRT_LINES) {
    const segments = l.segments
      .map((seg) => seg.filter((c) => stations[c]))
      .filter((seg) => seg.length > 1);
    if (segments.length === 0) continue;
    lines.push({ id: l.id, name: l.name, colour: LRT_GREY, lrt: true, segments });
  }

  // A station name serving more than one code is an interchange. Each code
  // lists the others, so the map can label "also NS1 / EW24" without a lookup.
  for (const codes of codesByName.values()) {
    if (codes.length < 2) continue;
    for (const code of codes) {
      stations[code].interchange = codes.filter((c) => c !== code);
    }
  }

  // Anything named in a segment but missing from the station table would draw
  // a polyline with a hole in it — better to fail loudly than ship that.
  const missing = [];
  for (const l of lines) {
    for (const seg of l.segments) {
      for (const c of seg) if (!stations[c]) missing.push(`${l.id}:${c}`);
    }
  }
  if (missing.length) throw new Error(`Segments reference unknown stations: ${missing.join(", ")}`);

  const out = {
    generatedAt: new Date().toISOString().slice(0, 10),
    sources: [HEAVY_RAIL_URL, LRT_URL],
    note: "Regenerate with `node scripts/build-mrt-data.js` when a line or station opens.",
    lines,
    stations,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out) + "\n");

  const interchanges = [...codesByName.values()].filter((c) => c.length > 1).length;
  console.log(
    `Wrote ${OUT}\n  ${Object.keys(stations).length} station codes, ` +
      `${codesByName.size} distinct stations (${interchanges} interchanges), ${lines.length} lines`
  );
  for (const l of lines) {
    console.log(`    ${l.id.padEnd(6)} ${l.segments.map((s) => `${s[0]}..${s[s.length - 1]}(${s.length})`).join(" ")}`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
