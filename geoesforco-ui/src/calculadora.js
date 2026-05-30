/**
 * Engine de cálculo de score por UT.
 *
 * MAPEAMENTO e PESOS são lidos do disco a cada chamada para refletir
 * edições no JSON sem precisar reiniciar o servidor.
 */

const fs   = require('fs');
const path = require('path');
const { edgvPool, refPool, osmPool } = require('./db');

// Mapeia o valor do campo "banco" no mapeamento JSON → pool de conexão.
// Compara contra o nome real configurado em OSM_DB (default 'insumo_osm').
const _osmDbName = process.env.OSM_DB || 'insumo_osm';
function resolvePool(banco) {
  if (banco && banco === _osmDbName) return osmPool;
  return edgvPool; // padrão
}

const LP_DIR     = path.join(__dirname, '../../calculadora_pontos');
const PESOS_DIR  = path.join(LP_DIR, 'pesos');
const REG_PATH   = path.join(LP_DIR, 'registro_lps.json');

// ── Cache em memória por chave LP ─────────────────────────────────────────────
const _cacheMap   = new Map(); // mapeamento key  → objeto
const _cacheWeights = new Map(); // pesos key       → objeto
let   _cacheReg   = null;

function _watchOnce(filePath, invalidate) {
  try { fs.watch(filePath, invalidate); } catch (_) { /* arquivo pode não existir ainda */ }
}
_watchOnce(REG_PATH, () => { _cacheReg = null; console.log('[cache] registro_lps.json invalidado'); });

function loadRegistro() {
  if (!_cacheReg) {
    _cacheReg = JSON.parse(fs.readFileSync(REG_PATH, 'utf8'));
  }
  return _cacheReg;
}

/**
 * Detecta qual arquivo de mapeamento usar com base no nome da LP do SAP.
 * Retorna a chave do arquivo (sem extensão .json).
 */
function detectLPKey(lpNome) {
  try {
    const reg   = loadRegistro();
    const lower = (lpNome || '').toLowerCase();
    for (const lp of (reg.linhas || [])) {
      if ((lp.nome_contains || []).some(s => lower.includes(s.toLowerCase())))
        return lp.mapeamento;
    }
    return reg.default || 'mapeamento_topo';
  } catch (_) {
    return 'mapeamento_topo'; // fallback seguro se registro_lps.json não existir
  }
}

function loadMapeamento(key = 'mapeamento_topo') {
  if (!_cacheMap.has(key)) {
    const filePath = path.join(LP_DIR, `${key}.json`);
    const data     = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    _cacheMap.set(key, data);
    _watchOnce(filePath, () => { _cacheMap.delete(key); console.log(`[cache] ${key}.json invalidado`); });
  }
  return _cacheMap.get(key);
}

function loadPesos(lpKey = 'mapeamento_topo') {
  // Deriva o nome do arquivo de pesos a partir da chave do mapeamento:
  //   mapeamento_topo → pesos_topo_v1.json
  //   mapeamento_orto → pesos_orto_v1.json
  const pesosKey = `pesos_${lpKey.replace('mapeamento_', '')}_v1`;
  const cacheKey = pesosKey;
  if (!_cacheWeights.has(cacheKey)) {
    const candidatos = [
      path.join(PESOS_DIR, `${pesosKey}.json`),
      path.join(PESOS_DIR, 'pesos_topo_v1.json'),  // fallback
    ];
    let data = null;
    for (const filePath of candidatos) {
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        _watchOnce(filePath, () => { _cacheWeights.delete(cacheKey); console.log(`[cache] ${pesosKey}.json invalidado`); });
        break;
      } catch (_) { /* tenta próximo */ }
    }
    if (!data) throw new Error(`Arquivo de pesos não encontrado para LP: ${lpKey}`);
    _cacheWeights.set(cacheKey, data);
  }
  return _cacheWeights.get(cacheKey);
}

// ------------------------------------------------------------------ //
// Chave única por entrada de camada                                   //
// (tabela simples  ou  tabelaA__x__tabelaB  para joins)              //
// ------------------------------------------------------------------ //

function camadaKey(c) {
  return c.join ? `${c.tabela}__x__${c.join}` : c.tabela;
}

// ------------------------------------------------------------------ //
// Construção de queries                                               //
// ------------------------------------------------------------------ //

