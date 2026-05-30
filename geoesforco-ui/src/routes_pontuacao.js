const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { Pool } = require('pg');

const { geoesforcoPool, edgvPool, sapPool, getEdgvDb, swapEdgvPool } = require('./db');
const { calculateScore, calcMultEscala, detectLPKey } = require('./calculadora');

const router = express.Router();

const LP_DIR = path.join(__dirname, '../../calculadora_pontos');

// LP key → schema.tabela no banco geoesforco
const LP_TABLE = {
  mapeamento_topo: 'pontuacao.topo',
  mapeamento_orto: 'pontuacao.orto',
};

function loadRegistro() {
  return JSON.parse(fs.readFileSync(path.join(LP_DIR, 'registro_lps.json'), 'utf8'));
}

function allLpKeys() {
  const reg  = loadRegistro();
  const keys = new Set([reg.default || 'mapeamento_topo']);
  for (const lp of (reg.linhas || [])) keys.add(lp.mapeamento);
  return [...keys].filter(k => LP_TABLE[k]);
}

function buildTempPool(config) {
  const BASE = {
    host:                    process.env.PG_HOST     || 'localhost',
    port:                    parseInt(process.env.PG_PORT || '5432'),
    user:                    process.env.PG_USER     || 'postgres',
    password:                process.env.PG_PASSWORD || 'postgres',
    max:                     5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis:       30000,
    query_timeout:           60000,
  };
  return new Pool({ ...BASE, ...config });
}

// ── POST /api/pontuacao/calcular ─────────────────────────────────────────────
// Body: { mi?, lp_key?, escala, banco?, conn? }
// mi ausente/null → todos os MIs de aux_moldura_a
// lp_key ausente/null → todas as LPs com tabela definida
// Resposta: streaming NDJSON
router.post('/calcular', async (req, res) => {
  const { mi, lp_key, escala, banco, conn } = req.body || {};
  const denominadorEscala = parseInt(escala) || 50000;

  const lps = lp_key ? [lp_key] : allLpKeys();
  const lpsValidas = lps.filter(k => LP_TABLE[k]);
  if (!lpsValidas.length) {
    return res.status(400).json({ erro: 'lp_key inválida ou sem tabela correspondente' });
  }

  // Busca geometrias de aux_moldura_a
  const miWhere  = mi ? ' WHERE mi = $1' : '';
  const miParams = mi ? [mi] : [];
  let miRows;
  try {
    const { rows } = await edgvPool.query(
      `SELECT mi, ST_AsEWKT(geom) AS wkt FROM edgv.aux_moldura_a${miWhere}`,
      miParams
    );
    miRows = rows;
  } catch (e) {
    return res.status(500).json({ erro: `Erro ao buscar MIs: ${e.message.split('\n')[0]}` });
  }

  if (!miRows.length) {
    return res.status(404).json({ erro: mi ? `MI '${mi}' não encontrado` : 'Nenhum MI em aux_moldura_a' });
  }

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.flushHeaders();

  const send = obj => { try { res.write(JSON.stringify(obj) + '\n'); } catch (_) {} };

  send({ tipo: 'inicio', total_mis: miRows.length, lps: lpsValidas, escala: denominadorEscala });

  // Troca de pool EDGV opcional (banco customizado)
  let tempPool = null;
  let restore  = null;
  if (banco && banco !== getEdgvDb()) {
    if (conn && conn.host) {
      tempPool = buildTempPool({ ...conn, database: banco });
      restore  = swapEdgvPool(tempPool);
    } else {
      const { setEdgvDb } = require('./db');
      setEdgvDb(banco);
    }
  }

  let ok = 0;
  let erros = 0;

  try {
    for (const row of miRows) {
      for (const lpKey of lpsValidas) {
        const table = LP_TABLE[lpKey];
        try {
          const multEscala = calcMultEscala(denominadorEscala, lpKey);
          const resultado  = await calculateScore(row.wkt, null, multEscala, {}, lpKey);

          await geoesforcoPool.query(`
            INSERT INTO ${table}
              (mi, geom, escala, mult_escala, score_total, por_subfase, por_camada, versao_pesos, banco_edgv, atualizado_em)
            VALUES ($1, ST_SetSRID(ST_GeomFromEWKT($2), 4674), $3, $4, $5, $6, $7, $8, $9, now())
            ON CONFLICT (mi) DO UPDATE SET
              geom          = EXCLUDED.geom,
              escala        = EXCLUDED.escala,
              mult_escala   = EXCLUDED.mult_escala,
              score_total   = EXCLUDED.score_total,
              por_subfase   = EXCLUDED.por_subfase,
              por_camada    = EXCLUDED.por_camada,
              versao_pesos  = EXCLUDED.versao_pesos,
              banco_edgv    = EXCLUDED.banco_edgv,
              atualizado_em = now()
          `, [
            row.mi,
            row.wkt,
            denominadorEscala,
            resultado.mult_escala,
            resultado.score_total,
            JSON.stringify(resultado.por_subfase),
            JSON.stringify(resultado.por_camada),
            resultado.versao_pesos,
            getEdgvDb(),
          ]);

          send({ tipo: 'progresso', mi: row.mi, lp_key: lpKey, score_total: resultado.score_total, ok: true });
          ok++;
        } catch (e) {
          send({ tipo: 'progresso', mi: row.mi, lp_key: lpKey, ok: false, erro: e.message.split('\n')[0] });
          erros++;
        }
      }
    }
  } finally {
    if (restore)   { restore(); }
    if (tempPool)  { tempPool.end().catch(() => {}); }
  }

  send({ tipo: 'fim', total: ok + erros, ok, erros });
  res.end();
});

