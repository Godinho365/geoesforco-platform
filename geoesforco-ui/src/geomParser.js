/**
 * Parseia SHP (como ZIP) ou GeoPackage (.gpkg) e devolve a geometria
 * de limite da UT como GeoJSON Polygon / MultiPolygon.
 *
 * Dependências: adm-zip, shapefile, sql.js
 */
'use strict';

const AdmZip    = require('adm-zip');
const shapefile = require('shapefile');

// ── GPKG binary geometry parsing ─────────────────────────────────────────────
// Formato do blob GPKG: 2 bytes magic ('GP') + 1 byte versão + 1 byte flags
// + 4 bytes SRS id + envelope opcional + WKB.

function gpkgWkbOffset(buf) {
  if (buf.length < 8 || buf[0] !== 0x47 || buf[1] !== 0x50) return 0;
  const envType  = (buf[3] >> 1) & 0x07;
  const envSizes = [0, 32, 48, 48, 64];
  return 8 + (envSizes[envType] ?? 0);
}

/**
 * Parseia WKB Polygon / MultiPolygon (2D e 3D) a partir de um offset.
 * Devolve um objeto GeoJSON com campo extra `_nextOff` para avanço no buffer.
 */
function wkbToPolygonGeom(buf, off) {
  if (!buf || buf.length - off < 9) return null;

  const le     = buf[off] === 1;
  const type   = le ? buf.readUInt32LE(off + 1) : buf.readUInt32BE(off + 1);
  const base   = type & 0xFFFF;          // mascara dimensão (Z=+1000, M=+2000)
  const stride = base >= 1000 ? 24 : 16; // 2D=16 bytes / 3D=24 bytes por ponto

  // Lê um anel (ring) a partir do offset `o`; devolve { coords, nextOff }
  const readRingAt = (o) => {
    const n    = le ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
    const ring = [];
    for (let i = 0; i < n; i++) {
      const p = o + 4 + i * stride;
      ring.push([
        le ? buf.readDoubleLE(p)     : buf.readDoubleBE(p),
        le ? buf.readDoubleLE(p + 8) : buf.readDoubleBE(p + 8),
      ]);
    }
    return { coords: ring, nextOff: o + 4 + n * stride };
  };

  // ── Polygon (3 / 1003) ────────────────────────────────────────────────────
  if (base === 3 || base === 1003) {
    const numRings = le ? buf.readUInt32LE(off + 5) : buf.readUInt32BE(off + 5);
    const rings    = [];
    let o          = off + 9;
    for (let r = 0; r < numRings; r++) {
      const { coords, nextOff } = readRingAt(o);
      rings.push(coords);
      o = nextOff;
    }
    return { type: 'Polygon', coordinates: rings, _nextOff: o };
  }

  // ── MultiPolygon (6 / 1006) ───────────────────────────────────────────────
  if (base === 6 || base === 1006) {
    const numGeoms = le ? buf.readUInt32LE(off + 5) : buf.readUInt32BE(off + 5);
    const polys    = [];
    let o          = off + 9;
    for (let g = 0; g < numGeoms; g++) {
      const sub = wkbToPolygonGeom(buf, o);
      if (!sub) break;
      if (sub.type === 'Polygon') polys.push(sub.coordinates);
      o = sub._nextOff;
    }
    const geom = polys.length === 1
      ? { type: 'Polygon',      coordinates: polys[0] }
      : { type: 'MultiPolygon', coordinates: polys    };
    return { ...geom, _nextOff: o };
  }

  return null;
}

// ── SRID a partir do .prj do Shapefile ───────────────────────────────────────

function sridFromPrj(prjText) {
  // Tenta ler AUTHORITY["EPSG","NNNN"] primeiro
  const m = prjText.match(/AUTHORITY\["EPSG"\s*,\s*"(\d+)"\]/i);
  if (m) return parseInt(m[1]);
  // Fallbacks por texto
  if (/SIRGAS_2000|GCS_SIRGAS_2000/i.test(prjText)) return 4674;
  if (/WGS_1984|WGS84|D_WGS_1984/i.test(prjText))  return 4326;
  return 4674; // padrão: SIRGAS 2000
}