// ── Query especial: curva de nível EXTERNA × drenagem do banco ───────────────
// Usada quando o usuário sobe um SHP/GPKG de curva de nível em vez de usar
// edgv.elemnat_curva_nivel_l.  Parâmetros: $1=geomUT, $2=key, $3=multilineJSON, $4=srid
function buildQueryCurvaNivelExt(c) {
  const joinTab      = c.join; // 'elemnat_trecho_drenagem_l'
  const andWhereJoin = c.where_join ? ` AND (${c.where_join})` : '';
  return `
    WITH curva_ext AS (
      -- Decompõe o MultiLineString enviado pelo cliente em LineStrings individuais
      SELECT (ST_Dump(
        ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($3::text), $4::int), 4674)
      )).geom AS geom
    ),
    curva_clip AS (
      -- Filtra apenas as curvas que intersectam a UT
      SELECT geom FROM curva_ext
      WHERE ST_GeometryType(geom) = 'ST_LineString'
        AND ST_Length(geom) > 0
        AND ST_Intersects(geom, $1::geometry)
    )
    SELECT $2::text AS camada, 'qtd' AS metrica, COUNT(*)::numeric AS valor
    FROM curva_clip a
    JOIN edgv.${joinTab} b
      ON ST_Intersects(a.geom, b.geom)
      AND ST_Dimension(ST_Intersection(a.geom, b.geom)) = 0
    WHERE ST_Intersects(b.geom, $1::geometry)${andWhereJoin}
    HAVING COUNT(*) > 0`;
}