// ── POST /api/pontuacao/salvar-lote ─────────────────────────────────────────
// Body: { resultados: [...] }  — array de objetos do ranking
router.post('/salvar-lote', async (req, res) => {
  try {
    const { resultados } = req.body;
    if (!Array.isArray(resultados) || !resultados.length) {
      return res.status(400).json({ erro: 'resultados deve ser array não-vazio' });
    }

    // Buscar geometrias transformadas para 4674 direto do SAP (r.geom pode ser UTM)
    const utIds = [...new Set(
      resultados.map(r => r.ut_id).filter(id => id != null && Number.isFinite(Number(id)))
    )].map(Number);

    const utWktMap = {};
    if (utIds.length) {
      try {
        const { rows: sapRows } = await sapPool.query(
          `SELECT id, ST_AsEWKT(ST_Force2D(ST_Transform(geom, 4674))) AS wkt
           FROM macrocontrole.unidade_trabalho WHERE id = ANY($1::int[])`,
          [utIds]
        );
        for (const row of sapRows) utWktMap[row.id] = row.wkt;
      } catch (e) {
        console.warn('[pontuacao] salvar-lote SAP lookup:', e.message.split('\n')[0]);
      }
    }

    let salvos = 0, erros = 0, erroExemplo = null;

    for (const r of resultados) {
      if (r.erro) continue;

      // lp_key: campo explícito → detectar pelo nome da LP do SAP
      const lpKey = r.lp_mapeamento || r.lp_key || detectLPKey(r.lp_nome);
      if (!lpKey) { erros++; continue; }

      const geomWKT = utWktMap[r.ut_id] || null;

      try {
        // Localiza MI pelo centroide
        let miRow = null;
        if (geomWKT) {
          const { rows } = await edgvPool.query(
            `SELECT mi, ST_AsEWKT(geom) AS wkt
             FROM edgv.aux_moldura_a
             WHERE ST_Contains(geom, ST_Centroid($1::geometry))
             LIMIT 1`,
            [geomWKT]
          );
          miRow = rows[0] || null;
        } else if (r.geom) {
          const { rows } = await edgvPool.query(
            `SELECT mi, ST_AsEWKT(geom) AS wkt
             FROM edgv.aux_moldura_a
             WHERE ST_Contains(geom, ST_Centroid(ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4674)))
             LIMIT 1`,
            [JSON.stringify(r.geom)]
          );
          miRow = rows[0] || null;
        }

        const subfaseKey = r.subfase_key === '__all__' ? null : (r.subfase_key || null);
        const isTodas    = !subfaseKey;
        const porSubfase = isTodas ? (r.por_subfase || {}) : { [subfaseKey]: r.score_total };
        const utId       = r.ut_id != null ? Number(r.ut_id) : null;
        const nome       = r.nome || (utId != null ? String(utId) : 'sem nome');

        // ── resultado_ut: separar SAP (com UPSERT) de arquivo (INSERT simples) ──
        if (utId != null) {
          await geoesforcoPool.query(`
            INSERT INTO pontuacao.resultado_ut
              (ut_id, nome, mi, lp_key, subfase_key, escala, mult_escala, score_total,
               por_subfase, por_camada, banco_edgv, calculado_em)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
            ON CONFLICT (ut_id, lp_key) WHERE ut_id IS NOT NULL DO UPDATE SET
              nome        = EXCLUDED.nome,
              mi          = EXCLUDED.mi,
              subfase_key = EXCLUDED.subfase_key,
              escala      = EXCLUDED.escala,
              mult_escala = EXCLUDED.mult_escala,
              score_total = EXCLUDED.score_total,
              por_subfase = CASE
                WHEN EXCLUDED.subfase_key IS NULL THEN EXCLUDED.por_subfase
                ELSE COALESCE(pontuacao.resultado_ut.por_subfase, '{}'::jsonb) || EXCLUDED.por_subfase
              END,
              por_camada   = EXCLUDED.por_camada,
              banco_edgv   = EXCLUDED.banco_edgv,
              calculado_em = now()
          `, [utId, nome, miRow?.mi || null, lpKey, subfaseKey,
              r.denominador_escala || 50000, r.mult_escala || 1, r.score_total,
              JSON.stringify(porSubfase), JSON.stringify(r.por_camada || []), getEdgvDb()]);
        } else {
          // Modo arquivo: sempre insere nova linha (sem deduplicação)
          await geoesforcoPool.query(`
            INSERT INTO pontuacao.resultado_ut
              (ut_id, nome, mi, lp_key, subfase_key, escala, mult_escala, score_total,
               por_subfase, por_camada, banco_edgv, calculado_em)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
          `, [null, nome, miRow?.mi || null, lpKey, subfaseKey,
              r.denominador_escala || 50000, r.mult_escala || 1, r.score_total,
              JSON.stringify(porSubfase), JSON.stringify(r.por_camada || []), getEdgvDb()]);
        }

        // ── pontuacao.topo/orto: agrega por MI para mapa ─────────────────────
        const table = LP_TABLE[lpKey];
        if (table && miRow) {
          const conflictClause = isTodas
            ? `por_subfase  = EXCLUDED.por_subfase,
               score_total  = EXCLUDED.score_total,
               por_camada   = EXCLUDED.por_camada,
               versao_pesos = EXCLUDED.versao_pesos,
               banco_edgv   = EXCLUDED.banco_edgv,
               atualizado_em = now()`
            : `por_subfase  = COALESCE(${table}.por_subfase,'{}')::jsonb || EXCLUDED.por_subfase,
               score_total  = (SELECT COALESCE(SUM(value::numeric), 0)
                               FROM jsonb_each_text(COALESCE(${table}.por_subfase,'{}')::jsonb || EXCLUDED.por_subfase)),
               por_camada   = EXCLUDED.por_camada,
               banco_edgv   = EXCLUDED.banco_edgv,
               atualizado_em = now()`;

          await geoesforcoPool.query(`
            INSERT INTO ${table}
              (mi, geom, escala, mult_escala, score_total, por_subfase, por_camada, versao_pesos, banco_edgv, atualizado_em)
            VALUES ($1, ST_SetSRID(ST_GeomFromEWKT($2), 4674), $3, $4, $5, $6, $7, $8, $9, now())
            ON CONFLICT (mi) DO UPDATE SET ${conflictClause}
          `, [miRow.mi, miRow.wkt,
              r.denominador_escala || 50000, r.mult_escala || 1, r.score_total,
              JSON.stringify(porSubfase), JSON.stringify(r.por_camada || []),
              r.versao_pesos || null, getEdgvDb()]);
        }

        salvos++;
      } catch (e) {
        const msg = e.message.split('\n')[0];
        console.error('[pontuacao] salvar-lote item:', msg);
        if (!erroExemplo) erroExemplo = msg;
        erros++;
      }
    }

    res.json({ salvos, erros, total: resultados.filter(r => !r.erro).length, erroExemplo });

  } catch (e) {
    console.error('[pontuacao] salvar-lote FATAL:', e.stack || e.message);
    res.status(500).json({ erro: e.message });
  }
});