// ── SHP a partir de ZIP ───────────────────────────────────────────────────────

async function parseShpZip(buffer) {
  const zip     = new AdmZip(buffer);
  const entries = zip.getEntries();

  const shpEntry = entries.find(e => /\.shp$/i.test(e.entryName));
  if (!shpEntry) throw new Error('ZIP deve conter um arquivo .shp');

  const dbfEntry = entries.find(e => /\.dbf$/i.test(e.entryName));
  const prjEntry = entries.find(e => /\.prj$/i.test(e.entryName));

  const toAB = buf => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const shpAB = toAB(shpEntry.getData());
  const dbfAB = dbfEntry ? toAB(dbfEntry.getData()) : null;

  const source   = await shapefile.open(shpAB, dbfAB);
  const features = []; // { geojson: Polygon|MultiPolygon, properties: {} }

  let rec;
  while (!(rec = await source.read()).done) {
    const geom  = rec.value?.geometry;
    const props = rec.value?.properties || {};
    if (!geom) continue;
    if (['Polygon', 'MultiPolygon'].includes(geom.type)) {
      features.push({ geojson: geom, properties: props });
    }
  }

  if (!features.length)
    throw new Error('Nenhum polígono encontrado no SHP. Verifique o tipo de geometria.');

  const srid = prjEntry
    ? sridFromPrj(prjEntry.getData().toString('utf8'))
    : 4674;

  return { features, srid };
}

// ── GeoPackage ────────────────────────────────────────────────────────────────

// Cache do módulo sql.js (WASM — inicialização pesada)
let _SQL = null;
async function getSql() {
  if (!_SQL) _SQL = await require('sql.js')();
  return _SQL;
}

async function parseGpkg(buffer) {
  const SQL = await getSql();
  const db  = new SQL.Database(new Uint8Array(buffer));

  try {
    const gc = db.exec(
      `SELECT table_name, column_name, srs_id FROM gpkg_geometry_columns`
    );
    if (!gc.length || !gc[0].values.length)
      throw new Error('GPKG sem gpkg_geometry_columns — verifique se é um GeoPackage válido');

    const features = [];
    let srid        = 4674;

    for (const [table, col, srsId] of gc[0].values) {
      if (srsId) srid = srsId;

      // Busca todas as colunas para incluir propriedades junto com a geometria
      const rows = db.exec(`SELECT * FROM "${table}"`);
      if (!rows.length) continue;

      const colNames = rows[0].columns;
      const geomIdx  = colNames.indexOf(col);

      for (const row of rows[0].values) {
        const raw = row[geomIdx];
        if (!raw) continue;
        const buf    = Buffer.from(raw);
        const wkbOff = gpkgWkbOffset(buf);
        const geom   = wkbToPolygonGeom(buf, wkbOff);
        if (!geom) continue;
        // Propriedades: todas as colunas exceto a de geometria
        const props = {};
        colNames.forEach((name, i) => {
          if (i !== geomIdx && row[i] !== null && row[i] !== undefined)
            props[name] = row[i];
        });
        features.push({ geojson: geom, properties: props });
      }
    }

    if (!features.length)
      throw new Error('Nenhum polígono encontrado no GPKG. Verifique o tipo de geometria.');

    return { features, srid };
  } finally {
    db.close();
  }
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Parseia SHP (como ZIP) ou GPKG e devolve features individuais:
 *   { features: [{ geojson: Polygon|MultiPolygon, properties: {} }], srid: number }
 *
 * @param {Buffer} buffer       conteúdo do arquivo
 * @param {string} originalName nome original (usado para detectar extensão)
 */
async function parseGeomFile(buffer, originalName) {
  const ext = (originalName.match(/\.(\w+)$/) || ['', ''])[1].toLowerCase();

  if (ext === 'zip')  return parseShpZip(buffer);
  if (ext === 'gpkg') return parseGpkg(buffer);

  throw new Error(`Formato não suportado: .${ext}. Use .zip (SHP zipado) ou .gpkg`);
}

module.exports = { parseGeomFile };