function buildQuery(c) {
  const { tabela, metrica, join: joinTabela } = c;

  // Campo opcional "schema" por camada — default "edgv".
  // Permite tabelas em outros schemas (ex: "insumos_osm").
  const schema = c.schema || 'edgv';
  // Resolve "schema.tabela" — se a tabela já vier qualificada (contém "."), usa como está.
  const tbl = (t, s) => {
    if (!t) return '';
    return t.includes('.') ? t : `${s || schema}.${t}`;
  };

  // ── km_named_body: delimitadores que formam polígonos com centroide nomeado ──
  // Estratégia:
  //  1. Recorta delimitador_massa_dagua_l à UT
  //  2. ST_Polygonize → polígonos fechados
  //  3. Filtra polígonos que contêm um centroide (join) com nome IS NOT NULL
  //  4. Soma o perímetro (km) como proxy do km mapeado de corpo d'água nomeado
  if (metrica === 'km_named_body' && joinTabela) {
    return `
      WITH delim_clip AS (
        SELECT (ST_Dump(ST_Intersection(f.geom, $1::geometry))).geom AS geom
        FROM ${tbl(tabela)} f
        WHERE ST_Intersects(f.geom, $1::geometry)
      ),
      lines AS (
        SELECT geom FROM delim_clip
        WHERE ST_GeometryType(geom) = 'ST_LineString' AND ST_Length(geom) > 0
      ),
      polys AS (
        SELECT (ST_Dump(ST_Polygonize(geom))).geom AS geom
        FROM lines
      ),
      polys_nomeados AS (
        SELECT p.geom
        FROM polys p
        WHERE EXISTS (
          SELECT 1 FROM ${tbl(joinTabela)} c
          WHERE c.nome IS NOT NULL
            AND ST_Within(c.geom, p.geom)
        )
      )
      SELECT $2::text AS camada, 'km' AS metrica,
        ROUND((SUM(ST_Perimeter(geom::geography)) / 1000)::numeric, 3) AS valor
      FROM polys_nomeados
      HAVING COUNT(*) > 0`;
  }

  // Interseção entre DUAS tabelas diferentes (ex: curva_nivel × drenagem)
  if (joinTabela && joinTabela !== tabela) {
    const andWhereA = c.where      ? ` AND (${c.where})`      : '';
    const andWhereB = c.where_join ? ` AND (${c.where_join})` : '';
    return `
      SELECT $2::text AS camada, 'qtd' AS metrica,
        COUNT(*)::numeric AS valor
      FROM ${tbl(tabela)} a
      JOIN ${tbl(joinTabela)} b
        ON ST_Intersects(a.geom, b.geom)
        AND ST_Dimension(ST_Intersection(a.geom, b.geom)) = 0
      WHERE ST_Intersects(a.geom, $1::geometry)${andWhereA}${andWhereB}
      HAVING COUNT(*) > 0`;
  }

  // Self-join de densidade (entroncamentos): devolve duas linhas — km_ref + dens_ent
  if (joinTabela && joinTabela === tabela && metrica === 'dens_ent') {
    // Une todas as tabelas de via definidas em tabelas_uniao (ou só tabela se ausente)
    const tabelasVia   = c.tabelas_uniao || [tabela];
    const andWhereVias = c.where ? ` AND (${c.where})` : '';
    const viasUnion = tabelasVia.map(t =>
      `SELECT (ST_Dump(ST_Intersection(geom, $1::geometry))).geom AS seg\n        FROM ${tbl(t)}\n        WHERE ST_Intersects(geom, $1::geometry)${andWhereVias}`
    ).join('\n      UNION ALL\n      ');
    return `
      WITH vias_clipped AS (
        -- Recorta cada tabela de via à UT; UNION ALL combina todas as camadas
        ${viasUnion}
      ),
      vias_lines AS (
        -- Apenas LineStrings válidas (descarta pontos/coleções degeneradas do recorte)
        SELECT seg FROM vias_clipped
        WHERE ST_GeometryType(seg) = 'ST_LineString' AND ST_Length(seg) > 0
      ),
      km_total AS (
        SELECT COALESCE(ROUND((SUM(ST_Length(seg::geography)) / 1000)::numeric, 3), 0) AS km_vias
        FROM vias_lines
      ),
      noded AS (
        -- ST_Node na rede já recortada à UT → nós apenas dentro do polígono
        SELECT (ST_Dump(ST_Node(ST_Collect(seg)))).geom AS seg
        FROM vias_lines
      ),
      endpoints AS (
        SELECT ST_SnapToGrid(ST_StartPoint(seg), 0.00001) AS pt
        FROM noded WHERE ST_GeometryType(seg) = 'ST_LineString'
        UNION ALL
        SELECT ST_SnapToGrid(ST_EndPoint(seg), 0.00001) AS pt
        FROM noded WHERE ST_GeometryType(seg) = 'ST_LineString'
      ),
      ent_count AS (
        SELECT COUNT(*)::numeric AS n_ent
        FROM (
          SELECT pt FROM endpoints GROUP BY pt HAVING COUNT(*) >= 3
        ) j
        WHERE ST_Within(pt, $1::geometry)
      )
      SELECT $2::text || '__km_ref' AS camada, 'km_ref' AS metrica, km_vias AS valor
        FROM km_total WHERE km_vias > 0
      UNION ALL
      SELECT $2::text || '__n_ent' AS camada, 'n_ent' AS metrica, n_ent AS valor
        FROM ent_count WHERE n_ent > 0
      UNION ALL
      SELECT $2::text AS camada, 'dens_ent' AS metrica,
        CASE WHEN km_vias > 0 THEN n_ent / km_vias ELSE 0 END AS valor
        FROM km_total, ent_count WHERE n_ent > 0 AND km_vias > 0`;
  }

  // Self-join de densidade (confluências de drenagem): devolve km_ref + n_conf + dens_conf
  // Mesma lógica topológica dos entroncamentos de vias, adaptada para redes hidrográficas.
  // Uma confluência é qualquer nó da rede onde 3+ segmentos se encontram (tributário + canal principal).
  if (joinTabela && joinTabela === tabela && metrica === 'dens_conf') {
    const tabelasDren    = c.tabelas_uniao || [tabela];
    const andWhereDren   = c.where ? ` AND (${c.where})` : '';
    const drenUnion      = tabelasDren.map(t =>
      `SELECT (ST_Dump(ST_Intersection(geom, $1::geometry))).geom AS seg\n        FROM ${tbl(t)}\n        WHERE ST_Intersects(geom, $1::geometry)${andWhereDren}`
    ).join('\n      UNION ALL\n      ');
    return `
      WITH dren_clipped AS (
        -- Recorta cada tabela de drenagem à UT; UNION ALL combina múltiplas camadas se necessário
        ${drenUnion}
      ),
      dren_lines AS (
        -- Apenas LineStrings válidas (descarta pontos/coleções degeneradas do recorte)
        SELECT seg FROM dren_clipped
        WHERE ST_GeometryType(seg) = 'ST_LineString' AND ST_Length(seg) > 0
      ),
      km_total AS (
        SELECT COALESCE(ROUND((SUM(ST_Length(seg::geography)) / 1000)::numeric, 3), 0) AS km_dren
        FROM dren_lines
      ),
      noded AS (
        -- ST_Node na rede clipped → segmentos com nós explícitos nos cruzamentos
        SELECT (ST_Dump(ST_Node(ST_Collect(seg)))).geom AS seg
        FROM dren_lines
      ),
      endpoints AS (
        -- Ponto inicial e final de cada segmento nodado
        SELECT ST_SnapToGrid(ST_StartPoint(seg), 0.00001) AS pt
        FROM noded WHERE ST_GeometryType(seg) = 'ST_LineString'
        UNION ALL
        SELECT ST_SnapToGrid(ST_EndPoint(seg), 0.00001) AS pt
        FROM noded WHERE ST_GeometryType(seg) = 'ST_LineString'
      ),
      conf_count AS (
        -- Confluência = nó onde 3+ segmentos se encontram (tributário + canal que continua)
        SELECT COUNT(*)::numeric AS n_conf
        FROM (
          SELECT pt FROM endpoints GROUP BY pt HAVING COUNT(*) >= 3
        ) j
        WHERE ST_Within(pt, $1::geometry)
      )
      SELECT $2::text || '__km_ref'  AS camada, 'km_ref'   AS metrica, km_dren  AS valor
        FROM km_total  WHERE km_dren > 0
      UNION ALL
      SELECT $2::text || '__n_conf'  AS camada, 'n_conf'   AS metrica, n_conf   AS valor
        FROM conf_count WHERE n_conf > 0
      UNION ALL
      SELECT $2::text               AS camada, 'dens_conf' AS metrica,
        CASE WHEN km_dren > 0 THEN n_conf / km_dren ELSE 0 END AS valor
        FROM km_total, conf_count WHERE n_conf > 0 AND km_dren > 0`;
  }

  // Self-join na mesma tabela (confluências genéricas)
  if (joinTabela && joinTabela === tabela) {
    return `
      SELECT $2::text AS camada, 'qtd' AS metrica,
        COUNT(*)::numeric AS valor
      FROM ${tbl(tabela)} a
      JOIN ${tbl(tabela)} b
        ON a.ctid < b.ctid
        AND ST_Intersects(a.geom, b.geom)
        AND ST_Dimension(ST_Intersection(a.geom, b.geom)) = 0
      WHERE ST_Intersects(a.geom, $1::geometry)
      HAVING COUNT(*) > 0`;
  }

  // Sem join — métricas simples
  // Campo opcional `c.where` adiciona filtro SQL extra (ex: "nome IS NOT NULL")
  const andWhere = c.where ? ` AND (${c.where})` : '';
  switch (metrica) {
    case 'km':
      return `
        SELECT $2::text AS camada, 'km' AS metrica,
          ROUND((SUM(ST_Length(ST_Intersection(f.geom, $1::geometry)::geography)) / 1000)::numeric, 3) AS valor
        FROM ${tbl(tabela)} f
        WHERE ST_Intersects(f.geom, $1::geometry)${andWhere}
        HAVING COUNT(*) > 0`;
    case 'qtd':
      return `
        SELECT $2::text AS camada, 'qtd' AS metrica,
          COUNT(*)::numeric AS valor
        FROM ${tbl(tabela)} f
        WHERE ST_Within(f.geom, $1::geometry)${andWhere}
        HAVING COUNT(*) > 0`;
    case 'perim':
      // Feições de área são pontuadas pelo PERÍMETRO (km) — proxy do esforço de vetorização.
      // ST_Perimeter sobre geography retorna metros; dividimos por 1000 para obter km.
      // O peso utilizado é pesos_geometria['km'] (mesma unidade de linhas).
      return `
        SELECT $2::text AS camada, 'km' AS metrica,
          ROUND((SUM(ST_Perimeter(ST_Intersection(f.geom, $1::geometry)::geography)) / 1000)::numeric, 3) AS valor
        FROM ${tbl(tabela)} f
        WHERE ST_Intersects(f.geom, $1::geometry)${andWhere}
        HAVING COUNT(*) > 0`;
    default:
      throw new Error(`Métrica desconhecida: ${metrica}`);
  }
}