// ── GET /api/pontuacao/resultados ────────────────────────────────────────────
// Query params: lp_key, subfase_key, limit (default 200)
// Retorna resultados_ut ordenados por score DESC para montar ranking
router.get('/resultados', async (req, res) => {
  const { lp_key, subfase_key, limit: limitParam } = req.query;
  const limit = Math.min(parseInt(limitParam) || 200, 2000);

  const conditions = [];
  const params     = [];
  if (lp_key)      { params.push(lp_key);      conditions.push(`lp_key = $${params.length}`); }
  if (subfase_key) { params.push(subfase_key);  conditions.push(`subfase_key = $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const { rows } = await geoesforcoPool.query(
      `SELECT id, ut_id, nome, mi, lp_key, subfase_key, escala, mult_escala,
              score_total, por_subfase, banco_edgv, calculado_em
       FROM pontuacao.resultado_ut
       ${where}
       ORDER BY score_total DESC NULLS LAST
       LIMIT $${params.length + 1}`,
      [...params, limit]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── GET /api/pontuacao/status ────────────────────────────────────────────────
router.get('/status', async (_req, res) => {
  try {
    const resultado = {};
    for (const [lpKey, table] of Object.entries(LP_TABLE)) {
      try {
        const { rows } = await geoesforcoPool.query(
          `SELECT COUNT(*)::int AS n, MAX(atualizado_em) AS ultima FROM ${table}`
        );
        resultado[lpKey] = { n: rows[0].n, ultima: rows[0].ultima };
      } catch {
        resultado[lpKey] = { n: 0, ultima: null, erro: 'tabela não encontrada' };
      }
    }
    res.json(resultado);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── GET /api/pontuacao?lp_key=&mi= ──────────────────────────────────────────
router.get('/', async (req, res) => {
  const { lp_key, mi } = req.query;
  const table = LP_TABLE[lp_key];
  if (!table) return res.status(400).json({ erro: 'lp_key inválida ou ausente' });

  try {
    const where  = mi ? ' WHERE mi = $1' : '';
    const params = mi ? [mi] : [];
    // Inclui por_camada quando consulta MI específico (painel de detalhe)
    const cols = mi
      ? 'id, mi, escala, mult_escala, score_total, por_subfase, por_camada, versao_pesos, banco_edgv, atualizado_em'
      : 'id, mi, escala, mult_escala, score_total, por_subfase, versao_pesos, banco_edgv, atualizado_em';
    const { rows } = await geoesforcoPool.query(
      `SELECT ${cols} FROM ${table}${where} ORDER BY score_total DESC NULLS LAST`,
      params
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── GET /api/pontuacao/mapa?lp_key= ─────────────────────────────────────────
router.get('/mapa', async (req, res) => {
  const { lp_key } = req.query;
  const table = LP_TABLE[lp_key];
  if (!table) return res.status(400).json({ erro: 'lp_key inválida ou ausente' });

  try {
    const { rows } = await geoesforcoPool.query(`
      SELECT json_build_object(
        'type', 'FeatureCollection',
        'features', COALESCE(json_agg(
          json_build_object(
            'type',       'Feature',
            'geometry',   ST_AsGeoJSON(geom)::json,
            'properties', json_build_object(
              'mi',           mi,
              'escala',       escala,
              'score_total',  score_total,
              'por_subfase',  por_subfase,
              'atualizado_em', atualizado_em
            )
          )
        ), '[]'::json)
      ) AS fc
      FROM ${table}
      WHERE geom IS NOT NULL
    `);
    res.json(rows[0]?.fc || { type: 'FeatureCollection', features: [] });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── salvarPontuacao ──────────────────────────────────────────────────────────
// Fire-and-forget: chamada pelos endpoints de cálculo para persistir scores.
// geomWKT    — geometria da UT calculada (para localizar o MI via centroide)
// resultado  — objeto retornado por calculateScore / calculateAllSubfases
// lpKey      — chave LP (mapeamento_topo | mapeamento_orto)
// denominadorEscala — ex: 50000
// subfaseKey — null = todas as subfases (REPLACE); string = subfase única (MERGE)
async function salvarPontuacao(geomWKT, resultado, lpKey, denominadorEscala, subfaseKey) {
  const table = LP_TABLE[lpKey];
  if (!table) return;

  let miRow;
  try {
    const { rows } = await edgvPool.query(
      `SELECT mi, ST_AsEWKT(geom) AS wkt
       FROM edgv.aux_moldura_a
       WHERE ST_Contains(geom, ST_Centroid(ST_SetSRID($1::geometry, 4674)))
       LIMIT 1`,
      [geomWKT]
    );
    miRow = rows[0];
  } catch (e) {
    console.warn('[pontuacao] lookup MI:', e.message.split('\n')[0]);
    return;
  }
  if (!miRow) { console.warn('[pontuacao] MI não encontrado para a geometria fornecida'); return; }

  const isTodas    = !subfaseKey;
  const porSubfase = isTodas
    ? resultado.por_subfase
    : { [subfaseKey]: resultado.score_total };
  const scoreTotal = resultado.score_total;

  const conflictClause = isTodas
    ? `por_subfase  = EXCLUDED.por_subfase,
       score_total  = EXCLUDED.score_total,
       por_camada   = EXCLUDED.por_camada,
       versao_pesos = EXCLUDED.versao_pesos,
       banco_edgv   = EXCLUDED.banco_edgv,
       atualizado_em = now()`
    : `por_subfase  = ${table}.por_subfase || EXCLUDED.por_subfase,
       score_total  = (SELECT COALESCE(SUM(value::numeric), 0)
                       FROM jsonb_each_text(${table}.por_subfase || EXCLUDED.por_subfase)),
       por_camada   = EXCLUDED.por_camada,
       banco_edgv   = EXCLUDED.banco_edgv,
       atualizado_em = now()`;

  await geoesforcoPool.query(`
    INSERT INTO ${table}
      (mi, geom, escala, mult_escala, score_total, por_subfase, por_camada, versao_pesos, banco_edgv, atualizado_em)
    VALUES ($1, ST_SetSRID(ST_GeomFromEWKT($2), 4674), $3, $4, $5, $6, $7, $8, $9, now())
    ON CONFLICT (mi) DO UPDATE SET ${conflictClause}
  `, [
    miRow.mi,
    miRow.wkt,
    denominadorEscala,
    resultado.mult_escala ?? 1,
    scoreTotal,
    JSON.stringify(porSubfase),
    JSON.stringify(resultado.por_camada || []),
    resultado.versao_pesos ?? null,
    getEdgvDb(),
  ]);
}

module.exports = { router, salvarPontuacao };
