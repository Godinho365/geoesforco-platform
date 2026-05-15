/**
 * Parseia SHP (como ZIP) ou GeoPackage (.gpkg) e devolve as geometrias
 * de curva de nível como array de arrays de coordenadas [[lon, lat], …].
 *
 * Dependências: adm-zip, shapefile, sql.js
 */
'use strict';

const AdmZip    = require('adm-zip');
const shapefile = require('shapefile');

// ── GPKG binary geometry parsing ─────────────────────────────────────────────
// O formato de blob GPKG é: 2 bytes magic ('GP') + 1 byte versão + 1 byte flags
// + 4 bytes SRS id + envelope opcional + WKB.

function gpkgWkbOffset(buf) {
  if (buf.length < 8 || buf[0] !== 0x47 || buf[1] !== 0x50) return 0;
  const envType  = (buf[3] >> 1) & 0x07;
  const envSizes = [0, 32, 48, 48, 64];
  return 8 + (envSizes[envType] ?? 0);
}

/** Extrai arrays de coordenadas [lon,lat] de um buffer WKB (LineString/MultiLineString 2D e 3D) */
function wkbToLineCoords(buf) {
  if (!buf || buf.length < 5) return [];
  const le   = buf[0] === 1;
  const type = le ? buf.readUInt32LE(1) : buf.readUInt32BE(1);
  const base = type & 0xFFFF; // mascara dimensão (Z/M)

  const readPts = (offset, stride) => {
    const n   = le ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const o = offset + 4 + i * stride;
      pts.push([
        le ? buf.readDoubleLE(o)     : buf.readDoubleBE(o),
        le ? buf.readDoubleLE(o + 8) : buf.readDoubleBE(o + 8),
      ]);
    }
    return pts;
  };

  if (base === 2)    return [readPts(5, 16)]; // LineString 2D
  if (base === 1002) return [readPts(5, 24)]; // LineStringZ

  if (base === 5 || base === 1005) { // MultiLineString 2D / Z
    const nGeoms = le ? buf.readUInt32LE(5) : buf.readUInt32BE(5);
    const result = [];
    let off = 9;
    for (let g = 0; g < nGeoms; g++) {
      const sLe    = buf[off] === 1;
      const sType  = sLe ? buf.readUInt32LE(off + 1) : buf.readUInt32BE(off + 1);
      const sBase  = sType & 0xFFFF;
      const stride = (sBase === 1002 || sBase === 1005) ? 24 : 16;
      const cn     = sLe ? buf.readUInt32LE(off + 5) : buf.readUInt32BE(off + 5);
      const pts    = [];
      for (let i = 0; i < cn; i++) {
        const o = off + 9 + i * stride;
        pts.push([
          sLe ? buf.readDoubleLE(o)     : buf.readDoubleBE(o),
          sLe ? buf.readDoubleLE(o + 8) : buf.readDoubleBE(o + 8),
        ]);
      }
      result.push(pts);
      off += 9 + cn * stride;
    }
    return result;
  }
  return [];
}

// ── SHP a partir de ZIP ───────────────────────────────────────────────────────

async function parseShpZip(buffer) {
  const zip     = new AdmZip(buffer);
  const entries = zip.getEntries();

  const shpEntry = entries.find(e => /\.shp$/i.test(e.entryName));
  if (!shpEntry) throw new Error('ZIP deve conter um arquivo .shp');

  const dbfEntry = entries.find(e => /\.dbf$/i.test(e.entryName));

  // shapefile.open() aceita ArrayBuffer; garante cópia própria do buffer
  const toAB = buf => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  const shpAB = toAB(shpEntry.getData());
  const dbfAB = dbfEntry ? toAB(dbfEntry.getData()) : null;

  const source = await shapefile.open(shpAB, dbfAB);
  const lines  = [];

  let rec;
  while (!(rec = await source.read()).done) {
    const geom = rec.value?.geometry;
    if (!geom) continue;
    if      (geom.type === 'LineString')      lines.push(geom.coordinates);
    else if (geom.type === 'MultiLineString') lines.push(...geom.coordinates);
  }

  // SHP não tem SRS embutido de forma confiável — assume SIRGAS 2000 / WGS84
  return { lines, srid: 4674 };
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

    const lines = [];
    let srid    = 4674;

    for (const [table, col, srsId] of gc[0].values) {
      if (srsId) srid = srsId;

      const rows = db.exec(`SELECT "${col}" FROM "${table}"`);
      if (!rows.length) continue;

      for (const [raw] of rows[0].values) {
        if (!raw) continue;
        const buf    = Buffer.from(raw);
        const wkbOff = gpkgWkbOffset(buf);
        lines.push(...wkbToLineCoords(buf.slice(wkbOff)));
      }
    }

    return { lines, srid };
  } finally {
    db.close();
  }
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Parseia SHP (como ZIP) ou GPKG e devolve:
 *   { lines: number[][][], srid: number }
 *
 * @param {Buffer} buffer       conteúdo do arquivo em bytes
 * @param {string} originalName nome original do arquivo (para detectar extensão)
 */
async function parseFile(buffer, originalName) {
  const ext = (originalName.match(/\.(\w+)$/) || ['', ''])[1].toLowerCase();

  if (ext === 'zip')  return parseShpZip(buffer);
  if (ext === 'gpkg') return parseGpkg(buffer);

  throw new Error(`Formato não suportado: .${ext}. Use .zip (SHP zipado) ou .gpkg`);
}

module.exports = { parseFile };