// ------------------------------------------------------------------ //
// Recorte aos limites nacionais (llp_unidade_federacao_a)             //
// ------------------------------------------------------------------ //

// Cache LRU simples: chave = primeiros 200 chars do WKT (suficiente para identificar geom)
// TTL de 10 min — evita re-executar clipToUF para a mesma UT em cálculos de lote.
const _clipCache = new Map(); // key → { result, expires }
const CLIP_TTL   = 10 * 60 * 1000; // 10 minutos

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _clipCache) if (v.expires <= now) _clipCache.delete(k);
}, 5 * 60 * 1000).unref();

/**
 * Recorta a geometria da UT à união das Unidades Federativas (llp_unidade_federacao_a).
 *
 * Garante que feições fora do território nacional não sejam contabilizadas
 * (ex.: UTs de fronteira com dados OSM que se estendem para países vizinhos).
 *
 * Estratégia de fallback em dois passos:
 *  1. Tenta no banco EDGV ativo (pode já ter a camada populada)
 *  2. Se a tabela estiver vazia ou não existir, usa o banco de referência
 *     (insumos_oficiais), que sempre contém as 27 UFs do Brasil
 *  3. Se ambos falharem, retorna a geometria original sem recorte
 */
async function clipToUF(geomWKT) {
  // Chave de cache: primeiros 200 chars (inclui coordenadas únicas sem ser excessiva)
  const cacheKey = geomWKT.substring(0, 200);
  const cached   = _clipCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.result;
  // Remove o prefixo SRID= para usar com ST_GeomFromText + SRID explícito
  const wktPuro = geomWKT.replace(/^SRID=\d+;/i, '');

  const SQL = `
    SELECT ST_AsEWKT(
      ST_Intersection(
        ST_GeomFromText($1, 4674),
        ST_Union(geom)
      )
    ) AS clipped
    FROM edgv.llp_unidade_federacao_a
    WHERE ST_Intersects(geom, ST_GeomFromText($1, 4674))
  `;

  const store = result => {
    _clipCache.set(cacheKey, { result, expires: Date.now() + CLIP_TTL });
    return result;
  };

  for (const [pool, label] of [[edgvPool, 'banco ativo'], [refPool, 'insumos_oficiais']]) {
    try {
      const { rows } = await pool.query(SQL, [wktPuro]);
      const clipped  = rows[0]?.clipped;

      if (clipped && !/EMPTY/.test(clipped)) {
        return store(clipped);   // recorte válido — armazena no cache
      }
    } catch (err) {
      // Tabela não existe ou erro de conexão — tenta o próximo pool
      console.warn(`[clipToUF] ${label}: ${err.message.split('\n')[0]}`);
    }
  }

  // Nenhum pool retornou UF válida — usa geometria original sem recorte
  console.warn('[clipToUF] llp_unidade_federacao_a sem dados em todos os bancos — usando geometria original');
  return store(geomWKT);
}

// ------------------------------------------------------------------ //
// Extração de métricas                                                //
// ------------------------------------------------------------------ //

async function extractMetrics(geomWKT, subfaseKey = null, extraData = {}, lpKey = 'mapeamento_topo') {
  const mapeamento = loadMapeamento(lpKey);

  const subfasesAlvo = subfaseKey
    ? { [subfaseKey]: mapeamento.subfases[subfaseKey] }
    : mapeamento.subfases;

  // Deduplica por chave composta de camada
  const camadas = new Map();
  for (const sub of Object.values(subfasesAlvo)) {
    for (const c of (sub?.camadas || [])) {
      const k = camadaKey(c);
      if (!camadas.has(k)) camadas.set(k, c);
    }
  }

  const errosQuery = [];

  // Queries com ST_Node (entroncamentos/confluências) são topologicamente pesadas.
  // Usam client dedicado com statement_timeout local de 20 s para evitar travar o servidor.
  const TIMEOUT_COMPLEXO_MS = 20000;
  const metricasComplexas   = new Set(['dens_ent', 'dens_conf', 'km_named_body']);

  const queries = [...camadas.entries()].map(([key, c]) => {

    // ── JOIN cross-database (banco_join diferente do banco principal) ─────────
    // Ex: drenagem em insumos_oficiais × vias em insumo_osm.
    // Estratégia: (1) coleta geometria da tabela A no poolA como WKT;
    //             (2) conta interseções da tabela B no poolB usando esse WKT.
    if (c.banco_join) {
      return (async () => {
        try {
          const poolA    = resolvePool(c.banco);
          const poolB    = resolvePool(c.banco_join);
          const schemaA  = c.schema      || 'edgv';
          const schemaB  = c.schema_join || 'edgv';
          const tblA     = c.tabela.includes('.') ? c.tabela : `${schemaA}.${c.tabela}`;
          const tblB     = c.join.includes('.')   ? c.join   : `${schemaB}.${c.join}`;
          const andWhere = c.where ? ` AND (${c.where})` : '';

          // Passo 1: coleta todas as geometrias de A dentro da UT (poolA)
          const { rows: rA } = await poolA.query(`
            SELECT ST_AsText(ST_Collect(geom)) AS geom
            FROM ${tblA}
            WHERE ST_Intersects(geom, $1::geometry)${andWhere}
          `, [geomWKT]);

          const geomA = rA[0]?.geom;
          if (!geomA) return null;   // sem feições em A → 0 interseções

          // Passo 2: conta PARES (drenagem_i × via_j) que se cruzam em pontos (dim=0).
          // ST_Dump decompõe a coleção de geometrias de A em linhas individuais, replicando
          // a semântica do JOIN original (um par por combinação de feição A × feição B).
          // ST_SetSRID garante SRID=4674 para o WKT vindo de ST_AsText (que retorna sem SRID).
          const { rows: rB } = await poolB.query(`
            SELECT $1::text AS camada, 'qtd' AS metrica,
              COUNT(*)::numeric AS valor
            FROM ${tblB} b
            CROSS JOIN (
              SELECT (ST_Dump(ST_SetSRID(ST_GeomFromText($2), 4674))).geom AS geom_a
            ) a
            WHERE ST_Intersects(b.geom, $3::geometry)
              AND ST_Intersects(b.geom, a.geom_a)
              AND ST_Dimension(ST_Intersection(b.geom, a.geom_a)) = 0
            HAVING COUNT(*) > 0
          `, [key, geomA, geomWKT]);

          return rB.length ? rB : null;
        } catch (err) {
          const msg = err.message.split('\n')[0];
          console.warn(`[aviso-crossdb] ${key}: ${msg}`);
          errosQuery.push(msg);
          return null;
        }
      })();
    }

    // ── Caminho normal (single-database) ──────────────────────────────────────
    // Curva de nível com arquivo externo fornecido pelo usuário
    const usarCurvaNivelExt =
      c.tabela === 'elemnat_curva_nivel_l' &&
      c.join   === 'elemnat_trecho_drenagem_l' &&
      extraData?.curva_nivel_geojson;

    const sql    = usarCurvaNivelExt ? buildQueryCurvaNivelExt(c) : buildQuery(c);
    const params = usarCurvaNivelExt
      ? [geomWKT, key, extraData.curva_nivel_geojson, extraData.curva_nivel_srid ?? 4674]
      : [geomWKT, key];

    const pool = resolvePool(c.banco);

    const runQuery = metricasComplexas.has(c.metrica)
      // Query topológica pesada: client isolado com timeout reduzido
      ? () => pool.connect().then(client => {
          return client.query(`SET statement_timeout = ${TIMEOUT_COMPLEXO_MS}`)
            .then(() => client.query(sql, params))
            .then(r  => r.rows.length ? r.rows : null)
            .catch(err => {
              const msg = err.message.split('\n')[0];
              console.warn(`[aviso-topologia] ${key}: ${msg}`);
              errosQuery.push(msg);
              return null;
            })
            .finally(() => client.release());
        })
      // Query simples: pool direto
      : () => pool.query(sql, params)
          .then(r => r.rows.length ? r.rows : null)
          .catch(err => {
            const msg = err.message.split('\n')[0];
            console.warn(`[aviso] ${key}: ${msg}`);
            errosQuery.push(msg);
            return null;
          });

    return runQuery();
  });

  const rows = (await Promise.all(queries)).filter(Boolean).flat();

  // Lista de tabelas consultadas — usada no diagnóstico de zero-pontos
  const tabelasConsultadas = [...camadas.values()].map(c => {
    const schema = c.schema || 'edgv';
    return c.tabela.includes('.') ? c.tabela : `${schema}.${c.tabela}`;
  });

  return { rows, errosQuery, nCamadas: camadas.size, tabelasConsultadas };
}

// ------------------------------------------------------------------ //
// Curva de densidade para entroncamentos                              //
// ------------------------------------------------------------------ //

function getCurvaFatorDensidade(ent_por_km, curva) {
  if (!curva || !curva.pontos || curva.pontos.length === 0) return 1.0;
  for (const ponto of curva.pontos) {
    if (ent_por_km <= ponto.ent_por_km_max) return ponto.fator;
  }
  return curva.pontos[curva.pontos.length - 1].fator;
}

// ------------------------------------------------------------------ //
// Aplicação de pesos                                                  //
// ------------------------------------------------------------------ //

function applyWeights(metrics, subfaseKey = null, lpKey = 'mapeamento_topo') {
  const mapeamento = loadMapeamento(lpKey);
  const pesos      = loadPesos(lpKey);
  const pesosGeo   = pesos.pesos_geometria;
  const multSub    = pesos.multiplicadores_subfase;

  // Índice camadaKey → subfases + expoente
  const idx = {};
  for (const [key, sub] of Object.entries(mapeamento.subfases)) {
    for (const c of (sub.camadas || [])) {
      const k = camadaKey(c);
      (idx[k] = idx[k] || []).push({ subfase: key, metrica: c.metrica, expoente: c.expoente ?? 1 });
    }
  }

  // Separar linhas auxiliares (km_ref, n_ent, n_conf são referências para densidade)
  const kmRefMap        = {};
  const nEntMap         = {};
  const nConfMap        = {};
  const metricsFiltered = [];
  for (const row of metrics) {
    if (row.metrica === 'km_ref') {
      kmRefMap[row.camada.replace('__km_ref', '')] = parseFloat(row.valor);
    } else if (row.metrica === 'n_ent') {
      nEntMap[row.camada.replace('__n_ent', '')] = parseFloat(row.valor);
    } else if (row.metrica === 'n_conf') {
      nConfMap[row.camada.replace('__n_conf', '')] = parseFloat(row.valor);
    } else {
      metricsFiltered.push(row);
    }
  }

  const bySubfase = {};
  const detalhes  = [];   // breakdown por camada

  for (const { camada, metrica, valor } of metricsFiltered) {
    const entradas = idx[camada];
    if (!entradas) continue;

    // ── Métrica de densidade de entroncamentos (vias) ───────────────
    if (metrica === 'dens_ent') {
      const km_vias   = kmRefMap[camada] ?? 0;
      if (km_vias === 0) continue;
      const ent_per_km = parseFloat(valor);
      const fator      = getCurvaFatorDensidade(ent_per_km, pesos.curva_densidade_entroncamentos);
      const pts_base   = km_vias * (pesosGeo['km'] ?? 1.0);

      for (const { subfase } of entradas) {
        if (subfaseKey && subfase !== subfaseKey) continue;
        const mult = multSub[subfase]?.valor ?? 1.0;
        const pts  = pts_base * (fator - 1.0) * mult;
        bySubfase[subfase] = (bySubfase[subfase] ?? 0) + pts;
        detalhes.push({
          camada, metrica: 'dens_ent', subfase,
          valor:        +ent_per_km.toFixed(3),
          km_ref:       +km_vias.toFixed(3),
          n_ent:        +(nEntMap[camada] ?? 0),
          fator:        +fator.toFixed(3),
          peso_geo:     pesosGeo['km'] ?? 1.0,
          mult_subfase: mult,
          pts:          +pts.toFixed(2),
        });
      }
      continue;
    }

    // ── Métrica de densidade de confluências (drenagem) ──────────────
    // Mesmo modelo de entroncamentos: pontuação extra proporcional à complexidade
    // da rede hidrográfica medida pela densidade de confluências (conf/km).
    if (metrica === 'dens_conf') {
      const km_dren     = kmRefMap[camada] ?? 0;
      if (km_dren === 0) continue;
      const conf_per_km = parseFloat(valor);
      const fator       = getCurvaFatorDensidade(conf_per_km, pesos.curva_densidade_confluencias);
      const pts_base    = km_dren * (pesosGeo['km'] ?? 1.0);

      for (const { subfase } of entradas) {
        if (subfaseKey && subfase !== subfaseKey) continue;
        const mult = multSub[subfase]?.valor ?? 1.0;
        const pts  = pts_base * (fator - 1.0) * mult;
        bySubfase[subfase] = (bySubfase[subfase] ?? 0) + pts;
        detalhes.push({
          camada, metrica: 'dens_conf', subfase,
          valor:        +conf_per_km.toFixed(3),
          km_ref:       +km_dren.toFixed(3),
          n_conf:       +(nConfMap[camada] ?? 0),
          fator:        +fator.toFixed(3),
          peso_geo:     pesosGeo['km'] ?? 1.0,
          mult_subfase: mult,
          pts:          +pts.toFixed(2),
        });
      }
      continue;
    }

    // ── Métricas regulares ──────────────────────────────────────────
    const pesoGeo    = pesosGeo[metrica] ?? 1.0;
    const exp        = entradas[0].expoente ?? 1;
    const valorF     = parseFloat(valor);
    const valorAj    = exp !== 1 ? Math.pow(valorF, exp) : valorF;
    const pontosBrutos = valorAj * pesoGeo;

    for (const { subfase } of entradas) {
      if (subfaseKey && subfase !== subfaseKey) continue;
      const mult = multSub[subfase]?.valor ?? 1.0;
      const pts  = pontosBrutos * mult;
      bySubfase[subfase] = (bySubfase[subfase] ?? 0) + pts;
      detalhes.push({
        camada, metrica, subfase,
        valor:        +valorF.toFixed(3),
        expoente:     exp,
        valor_aj:     +valorAj.toFixed(3),
        peso_geo:     pesoGeo,
        mult_subfase: mult,
        pts:          +pts.toFixed(2),
      });
    }
  }

  for (const k of Object.keys(bySubfase)) bySubfase[k] = +bySubfase[k].toFixed(2);
  return { bySubfase, detalhes };
}

// ------------------------------------------------------------------ //
// Consolidação                                                        //
// ------------------------------------------------------------------ //

function consolidate(bySubfase, detalhes, multEscala = 1.0, lpKey = 'mapeamento_topo') {
  const pesos    = loadPesos(lpKey);
  const multVF   = pesos.multiplicadores_subfase['verificacao_final']?.valor ?? 1.0;

  // Aplica mult_escala a cada subfase e cap opcional (max_pts) — verificacao_final usa subtotal pós-cap
  const porSubfase    = {};
  const capsAplicados = [];
  for (const [k, v] of Object.entries(bySubfase)) {
    let scaled = v * multEscala;
    const maxPts = pesos.multiplicadores_subfase[k]?.max_pts;
    if (maxPts != null && scaled > maxPts) {
      capsAplicados.push({ subfase: k, max_pts: maxPts, pts_brutos: +scaled.toFixed(2) });
      scaled = maxPts;
    }
    porSubfase[k] = +scaled.toFixed(2);
  }

  const subtotal = Object.values(porSubfase).reduce((a, b) => a + b, 0);
  const pontosVF = +(subtotal * multVF).toFixed(2);

  const porSubfaseOrdenado = Object.fromEntries(
    Object.entries(porSubfase).sort(([, a], [, b]) => b - a)
  );
  porSubfaseOrdenado['verificacao_final'] = pontosVF;

  // Aplica mult_escala no breakdown de camadas também
  const porCamada = detalhes.map(d => ({
    ...d,
    pts: +(d.pts * multEscala).toFixed(2),
  }));

  return {
    score_total:    +(subtotal + pontosVF).toFixed(2),
    mult_escala:    +multEscala.toFixed(4),
    por_subfase:    porSubfaseOrdenado,
    por_camada:     porCamada,
    versao_pesos:   pesos.versao,
    taxa_pts_hora:  pesos.taxa_pts_hora ?? null,
    caps_aplicados: capsAplicados,
  };
}

// ------------------------------------------------------------------ //
// Função principal                                                    //
// ------------------------------------------------------------------ //

async function calculateScore(geomWKT, subfaseKey = null, multEscala = 1.0, extraData = {}, lpKey = 'mapeamento_topo') {
  // Recorta a geometria da UT aos limites nacionais antes de extrair métricas.
  // Evita contabilizar feições fora do Brasil (ex.: UTs de fronteira).
  const geomEfetivo = await clipToUF(geomWKT);

  const { rows: metrics, errosQuery, nCamadas, tabelasConsultadas } = await extractMetrics(geomEfetivo, subfaseKey, extraData, lpKey);

  if (metrics.length === 0) {
    // Log diagnóstico: mostra quais tabelas foram consultadas.
    // Para confirmar se a tabela tem dados globalmente, rode no banco:
    //   SELECT COUNT(*) FROM edgv.<tabela>;
    console.warn(
      `[zero-pts] banco=${require('./db').getEdgvDb()} subfase=${subfaseKey} lp=${lpKey}` +
      ` nCamadas=${nCamadas} erros=${errosQuery.length}` +
      ` tabelas=[${tabelasConsultadas.join(', ')}]`
    );
  }

  const { bySubfase, detalhes } = applyWeights(metrics, subfaseKey, lpKey);
  const resultado = consolidate(bySubfase, detalhes, multEscala, lpKey);

  // Diagnóstico incluso na resposta — frontend exibe aviso quando pontuação é zero
  resultado.n_metricas_brutas   = metrics.length;
  resultado.lp_mapeamento       = lpKey;
  resultado.tabelas_consultadas = tabelasConsultadas;
  if (errosQuery.length) resultado.avisos_query = errosQuery.slice(0, 5);

  return resultado;
}

function calcMultEscala(denominadorEscala, lpKey = 'mapeamento_topo') {
  const pesos = loadPesos(lpKey);
  if (!denominadorEscala || denominadorEscala <= 0) return 1.0;

  // Curva de escala em degraus (prioritária quando definida).
  // Reutiliza getCurvaFatorDensidade: ent_por_km_max serve como denominador_max.
  if (pesos.curva_escala?.pontos?.length) {
    return getCurvaFatorDensidade(denominadorEscala, pesos.curva_escala);
  }

  // Fallback: fórmula de potência (mantida para retrocompatibilidade)
  const cfg = pesos.escala || { referencia: 50000, expoente: 0.5 };
  return Math.pow(cfg.referencia / denominadorEscala, cfg.expoente);
}

function listSubfases(lpKey = 'mapeamento_topo') {
  const mapeamento = loadMapeamento(lpKey);
  return Object.entries(mapeamento.subfases)
    .filter(([key]) => key !== 'verificacao_final')
    .map(([key, sub]) => ({ key, id: sub.id, nome: sub.nome }))
    .sort((a, b) => a.id - b.id);
}

// Calcula TODAS as subfases de um LP para uma geometria, retornando scores individuais.
// Usado pela Calculadora de MI para comparação entre LPs.
async function calculateAllSubfases(geomWKT, multEscala, lpKey, extraData = {}) {
  const mapeamento  = loadMapeamento(lpKey);
  const allKeys     = Object.keys(mapeamento.subfases);
  // Processa todas as subfases sequencialmente (evita flood de conexões ao EDGV)
  const subfases = {};
  for (const sfKey of allKeys) {
    try {
      const r = await calculateScore(geomWKT, sfKey, multEscala, extraData, lpKey);
      subfases[sfKey] = {
        nome:       mapeamento.subfases[sfKey].nome,
        pts:        r.score_total,
        por_camada: r.por_camada || [],
        avisos:     r.avisos_query || [],
      };
    } catch (e) {
      subfases[sfKey] = {
        nome:  mapeamento.subfases[sfKey].nome,
        pts:   0,
        erro:  e.message,
      };
    }
  }
  const total = Object.values(subfases).reduce((s, v) => s + (v.pts || 0), 0);
  return { subfases, total, lp_key: lpKey };
}

module.exports = { calculateScore, calculateAllSubfases, calcMultEscala, extractMetrics, applyWeights, consolidate, listSubfases, clipToUF, detectLPKey };
