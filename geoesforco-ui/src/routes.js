const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const express = require("express");
const multer  = require("multer");
const { sapPool, edgvPool, osmPool, getEdgvDb, setEdgvDb } = require("./db");
const {
  calculateScore,
  calculateAllSubfases,
  calcMultEscala,
  listSubfases,
  clipToUF,
  detectLPKey,
} = require("./calculadora");
const sapMapping       = require("./sapMapping");
const { parseFile: parseCurvaNivel } = require("./curvaNivelParser");
const { parseGeomFile }              = require("./geomParser");

const LP_DIR = path.join(__dirname, "../../calculadora_pontos");
const _mapRoutesCache = new Map();
function loadMapeamento(key = "mapeamento_topo") {
  if (!_mapRoutesCache.has(key)) {
    const filePath = path.join(LP_DIR, `${key}.json`);
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    _mapRoutesCache.set(key, data);
    try { fs.watch(filePath, () => _mapRoutesCache.delete(key)); } catch (_) {}
  }
  return _mapRoutesCache.get(key);
}

const router = express.Router();

// ── Store de curvas de nível carregadas pelo usuário ────────────────────────
// token (UUID) → { geojson: string, srid: number, nLinhas: number, expires: number }
const curvaNivelStore = new Map();

// Limpa entradas expiradas a cada 30 minutos
setInterval(() => {
  const now = Date.now();
  for (const [token, val] of curvaNivelStore)
    if (val.expires <= now) curvaNivelStore.delete(token);
}, 30 * 60 * 1000).unref();

// Multer — armazena o arquivo em memória (sem gravar em disco)
const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 200 * 1024 * 1024 }, // 200 MB
});

// Constrói o mapeamento automático SAP → subfaseKey na inicialização
sapMapping.buildMapping(sapPool).catch(e =>
  console.error("[sap-mapping] falha na inicialização:", e.message)
);

function sapIdToKey(sapId) {
  return sapMapping.sapIdToKey(sapId);
}

// ------------------------------------------------------------------ //
// GET  /api/databases  — lista bancos EDGV disponíveis (com moldura)
// GET  /api/databases/ativo  — banco ativo atual
// POST /api/databases/ativo  — troca banco ativo  { "db": "insumo_osm" }
// ------------------------------------------------------------------ //
router.get("/databases", async (req, res) => {
  try {
    const { Pool } = require("pg");
    const adminPool = new Pool({
      host: process.env.PG_HOST || "localhost",
      port: parseInt(process.env.PG_PORT || "5432"),
      user: process.env.PG_USER || "postgres",
      password: process.env.PG_PASSWORD || "postgres",
      database: "postgres",
    });
    // Lista todos os bancos não-sistema disponíveis no servidor
    const { rows } = await adminPool.query(`
      SELECT datname AS db
      FROM pg_database
      WHERE datistemplate = false
        AND datname NOT IN ('postgres', 'template0', 'template1')
      ORDER BY datname
    `);
    await adminPool.end();
    res.json({ databases: rows.map((r) => r.db), ativo: getEdgvDb() });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

router.get("/databases/ativo", (req, res) => {
  res.json({ ativo: getEdgvDb() });
});

router.post("/databases/ativo", async (req, res) => {
  const { db } = req.body;
  if (!db || typeof db !== "string" || !/^[\w\-\.]+$/.test(db)) {
    return res.status(400).json({ erro: "Nome de banco inválido" });
  }
  // Verifica se o banco existe e é acessível (sem exigir tabela específica)
  try {
    const { Pool } = require("pg");
    const testPool = new Pool({
      host:     process.env.PG_HOST     || "localhost",
      port:     parseInt(process.env.PG_PORT || "5432"),
      user:     process.env.PG_USER     || "postgres",
      password: process.env.PG_PASSWORD || "postgres",
      database: db,
      connectionTimeoutMillis: 5000,
    });
    await testPool.query("SELECT current_database()");
    await testPool.end();
  } catch (err) {
    return res
      .status(400)
      .json({ erro: `Banco "${db}" inacessível: ${err.message}` });
  }
  setEdgvDb(db);
  res.json({ ativo: db });
});

// ------------------------------------------------------------------ //
// GET /api/subfases
// ------------------------------------------------------------------ //
router.get("/subfases", (req, res) => {
  const lpKey = req.query.lp_key || "mapeamento_topo";
  res.json(listSubfases(lpKey));
});

// ------------------------------------------------------------------ //
// GET /api/projetos  — lista projetos do SAP
// ------------------------------------------------------------------ //
router.get("/projetos", async (req, res) => {
  try {
    const { rows } = await sapPool.query(`
      SELECT id, nome FROM macrocontrole.projeto ORDER BY nome
    `);
    res.json(rows.map(r => ({ id: Number(r.id), nome: r.nome })));
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ------------------------------------------------------------------ //
// GET /api/lotes  — lista todos os lotes com projeto e LP
// ------------------------------------------------------------------ //
router.get("/lotes", async (req, res) => {
  try {
    const { rows } = await sapPool.query(`
      SELECT l.id, l.nome, l.projeto_id, l.linha_producao_id, l.denominador_escala
      FROM macrocontrole.lote l
      ORDER BY l.nome
    `);
    res.json(rows.map(r => ({
      id:                Number(r.id),
      nome:              r.nome,
      projeto_id:        r.projeto_id        ? Number(r.projeto_id)        : null,
      linha_producao_id: r.linha_producao_id ? Number(r.linha_producao_id) : null,
      denominador_escala: r.denominador_escala,
    })));
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ------------------------------------------------------------------ //
// PATCH /api/uts/prioridade/lote
// Body: { updates: [{ id, prioridade }, ...] }
// ------------------------------------------------------------------ //
router.patch('/uts/prioridade/lote', async (req, res) => {
  const { updates } = req.body;
  if (!Array.isArray(updates) || !updates.length)
    return res.status(400).json({ erro: 'updates deve ser um array não-vazio' });

  const invalidos = updates.filter(u => !Number.isFinite(u.id) || !Number.isFinite(u.prioridade));
  if (invalidos.length)
    return res.status(400).json({ erro: `${invalidos.length} entradas inválidas` });

  try {
    const ids  = updates.map(u => u.id);
    const vals = updates.map(u => Math.round(u.prioridade));
    await sapPool.query(
      `UPDATE macrocontrole.unidade_trabalho ut
          SET prioridade = v.prio
         FROM (
           SELECT unnest($1::int[]) AS id,
                  unnest($2::int[]) AS prio
         ) v
        WHERE ut.id = v.id`,
      [ids, vals],
    );
    res.json({ ok: true, updated: updates.length });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ------------------------------------------------------------------ //
// GET /api/linhas-producao
// Retorna linhas de produção disponíveis com suas subfase_keys
// ------------------------------------------------------------------ //
router.get("/linhas-producao", async (req, res) => {
  try {
    let rows;
    // Tenta várias variações de colunas (disponivel, nome_abrev podem não existir)
    const queries = [
      `SELECT id, nome, nome_abrev FROM macrocontrole.linha_producao WHERE disponivel = true ORDER BY id`,
      `SELECT id, nome, nome_abrev FROM macrocontrole.linha_producao ORDER BY id`,
      `SELECT id, nome, NULL AS nome_abrev FROM macrocontrole.linha_producao WHERE disponivel = true ORDER BY id`,
      `SELECT id, nome, NULL AS nome_abrev FROM macrocontrole.linha_producao ORDER BY id`,
    ];
    for (const q of queries) {
      try { rows = (await sapPool.query(q)).rows; break; } catch (_) {}
    }
    if (!rows) return res.status(500).json({ erro: 'Não foi possível listar linhas de produção' });
    res.json(rows.map(lp => ({
      id:           Number(lp.id),
      nome:         lp.nome,
      nome_abrev:   lp.nome_abrev || null,
      subfase_keys: sapMapping.getSubfaseKeysByLP(lp.id),
    })));
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ------------------------------------------------------------------ //
// GET  /api/sap-mapping         — mostra mapeamento automático atual
// POST /api/sap-mapping/refresh — re-consulta o SAP e reconstrói o índice
// ------------------------------------------------------------------ //
router.get("/sap-mapping", (req, res) => {
  res.json(sapMapping.getFullMapping());
});

// HTML amigável para diagnóstico — abra no browser: GET /api/sap-mapping/status
router.get("/sap-mapping/status", (req, res) => {
  const { mapeado, nao_mapeado } = sapMapping.getFullMapping();
  const built = sapMapping.isBuilt();

  const rows = Object.entries(mapeado).map(([key, v]) => {
    const sfList = v.subfases_sap.map(s => `${s.id}: ${s.nome}`).join('<br>') || '—';
    const ok = v.sap_ids.length > 0;
    return `<tr style="background:${ok?'#e8f5e9':'#fff3e0'}">
      <td><code>${key}</code></td>
      <td>${v.nome}</td>
      <td>${ok ? '✅' : '❌'}</td>
      <td style="font-size:12px">${sfList}</td>
    </tr>`;
  }).join('');

  const naoRows = nao_mapeado.map(r =>
    `<tr><td>${r.id}</td><td><strong>${r.nome}</strong></td><td>lp_id=${r.linha_producao_id??'?'}</td></tr>`
  ).join('') || '<tr><td colspan="3">Todos mapeados ✅</td></tr>';

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>SAP Mapping</title>
  <style>body{font-family:sans-serif;padding:20px} table{border-collapse:collapse;width:100%}
  td,th{border:1px solid #ccc;padding:6px 10px;vertical-align:top} th{background:#f5f5f5}</style></head>
  <body>
  <h2>SAP Mapping — Status</h2>
  <p>Mapeamento construído: <strong>${built ? 'SIM ✅' : 'NÃO ❌ (servidor recém iniciado?)'}</strong></p>
  <h3>Chaves internas × Subfases SAP</h3>
  <table><tr><th>Key interna</th><th>Nome</th><th>OK?</th><th>Subfases SAP mapeadas</th></tr>${rows}</table>
  <h3>Subfases SAP sem mapeamento</h3>
  <p>Estas subfases existem no banco SAP mas não casaram com nenhum <code>sap_nome_contains</code>:</p>
  <table><tr><th>ID SAP</th><th>Nome no SAP</th><th>LP</th></tr>${naoRows}</table>
  <p><a href="/api/sap-mapping">Ver JSON completo</a> |
     <form method="POST" action="/api/sap-mapping/refresh" style="display:inline">
       <button type="submit">🔄 Reconstruir mapeamento</button>
     </form>
  </p></body></html>`);
});

router.post("/sap-mapping/refresh", async (req, res) => {
  try {
    const mapping = await sapMapping.buildMapping(sapPool);
    res.json(mapping);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ------------------------------------------------------------------ //
// GET /api/formulas
// Retorna dados completos para a aba de fórmulas
// ------------------------------------------------------------------ //
router.get("/formulas", (req, res) => {
  const mapeamento = loadMapeamento();
  const pesos = JSON.parse(
    require("fs").readFileSync(
      require("path").join(
        __dirname,
        "../../calculadora_pontos/pesos/pesos_topo_v1.json",
      ),
      "utf8",
    ),
  );

  const METRICA_LABEL = {
    qtd: "contagem (qtd)",
    km: "comprimento (km)",
    ha: "área (ha)",
  };

  const subfases = Object.entries(mapeamento.subfases).map(([key, sub]) => ({
    key,
    nome: sub.nome,
    multiplicador: pesos.multiplicadores_subfase[key]?.valor ?? 1.0,
    camadas: (sub.camadas || []).map((c) => ({
      tabela: c.tabela,
      metrica: c.metrica,
      metricaLabel: METRICA_LABEL[c.metrica] || c.metrica,
      pesoGeo: pesos.pesos_geometria[c.metrica] ?? 1.0,
      join: c.join || null,
      expoente: c.expoente ?? 1,
      descricao: c._descricao || null,
    })),
    nota: sub._nota || null,
  }));

  res.json({
    versao_pesos: pesos.versao,
    data_pesos: pesos.data,
    pesos_geometria: pesos.pesos_geometria,
    subfases,
    formula_geral: [
      "Para cada camada de uma subfase:",
      "  contribuição = valor ^ expoente × peso_geometria",
      "Score da subfase:",
      "  score_subfase = Σ(contribuições) × multiplicador_subfase",
      "Verificação Final:",
      "  score_vf = Σ(score_subfases) × mult_verificacao_final",
      "Score total:",
      "  score_total = Σ(score_subfases) + score_vf",
    ],
  });
});

// ------------------------------------------------------------------ //
// GET /api/moldura  — contorno unificado (para referência visual)
// ------------------------------------------------------------------ //
router.get("/moldura", async (req, res) => {
  try {
    const { rows } = await edgvPool.query(`
      SELECT ST_AsGeoJSON(ST_Union(geom))::json AS geom
      FROM edgv.aux_moldura_a
    `);
    if (!rows[0]?.geom) return res.json(null);
    res.json({ type: "Feature", geometry: rows[0].geom, properties: {} });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ------------------------------------------------------------------ //
// GET /api/moldura/features  — feições individuais (para seleção no MI)
// ------------------------------------------------------------------ //
router.get("/moldura/features", async (req, res) => {
  // Parâmetro opcional ?banco=nome — usa banco diferente sem alterar o pool global
  const bancoParam    = req.query.banco?.trim() || null;
  const bancoOriginal = getEdgvDb();
  try {
    if (bancoParam && bancoParam !== bancoOriginal) setEdgvDb(bancoParam);

    // Query única: to_jsonb(t.*) - 'geom' remove a coluna de geometria e retorna
    // todas as outras colunas como JSONB — sem precisar inspecionar information_schema.
    const { rows } = await edgvPool.query(`
      SELECT
        (to_jsonb(t.*) - 'geom') AS props,
        ST_AsGeoJSON(geom, 6)::json  AS geom_json
      FROM edgv.aux_moldura_a t
    `);

    const features = rows.map((r, i) => ({
      type:       'Feature',
      geometry:   r.geom_json,
      properties: { ...r.props, _idx: i },
    }));

    res.json({ type: 'FeatureCollection', features });
  } catch (err) {
    console.error('[moldura/features]', err.message);
    res.status(500).json({ erro: err.message });
  } finally {
    // Restaura banco original se foi trocado
    if (bancoParam && bancoParam !== bancoOriginal) setEdgvDb(bancoOriginal);
  }
});

// ------------------------------------------------------------------ //
// GET /api/uts/lista  — metadados sem geometria (busca/filtro na UI)
// ------------------------------------------------------------------ //
router.get("/uts/lista", async (req, res) => {
  try {
    const conditions = ['1=1'];
    const params     = [];

    if (req.query.lote_id) {
      params.push(Number(req.query.lote_id));
      conditions.push(`ut.lote_id = $${params.length}`);
    }

    if (req.query.linha_producao_id) {
      params.push(Number(req.query.linha_producao_id));
      conditions.push(`l.linha_producao_id = $${params.length}`);
    }

    const { rows } = await sapPool.query(`
      SELECT
        ut.id,
        ut.nome,
        ut.subfase_id,
        ut.lote_id,
        ut.disponivel,
        ut.dificuldade,
        ut.prioridade,
        l.nome               AS lote,
        l.denominador_escala AS denominador_escala,
        l.projeto_id         AS projeto_id,
        l.linha_producao_id  AS linha_producao_id,
        sf.nome              AS subfase_nome
      FROM macrocontrole.unidade_trabalho ut
      LEFT JOIN macrocontrole.lote    l  ON l.id  = ut.lote_id
      LEFT JOIN macrocontrole.subfase sf ON sf.id = ut.subfase_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY ut.nome
    `, params);

    res.json(rows.map((r) => ({
      id:                r.id,
      nome:              r.nome,
      lote_id:           r.lote_id         ? Number(r.lote_id)         : null,
      lote:              r.lote,
      denominador_escala: r.denominador_escala,
      projeto_id:        r.projeto_id       ? Number(r.projeto_id)      : null,
      linha_producao_id: r.linha_producao_id ? Number(r.linha_producao_id) : null,
      subfase_id:        r.subfase_id       ? Number(r.subfase_id)      : null,
      subfase_nome:      r.subfase_nome,
      subfase_key:       sapIdToKey(r.subfase_id) ?? null,
      disponivel:        r.disponivel,
      dificuldade:       r.dificuldade,
      prioridade:        r.prioridade,
    })));
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ------------------------------------------------------------------ //
// GET /api/uts?lote_id=X&subfase_key=Y  — retorna FeatureCollection
// Ambos os filtros são opcionais; sem filtro retorna tudo.
// ------------------------------------------------------------------ //
router.get('/uts', async (req, res) => {
  try {
    const conditions = ['1=1'];
    const params     = [];

    if (req.query.lote_id) {
      params.push(parseInt(req.query.lote_id));
      conditions.push(`ut.lote_id = $${params.length}`);
    }

    if (req.query.subfase_key) {
      const ids = sapMapping.getSapIds(req.query.subfase_key);
      if (ids.length) {
        params.push(ids);
        conditions.push(`ut.subfase_id = ANY($${params.length}::int[])`);
      }
    }

    const { rows } = await sapPool.query(`
      SELECT
        ut.id, ut.nome, ut.subfase_id, ut.lote_id,
        ut.disponivel, ut.dificuldade, ut.prioridade,
        l.nome               AS lote,
        l.denominador_escala AS denominador_escala,
        sf.nome              AS subfase_nome,
        ST_AsGeoJSON(ut.geom)::json AS geom
      FROM macrocontrole.unidade_trabalho ut
      LEFT JOIN macrocontrole.lote    l  ON l.id  = ut.lote_id
      LEFT JOIN macrocontrole.subfase sf ON sf.id = ut.subfase_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY ut.nome
    `, params);

    const features = rows.map(r => ({
      type: 'Feature',
      geometry: r.geom,
      properties: {
        id:                  r.id,
        nome:                r.nome,
        lote:                r.lote,
        denominador_escala:  r.denominador_escala,
        subfase_id:          r.subfase_id,
        subfase_nome:        r.subfase_nome,
        subfase_key:         sapIdToKey(r.subfase_id) ?? null,
        disponivel:          r.disponivel,
        dificuldade:         r.dificuldade,
        prioridade:          r.prioridade,
      },
    }));

    res.json({ type: 'FeatureCollection', features });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ------------------------------------------------------------------ //
// GET /api/uts/:id
// ------------------------------------------------------------------ //
router.get("/uts/:id", async (req, res) => {
  try {
    const { rows } = await sapPool.query(
      `
      SELECT
        ut.id, ut.nome, ut.disponivel, ut.dificuldade, ut.subfase_id,
        l.nome               AS lote,
        l.denominador_escala AS denominador_escala,
        sf.nome              AS subfase_nome,
        ST_AsGeoJSON(ut.geom)::json AS geom
      FROM macrocontrole.unidade_trabalho ut
      LEFT JOIN macrocontrole.lote    l  ON l.id  = ut.lote_id
      LEFT JOIN macrocontrole.subfase sf ON sf.id = ut.subfase_id
      WHERE ut.id = $1
    `,
      [req.params.id],
    );

    if (!rows.length)
      return res.status(404).json({ erro: "UT não encontrada" });

    const r = rows[0];
    res.json({
      type: "Feature",
      geometry: r.geom,
      properties: {
        id: r.id,
        nome: r.nome,
        lote: r.lote,
        denominador_escala: r.denominador_escala,
        subfase_id: r.subfase_id,
        subfase_nome: r.subfase_nome,
        subfase_key: sapIdToKey(r.subfase_id) ?? null,
      },
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ------------------------------------------------------------------ //
// PATCH /api/uts/dificuldade/lote
// Body: { updates: [{ id, dificuldade }, ...] }
// Atualiza dificuldade de várias UTs em uma única transação.
// ------------------------------------------------------------------ //
router.patch('/uts/dificuldade/lote', async (req, res) => {
  const { updates } = req.body;
  if (!Array.isArray(updates) || !updates.length)
    return res.status(400).json({ erro: 'updates deve ser um array não-vazio' });

  const invalidos = updates.filter(u => !Number.isFinite(u.id) || !Number.isFinite(u.dificuldade));
  if (invalidos.length)
    return res.status(400).json({ erro: `${invalidos.length} entradas inválidas (id ou dificuldade não numérico)` });

  try {
    const ids   = updates.map(u => u.id);
    const vals  = updates.map(u => Math.round(u.dificuldade));
    await sapPool.query(
      `UPDATE macrocontrole.unidade_trabalho ut
          SET dificuldade = v.dif
         FROM (
           SELECT unnest($1::int[]) AS id,
                  unnest($2::int[]) AS dif
         ) v
        WHERE ut.id = v.id`,
      [ids, vals],
    );
    res.json({ ok: true, updated: updates.length });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ------------------------------------------------------------------ //
// PATCH /api/uts/:id/dificuldade
// Body: { dificuldade: <number> }
// Atualiza o campo dificuldade de uma única UT.
// ------------------------------------------------------------------ //
router.patch('/uts/:id/dificuldade', async (req, res) => {
  const id = parseInt(req.params.id);
  const dificuldade = req.body?.dificuldade;
  if (!Number.isFinite(id))
    return res.status(400).json({ erro: 'id inválido' });
  if (dificuldade === undefined || dificuldade === null || !Number.isFinite(Number(dificuldade)))
    return res.status(400).json({ erro: 'dificuldade deve ser numérico' });

  try {
    const { rowCount } = await sapPool.query(
      `UPDATE macrocontrole.unidade_trabalho SET dificuldade = $1 WHERE id = $2`,
      [Math.round(Number(dificuldade)), id],
    );
    if (!rowCount) return res.status(404).json({ erro: 'UT não encontrada' });
    res.json({ ok: true, id, dificuldade: Math.round(Number(dificuldade)) });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ------------------------------------------------------------------ //
// GET /api/vetores?ut_id=X&subfase_key=Y
//
// Retorna GeoJSON FeatureCollection com as feições EDGV da subfase
// cortadas pela geometria da UT (usado para visualização no mapa).
// ------------------------------------------------------------------ //
// ------------------------------------------------------------------ //
// Núcleo compartilhado: busca vetores EDGV para um WKT + subfase      //
// ------------------------------------------------------------------ //
async function fetchVetoresForWKT(wkt, subfaseKey, lpKey) {
  const m     = loadMapeamento(lpKey);
  const sfDef = m.subfases[subfaseKey];
  if (!sfDef) throw Object.assign(new Error(`Subfase não encontrada: ${subfaseKey}`), { status: 400 });

  // Deduplica tabelas simples (evita buscar a mesma tabela múltiplas vezes)
  const metricasComplexas = new Set(['dens_ent', 'dens_conf']);
  const tabelasVistas = new Set();
  const tarefas = (sfDef.camadas || []).filter(c => {
    if (metricasComplexas.has(c.metrica)) return false;
    const chave = `${c.tabela}||${c.where || ''}`;
    if (tabelasVistas.has(chave)) return false;
    tabelasVistas.add(chave);
    return true;
  });

  const LIMITE   = 2000;
  const features = [];

  // Feições simples (km / qtd / ha)
  await Promise.all(tarefas.map(async c => {
    const tipo     = c.tabela.endsWith('_l') ? 'linha'
                   : c.tabela.endsWith('_p') ? 'ponto'
                   : 'area';
    const andWhere = c.where ? ` AND (${c.where})` : '';
    try {
      const sql = tipo === 'ponto'
        ? `SELECT ST_AsGeoJSON(geom)::json AS geom
           FROM edgv.${c.tabela}
           WHERE ST_Within(geom, $1::geometry)${andWhere}
           LIMIT ${LIMITE}`
        : `SELECT ST_AsGeoJSON(ST_Intersection(geom, $1::geometry))::json AS geom
           FROM edgv.${c.tabela}
           WHERE ST_Intersects(geom, $1::geometry)${andWhere}
           LIMIT ${LIMITE}`;
      const { rows } = await edgvPool.query(sql, [wkt]);
      for (const r of rows) {
        if (!r.geom) continue;
        features.push({ type: 'Feature', geometry: r.geom,
          properties: { camada: c.tabela, tipo, where: c.where || null } });
      }
    } catch (_) { /* tabela pode não existir neste banco */ }
  }));

  // Entroncamentos (dens_ent)
  const densEntDef = (sfDef.camadas || []).find(c => c.metrica === 'dens_ent');
  if (densEntDef) {
    try {
      const tabelasVia   = densEntDef.tabelas_uniao || [densEntDef.tabela];
      const andWhereVias = densEntDef.where ? ` AND (${densEntDef.where})` : '';
      const viasUnion    = tabelasVia.map(t =>
        `SELECT (ST_Dump(ST_Intersection(geom, (SELECT geom FROM ut)))).geom AS seg
         FROM edgv.${t}
         WHERE ST_Intersects(geom, (SELECT geom FROM ut))${andWhereVias}`
      ).join('\nUNION ALL\n');

      const sqlEnt = `
        WITH ut AS (SELECT $1::geometry AS geom),
        vias_clipped AS (${viasUnion}),
        vias_lines   AS (
          SELECT seg FROM vias_clipped
          WHERE ST_GeometryType(seg) = 'ST_LineString' AND ST_Length(seg) > 0
        ),
        noded        AS (
          SELECT (ST_Dump(ST_Node(ST_Collect(seg)))).geom AS seg FROM vias_lines
        ),
        endpoints    AS (
          SELECT ST_SnapToGrid(ST_StartPoint(seg), 0.00001) AS pt
            FROM noded WHERE ST_GeometryType(seg) = 'ST_LineString'
          UNION ALL
          SELECT ST_SnapToGrid(ST_EndPoint(seg), 0.00001) AS pt
            FROM noded WHERE ST_GeometryType(seg) = 'ST_LineString'
        ),
        junctions    AS (
          SELECT pt FROM endpoints GROUP BY pt HAVING COUNT(*) >= 3
        )
        SELECT ST_AsGeoJSON(pt)::json AS geom
        FROM junctions, ut
        WHERE ST_Within(pt, ut.geom)
        LIMIT 500`;

      const { rows: entRows } = await edgvPool.query(sqlEnt, [wkt]);
      for (const r of entRows) {
        if (!r.geom) continue;
        features.push({ type: 'Feature', geometry: r.geom,
          properties: { camada: 'entroncamentos', tipo: 'ponto' } });
      }
    } catch (_) { /* tabela pode não existir neste banco */ }
  }

  // Confluências (dens_conf)
  const densConfDef = (sfDef.camadas || []).find(c => c.metrica === 'dens_conf');
  if (densConfDef) {
    try {
      const tabelasDren  = densConfDef.tabelas_uniao || [densConfDef.tabela];
      const andWhereDren = densConfDef.where ? ` AND (${densConfDef.where})` : '';
      const drenUnion    = tabelasDren.map(t =>
        `SELECT (ST_Dump(ST_Intersection(geom, (SELECT geom FROM ut)))).geom AS seg
         FROM edgv.${t}
         WHERE ST_Intersects(geom, (SELECT geom FROM ut))${andWhereDren}`
      ).join('\nUNION ALL\n');

      const sqlConf = `
        WITH ut AS (SELECT $1::geometry AS geom),
        dren_clipped AS (${drenUnion}),
        dren_lines   AS (
          SELECT seg FROM dren_clipped
          WHERE ST_GeometryType(seg) = 'ST_LineString' AND ST_Length(seg) > 0
        ),
        noded        AS (
          SELECT (ST_Dump(ST_Node(ST_Collect(seg)))).geom AS seg FROM dren_lines
        ),
        endpoints    AS (
          SELECT ST_SnapToGrid(ST_StartPoint(seg), 0.00001) AS pt
            FROM noded WHERE ST_GeometryType(seg) = 'ST_LineString'
          UNION ALL
          SELECT ST_SnapToGrid(ST_EndPoint(seg), 0.00001) AS pt
            FROM noded WHERE ST_GeometryType(seg) = 'ST_LineString'
        ),
        confluencias AS (
          SELECT pt FROM endpoints GROUP BY pt HAVING COUNT(*) >= 3
        )
        SELECT ST_AsGeoJSON(pt)::json AS geom
        FROM confluencias, ut
        WHERE ST_Within(pt, ut.geom)
        LIMIT 500`;

      const { rows: confRows } = await edgvPool.query(sqlConf, [wkt]);
      for (const r of confRows) {
        if (!r.geom) continue;
        features.push({ type: 'Feature', geometry: r.geom,
          properties: { camada: 'confluencias', tipo: 'ponto' } });
      }
    } catch (_) { /* tabela pode não existir neste banco */ }
  }

  return features;
}

// GET /api/vetores?ut_id=N&subfase_key=X  (modo SAP)
router.get("/vetores", async (req, res) => {
  const { ut_id, subfase_key, lp_key } = req.query;
  if (!ut_id || !subfase_key)
    return res.status(400).json({ erro: "ut_id e subfase_key são obrigatórios" });

  try {
    const { rows: utRows } = await sapPool.query(
      `SELECT ST_AsEWKT(ST_Force2D(ST_Transform(ut.geom, 4674))) AS wkt,
              lp.nome AS lp_nome
       FROM macrocontrole.unidade_trabalho ut
       LEFT JOIN macrocontrole.subfase sf ON sf.id = ut.subfase_id
       LEFT JOIN macrocontrole.fase    fa ON fa.id = sf.fase_id
       LEFT JOIN macrocontrole.linha_producao lp ON lp.id = fa.linha_producao_id
       WHERE ut.id = $1`,
      [parseInt(ut_id)]
    );
    if (!utRows.length) return res.status(404).json({ erro: "UT não encontrada" });

    const wkt   = await clipToUF(utRows[0].wkt);
    const lpKey = lp_key || detectLPKey(utRows[0].lp_nome);

    const features = await fetchVetoresForWKT(wkt, subfase_key, lpKey);
    res.json({ type: 'FeatureCollection', features });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ erro: err.message });
  }
});

// POST /api/vetores  { geojson, subfase_key, lp_key }  (modo Arquivo / Mapa)
router.post("/vetores", async (req, res) => {
  const { geojson, subfase_key, lp_key } = req.body;
  if (!geojson || !subfase_key)
    return res.status(400).json({ erro: "geojson e subfase_key são obrigatórios" });

  try {
    const { rows } = await edgvPool.query(
      `SELECT ST_AsEWKT(ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4674))) AS wkt`,
      [JSON.stringify(geojson)]
    );
    const wkt   = await clipToUF(rows[0].wkt);
    const lpKey = lp_key || 'mapeamento_topo';

    const features = await fetchVetoresForWKT(wkt, subfase_key, lpKey);
    res.json({ type: 'FeatureCollection', features });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ erro: err.message });
  }
});

// ------------------------------------------------------------------ //
// POST /api/curva-nivel/parse
//
// Multipart: campo "curva_nivel" — arquivo .zip (SHP) ou .gpkg
// Parseia as geometrias de curva de nível, armazena por token (TTL 2h) e
// devolve { token, srid, nLinhas } para uso nos endpoints /api/calcular*.
// ------------------------------------------------------------------ //
router.post(
  "/curva-nivel/parse",
  uploadMemory.single("curva_nivel"),
  async (req, res) => {
    if (!req.file)
      return res.status(400).json({ erro: "Campo 'curva_nivel' ausente" });

    try {
      const { lines, srid } = await parseCurvaNivel(
        req.file.buffer,
        req.file.originalname,
      );

      if (!lines.length)
        return res.status(422).json({
          erro: "Nenhuma feição LineString encontrada no arquivo",
        });

      const multilineGeojson = JSON.stringify({
        type: "MultiLineString",
        coordinates: lines,
      });

      const token = crypto.randomUUID();
      curvaNivelStore.set(token, {
        geojson:  multilineGeojson,
        srid,
        nLinhas:  lines.length,
        expires:  Date.now() + 2 * 60 * 60 * 1000, // 2h TTL
      });

      res.json({ token, srid, nLinhas: lines.length });
    } catch (err) {
      console.error("[curva-nivel/parse]", err.message);
      res.status(422).json({ erro: err.message });
    }
  },
);

// ------------------------------------------------------------------ //
// POST /api/arquivo/parse
//
// Multipart: campo "arquivo" — arquivo .zip (SHP zipado) ou .gpkg
// Parseia a geometria de limite da UT, reprojeta para SIRGAS 2000 (4674)
// via PostGIS e devolve { geojson: {...Polygon|MultiPolygon...}, srid: 4674 }.
// ------------------------------------------------------------------ //
router.post(
  "/arquivo/parse",
  uploadMemory.single("arquivo"),
  async (req, res) => {
    if (!req.file)
      return res.status(400).json({ erro: "Campo 'arquivo' ausente" });

    try {
      const { features, srid } = await parseGeomFile(
        req.file.buffer,
        req.file.originalname,
      );

      console.log(`[arquivo/parse] ${features.length} feição(ões) detectadas, SRID=${srid}`);

      // Reprojetar cada feição para SIRGAS 2000 (4674) via PostGIS.
      // SRIDs 4674 e 4326 são geograficamente equivalentes — apenas força 2D.
      const EQUIV_SRID = new Set([4674, 4326]);
      const needsReproj = !EQUIV_SRID.has(srid);

      const reprojected = await Promise.all(
        features.map(async (feat, i) => {
          try {
            const geomStr = JSON.stringify(feat.geojson);
            let finalGeom;

            if (needsReproj) {
              const { rows } = await edgvPool.query(
                `SELECT ST_AsGeoJSON(
                   ST_Force2D(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1::text), $2::int), 4674))
                 )::text AS geom`,
                [geomStr, srid],
              );
              finalGeom = JSON.parse(rows[0].geom);
            } else {
              // Já em 4674/4326 — apenas remove Z se houver
              const { rows } = await edgvPool.query(
                `SELECT ST_AsGeoJSON(ST_Force2D(ST_GeomFromGeoJSON($1::text)))::text AS geom`,
                [geomStr],
              );
              finalGeom = JSON.parse(rows[0].geom);
            }

            return { geojson: finalGeom, properties: feat.properties || {}, index: i };
          } catch (e) {
            // Fallback: devolve a geometria original sem reprojetar
            console.warn(`[arquivo/parse] reprojeção falhou para feição ${i}: ${e.message.split('\n')[0]}`);
            return { geojson: feat.geojson, properties: feat.properties || {}, index: i };
          }
        }),
      );

      res.json({
        features: reprojected,
        count:    reprojected.length,
        srid:     4674,
        geojson:  reprojected.length === 1 ? reprojected[0].geojson : null,
      });
    } catch (err) {
      console.error("[arquivo/parse]", err.message);
      res.status(422).json({ erro: err.message });
    }
  },
);

// Utilitário: resolve extraData a partir de um token (ou retorna {})
function resolveExtraData(body) {
  const token = body?.curva_nivel_token;
  if (!token) return {};
  const entry = curvaNivelStore.get(token);
  if (!entry) return {};
  return { curva_nivel_geojson: entry.geojson, curva_nivel_srid: entry.srid };
}

// ------------------------------------------------------------------ //
// POST /api/calcular
//
// Body opção 1 — UT do SAP (subfase vem automática):
//   { "ut_id": 42 }
//   { "ut_id": 42, "subfase_key": "ext_vias_deslocamento" }  ← override
//
// Body opção 2 — geometria desenhada/carregada + subfase obrigatória:
//   { "geojson": {...}, "subfase_key": "ext_hidrografia_altimetria" }
//
// Opcional: { "curva_nivel_token": "<uuid>" }  — usa curva de nível externa
// ------------------------------------------------------------------ //
router.post("/calcular", async (req, res) => {
  try {
    let geomWKT;
    let subfaseKey = req.body.subfase_key || null;
    let denominadorEscala = req.body.denominador_escala || null;
    let lpNome = null;

    if (req.body.ut_id) {
      const { rows } = await sapPool.query(
        `SELECT ST_AsEWKT(ST_Force2D(ST_Transform(ut.geom, 4674))) AS wkt,
                ut.subfase_id, l.denominador_escala, lp.nome AS lp_nome
         FROM macrocontrole.unidade_trabalho ut
         LEFT JOIN macrocontrole.lote    l  ON l.id  = ut.lote_id
         LEFT JOIN macrocontrole.subfase sf ON sf.id = ut.subfase_id
         LEFT JOIN macrocontrole.fase    fa ON fa.id = sf.fase_id
         LEFT JOIN macrocontrole.linha_producao lp ON lp.id = fa.linha_producao_id
         WHERE ut.id = $1`,
        [req.body.ut_id],
      );
      if (!rows.length)
        return res.status(404).json({ erro: "UT não encontrada no SAP" });

      geomWKT           = rows[0].wkt;
      denominadorEscala = denominadorEscala ?? rows[0].denominador_escala;
      lpNome            = rows[0].lp_nome;
      if (!subfaseKey) subfaseKey = sapIdToKey(rows[0].subfase_id);
      // Mapping não encontrou a subfase — erro explícito em vez de calcular tudo
      if (!subfaseKey) {
        return res.status(400).json({
          erro: `Subfase do SAP (id=${rows[0].subfase_id}) não mapeada. ` +
                `Verifique GET /api/sap-mapping ou selecione a subfase manualmente.`,
        });
      }
    } else if (req.body.geojson_list) {
      // Múltiplas feições do arquivo — une no servidor com ST_Union
      if (!subfaseKey)
        return res.status(400).json({ erro: "Informe subfase_key ao usar geojson_list" });
      const list = req.body.geojson_list;
      if (!Array.isArray(list) || !list.length)
        return res.status(400).json({ erro: "geojson_list deve ser array não-vazio" });
      const geomJsonArray = list.map(g => JSON.stringify(g));
      const { rows } = await edgvPool.query(
        `SELECT ST_AsEWKT(ST_Force2D(ST_Union(ARRAY(
           SELECT ST_SetSRID(ST_GeomFromGeoJSON(g::text), 4674)
           FROM unnest($1::text[]) AS g
         )))) AS wkt`,
        [geomJsonArray],
      );
      geomWKT = rows[0].wkt;
    } else if (req.body.geojson) {
      if (!subfaseKey) {
        return res
          .status(400)
          .json({ erro: "Informe subfase_key ao usar geojson" });
      }
      const { rows } = await edgvPool.query(
        `SELECT ST_AsEWKT(ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4674)) AS wkt`,
        [JSON.stringify(req.body.geojson)],
      );
      geomWKT = rows[0].wkt;
    } else {
      return res.status(400).json({ erro: "Informe geojson, geojson_list ou ut_id no body" });
    }

    // LP detection: body override > SAP lp_nome > default Topo
    const lpKey = req.body.lp_key || detectLPKey(lpNome);

    const mapeamento = loadMapeamento(lpKey);
    if (subfaseKey && !mapeamento.subfases[subfaseKey]) {
      return res
        .status(400)
        .json({ erro: `Subfase desconhecida: ${subfaseKey}` });
    }

    const multEscala = calcMultEscala(denominadorEscala, lpKey);
    const extraData  = resolveExtraData(req.body);
    const score = await calculateScore(geomWKT, subfaseKey, multEscala, extraData, lpKey);
    res.json({
      ...score,
      subfase_key:        subfaseKey,
      denominador_escala: denominadorEscala,
      lp_nome:            lpNome,
      curva_nivel_usada:  !!extraData.curva_nivel_geojson,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: err.message });
  }
});

// ------------------------------------------------------------------ //
// POST /api/calcular/lote
//
// Body: { ut_ids: [1,2,...], subfase_key?: "..." }
// Returns: { resultados: [...sorted desc], erros: [...] }
// ------------------------------------------------------------------ //
router.post("/calcular/lote", async (req, res) => {
  const { ut_ids, subfase_key } = req.body;
  if (!Array.isArray(ut_ids) || !ut_ids.length) {
    return res.status(400).json({ erro: "ut_ids deve ser um array não-vazio" });
  }
  const extraData = resolveExtraData(req.body);

  // Streaming NDJSON — cada linha é um objeto JSON (tipo: "inicio" | "ut" | "fim")
  // Permite ao frontend atualizar a barra de progresso UT a UT.
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Transfer-Encoding", "chunked");
  const emit = (obj) => res.write(JSON.stringify(obj) + "\n");

  try {
    const { rows } = await sapPool.query(
      `
      SELECT ut.id, ut.nome, ut.subfase_id,
             ST_AsEWKT(ST_Force2D(ST_Transform(ut.geom, 4674))) AS wkt,
             ST_AsGeoJSON(ut.geom)::json                        AS geom,
             l.denominador_escala,
             lp.nome AS lp_nome
      FROM macrocontrole.unidade_trabalho ut
      LEFT JOIN macrocontrole.lote    l  ON l.id  = ut.lote_id
      LEFT JOIN macrocontrole.subfase sf ON sf.id = ut.subfase_id
      LEFT JOIN macrocontrole.fase    fa ON fa.id = sf.fase_id
      LEFT JOIN macrocontrole.linha_producao lp ON lp.id = fa.linha_producao_id
      WHERE ut.id = ANY($1::int[])
    `,
      [ut_ids],
    );

    emit({ tipo: "inicio", total: rows.length });

    const CHUNK = 5;
    const resultados = [];
    const erros      = [];

    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const chunkRes = await Promise.all(
        chunk.map(async (r) => {
          const sfKey = subfase_key || sapIdToKey(r.subfase_id);
          if (!sfKey)
            return {
              ut_id: r.id,
              nome:  r.nome,
              geom:  r.geom,
              erro:  `subfase id=${r.subfase_id} não mapeada — consulte /api/sap-mapping/status`,
            };
          try {
            const lpKey      = req.body.lp_key || detectLPKey(r.lp_nome);
            const multEscala = calcMultEscala(r.denominador_escala, lpKey);
            const score = await calculateScore(r.wkt, sfKey, multEscala, extraData, lpKey);
            return { ut_id: r.id, nome: r.nome, geom: r.geom, subfase_key: sfKey, denominador_escala: r.denominador_escala, lp_nome: r.lp_nome, ...score };
          } catch (e) {
            return { ut_id: r.id, nome: r.nome, geom: r.geom, erro: e.message };
          }
        }),
      );

      for (const item of chunkRes) {
        if (item.erro) erros.push(item); else resultados.push(item);
        emit({ tipo: "ut", ...item }); // progresso UT a UT
      }
    }

    const sorted = resultados.sort((a, b) => b.score_total - a.score_total);
    emit({ tipo: "fim", resultados: sorted, erros });
    res.end();
  } catch (err) {
    console.error(err);
    emit({ tipo: "erro", erro: err.message });
    res.end();
  }
});

// ------------------------------------------------------------------ //
// POST /api/calcular/lote/agregado
//
// Body: { lote_id: 5, subfase_key?: "..." }
// Returns: { lote, subfase, uts: [{id, nome, pontos_subfase, pontos_vf, score_total, geom}, ...],
//            total_pontos, num_uts }
// ------------------------------------------------------------------ //
router.post("/calcular/lote/agregado", async (req, res) => {
  const { lote_id, subfase_key } = req.body;
  if (!lote_id) {
    return res.status(400).json({ erro: "lote_id obrigatório" });
  }
  const extraData = resolveExtraData(req.body);
  try {
    // Buscar UTs do lote
    const { rows: utRows } = await sapPool.query(
      `
      SELECT ut.id, ut.nome, ut.subfase_id,
             ST_AsEWKT(ST_Force2D(ST_Transform(ut.geom, 4674))) AS wkt,
             ST_AsGeoJSON(ut.geom)::json                        AS geom,
             l.nome AS lote_nome,
             l.denominador_escala,
             lp.nome AS lp_nome,
             sf.nome AS subfase_nome
      FROM macrocontrole.unidade_trabalho ut
      LEFT JOIN macrocontrole.lote    l  ON l.id  = ut.lote_id
      LEFT JOIN macrocontrole.subfase sf ON sf.id = ut.subfase_id
      LEFT JOIN macrocontrole.fase    fa ON fa.id = sf.fase_id
      LEFT JOIN macrocontrole.linha_producao lp ON lp.id = fa.linha_producao_id
      WHERE ut.lote_id = $1
      ORDER BY ut.nome
    `,
      [lote_id],
    );

    if (!utRows.length) {
      return res.status(404).json({ erro: "Nenhuma UT encontrada neste lote" });
    }

    const loteName = utRows[0].lote_nome || "Lote desconhecido";
    const lpNomeLote = utRows[0].lp_nome || null;
    // LP key: body override > lote's LP name
    const lpKeyLote = req.body.lp_key || detectLPKey(lpNomeLote);
    const results = [];

    const CHUNK = 5;
    for (let i = 0; i < utRows.length; i += CHUNK) {
      const chunk = utRows.slice(i, i + CHUNK);
      const chunkRes = await Promise.all(
        chunk.map(async (r) => {
          const sfKey = subfase_key || sapIdToKey(r.subfase_id);
          if (!sfKey)
            return {
              ut_id: r.id,
              nome:  r.nome,
              geom:  r.geom,
              erro:  `subfase id=${r.subfase_id} não mapeada — consulte /api/sap-mapping/status`,
            };
          try {
            const multEscala = calcMultEscala(r.denominador_escala, lpKeyLote);
            const score = await calculateScore(r.wkt, sfKey, multEscala, extraData, lpKeyLote);
            return {
              ut_id: r.id,
              nome: r.nome,
              geom: r.geom,
              subfase_key: sfKey,
              subfase_nome: r.subfase_nome,
              denominador_escala: r.denominador_escala,
              ...score,
            };
          } catch (e) {
            return { ut_id: r.id, nome: r.nome, geom: r.geom, erro: e.message };
          }
        }),
      );
      results.push(...chunkRes);
    }

    const uts = results.filter((r) => !r.erro);
    const totalPontos = uts.reduce((sum, ut) => sum + ut.score_total, 0);

    res.json({
      lote: { id: lote_id, nome: loteName },
      subfase_key:   subfase_key || null,
      lp_nome:       lpNomeLote,
      lp_mapeamento: lpKeyLote,
      uts: uts.map((ut) => ({
        id:             ut.ut_id,
        nome:           ut.nome,
        subfase_key:    ut.subfase_key,
        pontos_subfase: Object.entries(ut.por_subfase || {})
          .filter(([k]) => k !== 'verificacao_final')
          .reduce((s, [, v]) => s + v, 0),
        pontos_vf:      ut.por_subfase?.verificacao_final || 0,
        score_total:    ut.score_total,
        geom:           ut.geom,
      })),
      total_pontos: totalPontos,
      num_uts: uts.length,
      erros: results.filter((r) => r.erro),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: err.message });
  }
});

// ------------------------------------------------------------------ //
// GET /api/health/edgv
//
// Verifica quais tabelas do mapeamento_camadas.json existem no banco
// EDGV ativo e retorna { tabela, existe, n_feicoes }[].
// ------------------------------------------------------------------ //
router.get("/health/edgv", async (req, res) => {
  const mapeamento = loadMapeamento();
  const tabelasSet = new Set();
  for (const sub of Object.values(mapeamento.subfases)) {
    for (const c of (sub.camadas || [])) {
      tabelasSet.add(c.tabela);
      if (c.join) tabelasSet.add(c.join);
      if (Array.isArray(c.tabelas_uniao)) c.tabelas_uniao.forEach(t => tabelasSet.add(t));
    }
  }

  const tabelas = [...tabelasSet].sort();
  const resultados = await Promise.all(
    tabelas.map(async tabela => {
      try {
        const { rows } = await edgvPool.query(
          `SELECT COUNT(*)::int AS n FROM edgv.${tabela}`
        );
        return { tabela, existe: true, n_feicoes: rows[0].n };
      } catch {
        return { tabela, existe: false, n_feicoes: 0 };
      }
    })
  );

  const faltando = resultados.filter(r => !r.existe).length;
  res.json({
    banco:   getEdgvDb(),
    tabelas: resultados,
    resumo:  { total: resultados.length, existentes: resultados.length - faltando, faltando },
  });
});

// ------------------------------------------------------------------ //
// GET /api/notas/filtros — lotes, subfases e operadores com notas
// GET /api/notas          — atividades com nota no campo observacao
//
// Formato da nota no campo observacao: "8;Muito Bom"  (nota;descrição)
// Só exibe atividades onde observacao começa com dígito(s) seguido de ';'
// ------------------------------------------------------------------ //

// Cláusulas SQL para etapa de revisão / execução.
// buildEtapaClause(alias, tipo, usaDominio) gera a cláusula para qualquer alias.
function buildEtapaClause(alias, tipo, usaDominio) {
  if (tipo === 'revisao') {
    return usaDominio
      ? `${alias}.tipo_etapa_id IN (SELECT code FROM dominio.tipo_etapa WHERE nome ILIKE '%revis%')`
      : `${alias}.tipo_etapa_id != 1`;
  }
  // execucao
  return usaDominio
    ? `${alias}.tipo_etapa_id NOT IN (SELECT code FROM dominio.tipo_etapa WHERE nome ILIKE '%revis%')`
    : `${alias}.tipo_etapa_id = 1`;
}

// Cache: detecta em runtime se dominio.tipo_etapa tem linhas de revisão
let _usaDominio    = null;
let _revisaoClause = null;
async function getRevisaoClause() {
  if (_revisaoClause) return _revisaoClause;
  try {
    const { rows } = await sapPool.query(
      `SELECT code FROM dominio.tipo_etapa WHERE nome ILIKE '%revis%' LIMIT 1`
    );
    _usaDominio    = rows.length > 0;
    _revisaoClause = buildEtapaClause('e', 'revisao', _usaDominio);
  } catch {
    _usaDominio    = false;
    _revisaoClause = buildEtapaClause('e', 'revisao', false);
  }
  return _revisaoClause;
}

router.get("/notas/filtros", async (req, res) => {
  try {
    const { lote_id, lp_id } = req.query;
    await getRevisaoClause(); // garante que _usaDominio está populado

    // Apenas atividades FINALIZADAS (tipo_situacao_id = 4)
    // Sem restrição de tipo_etapa: Orto só tem execução, Topo tem revisão — queremos ambos
    const sfWhere  = ['a.tipo_situacao_id = 4'];
    const sfParams = [];
    if (lote_id) { sfParams.push(parseInt(lote_id)); sfWhere.push(`l.id = $${sfParams.length}`); }
    if (lp_id)   { sfParams.push(parseInt(lp_id));   sfWhere.push(`l.linha_producao_id = $${sfParams.length}`); }

    const usWhere  = ['a.tipo_situacao_id = 4'];
    const usParams = [];
    if (lote_id) { usParams.push(parseInt(lote_id)); usWhere.push(`l.id = $${usParams.length}`); }
    if (lp_id)   { usParams.push(parseInt(lp_id));   usWhere.push(`l.linha_producao_id = $${usParams.length}`); }

    const sfWhereSQL = `WHERE ${sfWhere.join(' AND ')}`;
    const usWhereSQL = `WHERE ${usWhere.join(' AND ')}`;
    const lotesSQL   = lp_id
      ? `SELECT id, nome, linha_producao_id FROM macrocontrole.lote WHERE linha_producao_id = ${parseInt(lp_id)} ORDER BY nome`
      : `SELECT id, nome, linha_producao_id FROM macrocontrole.lote ORDER BY nome`;

    const [lps, lotes, subfases, usuarios] = await Promise.all([
      sapPool.query(`SELECT id, nome FROM macrocontrole.linha_producao ORDER BY nome`),
      sapPool.query(lotesSQL),
      sapPool.query(`
        SELECT DISTINCT sf.id, sf.nome
        FROM macrocontrole.subfase           sf
        JOIN macrocontrole.etapa             e  ON e.subfase_id = sf.id
        JOIN macrocontrole.atividade         a  ON a.etapa_id   = e.id
        JOIN macrocontrole.unidade_trabalho  ut ON ut.id = a.unidade_trabalho_id
        JOIN macrocontrole.lote              l  ON l.id  = ut.lote_id
        ${sfWhereSQL}
        ORDER BY sf.nome
      `, sfParams),
      sapPool.query(`
        SELECT DISTINCT u.id, COALESCE(u.nome, u.login, a.usuario_id::text) AS nome
        FROM dgeo.usuario                    u
        JOIN macrocontrole.atividade         a  ON a.usuario_id = u.id
        JOIN macrocontrole.etapa             e  ON e.id = a.etapa_id
        JOIN macrocontrole.unidade_trabalho  ut ON ut.id = a.unidade_trabalho_id
        JOIN macrocontrole.lote              l  ON l.id  = ut.lote_id
        ${usWhereSQL}
        ORDER BY 2
      `, usParams),
    ]);
    res.json({ lps: lps.rows, lotes: lotes.rows, subfases: subfases.rows, usuarios: usuarios.rows });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

router.get("/notas", async (req, res) => {
  try {
    const { lote_id, lp_id, subfase_id, usuario_id, nota_min, nota_max, data_ini, data_fim } = req.query;
    await getRevisaoClause(); // garante _usaDominio populado

    const params = [];
    // Apenas atividades FINALIZADAS; sem restrição de tipo_etapa
    const where = ['a.tipo_situacao_id = 4'];

    if (lote_id)   { params.push(parseInt(lote_id));    where.push(`l.id = $${params.length}`); }
    if (lp_id)     { params.push(parseInt(lp_id));      where.push(`l.linha_producao_id = $${params.length}`); }
    if (subfase_id){ params.push(parseInt(subfase_id)); where.push(`sf.id = $${params.length}`); }
    // usuario_id filtra pelo OPERADOR que aparece na atividade (quem fez ou recebeu)
    if (usuario_id){ params.push(parseInt(usuario_id));
      where.push(`(
        a.usuario_id = $${params.length}
        OR EXISTS (
          SELECT 1 FROM macrocontrole.atividade a2
          JOIN macrocontrole.etapa e2 ON e2.id = a2.etapa_id
          WHERE a2.unidade_trabalho_id = a.unidade_trabalho_id
            AND e2.subfase_id = e.subfase_id
            AND e2.tipo_etapa_id = 1
            AND a2.usuario_id = $${params.length}
        )
      )`); }
    if (nota_min)  { params.push(parseInt(nota_min));
      where.push(`(a.observacao ~ '^[0-9]+;' AND (SPLIT_PART(a.observacao,';',1))::int >= $${params.length})`); }
    if (nota_max)  { params.push(parseInt(nota_max));
      where.push(`(a.observacao ~ '^[0-9]+;' AND (SPLIT_PART(a.observacao,';',1))::int <= $${params.length})`); }
    if (data_ini)  { params.push(data_ini); where.push(`a.data_fim >= $${params.length}::date`); }
    if (data_fim)  { params.push(data_fim); where.push(`a.data_fim <  ($${params.length}::date + interval '1 day')`); }

    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const sql = `
      SELECT
        a.id                                                           AS atividade_id,
        ut.nome                                                        AS ut_nome,
        l.nome                                                         AS lote_nome,
        lp.nome                                                        AS lp_nome,
        sf.nome                                                        AS subfase_nome,
        e.tipo_etapa_id,
        -- Para execução (tipo=1): operador = próprio usuário, revisor = NULL
        -- Para revisão  (tipo>1): operador = LATERAL (executor), revisor = próprio usuário
        CASE WHEN e.tipo_etapa_id = 1
          THEN COALESCE(u.nome, u.login, a.usuario_id::text)
          ELSE exec_act.operador_nome
        END                                                            AS operador_nome,
        CASE WHEN e.tipo_etapa_id != 1
          THEN COALESCE(u.nome, u.login, a.usuario_id::text)
          ELSE NULL
        END                                                            AS revisor_nome,
        CASE WHEN a.observacao ~ '^[0-9]+;'
          THEN (SPLIT_PART(a.observacao, ';', 1))::int
          ELSE NULL
        END                                                            AS nota,
        CASE WHEN a.observacao ~ '^[0-9]+;'
          THEN TRIM(SPLIT_PART(a.observacao, ';', 2))
          ELSE a.observacao
        END                                                            AS nota_descricao,
        COALESCE(a.observacao ~ '^[0-9]+;', false)                    AS nota_valida,
        a.observacao                                                   AS observacao_raw,
        a.tipo_situacao_id,
        a.data_inicio,
        a.data_fim
      FROM macrocontrole.atividade         a
      JOIN macrocontrole.etapa             e  ON e.id  = a.etapa_id
      JOIN macrocontrole.subfase           sf ON sf.id = e.subfase_id
      JOIN macrocontrole.unidade_trabalho  ut ON ut.id = a.unidade_trabalho_id
      JOIN macrocontrole.lote              l  ON l.id  = ut.lote_id
      LEFT JOIN macrocontrole.linha_producao lp ON lp.id = l.linha_producao_id
      LEFT JOIN dgeo.usuario               u  ON u.id  = a.usuario_id
      -- Busca o executor: última atividade de execução (tipo=1) na mesma UT e subfase
      LEFT JOIN LATERAL (
        SELECT COALESCE(u2.nome, u2.login, a2.usuario_id::text) AS operador_nome
        FROM macrocontrole.atividade a2
        JOIN macrocontrole.etapa     e2 ON e2.id = a2.etapa_id
        LEFT JOIN dgeo.usuario       u2 ON u2.id = a2.usuario_id
        WHERE a2.unidade_trabalho_id = a.unidade_trabalho_id
          AND e2.subfase_id          = e.subfase_id
          AND e2.tipo_etapa_id       = 1
        ORDER BY a2.data_fim DESC NULLS LAST
        LIMIT 1
      ) exec_act ON true
      ${whereSQL}
      ORDER BY nota_valida ASC, a.data_fim DESC NULLS LAST
      LIMIT 3000
    `;
    const { rows } = await sapPool.query(sql, params);
    res.json({ rows, total: rows.length });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── Nomes amigáveis de LP por chave de mapeamento ─────────────────────────
const LP_NOMES_AMIGAVEIS = {
  'mapeamento_topo': 'EDGV 3.0 Topo 1.4',
  'mapeamento_orto': 'EDGV 3.0 Carta Orto',
};

// ── Calculadora MI: todas as subfases, modo SAP (ut_ids) ou Arquivo (geom_geojson) ──
router.post("/calcular/mi", async (req, res) => {
  try {
    const { ut_ids, lp_keys, denominador_escala, curva_nivel_token, geom_geojson } = req.body;

    let geomWKT, areaKm2, denomEscala, lpKeysToCalc, utInfoList = [], geomForMap;

    // ── Modo Arquivo: geometria fornecida diretamente como array de GeoJSON ──
    if (geom_geojson) {
      const geoms = Array.isArray(geom_geojson) ? geom_geojson : [geom_geojson];
      if (!geoms.length)
        return res.status(400).json({ erro: "geom_geojson não pode ser vazio." });

      denomEscala = denominador_escala || 25000;

      // Converter array de geometrias GeoJSON → WKT union via PostGIS
      const geomJsonArr = JSON.stringify(geoms);
      const { rows: wktRows } = await edgvPool.query(`
        SELECT
          ST_AsText(ST_Union(g.geom))                                         AS wkt,
          ROUND((ST_Area(ST_Union(g.geom)::geography) / 1e6)::numeric, 1)     AS area_km2,
          ST_AsGeoJSON(ST_Transform(ST_Union(g.geom), 4326))::json            AS geojson
        FROM (
          SELECT ST_Force2D(ST_GeomFromGeoJSON(elem::text)) AS geom
          FROM json_array_elements($1::json) elem
        ) g
      `, [geomJsonArr]);

      geomWKT    = wktRows[0]?.wkt;
      areaKm2    = wktRows[0]?.area_km2 || null;
      geomForMap = wktRows[0]?.geojson  || null;

      if (!geomWKT)
        return res.status(400).json({ erro: "Geometria inválida ou nula." });

      // LP keys: sempre ambas por padrão
      lpKeysToCalc = Array.isArray(lp_keys) && lp_keys.length > 0
        ? [...new Set(lp_keys)]
        : ['mapeamento_topo', 'mapeamento_orto'];

    // ── Modo SAP: ut_ids ──────────────────────────────────────────────────────
    } else {
      if (!Array.isArray(ut_ids) || ut_ids.length === 0)
        return res.status(400).json({ erro: "Forneça ut_ids (array) ou geom_geojson." });

      const ids = ut_ids.map(Number).filter(n => !isNaN(n));

      // 1. Metadados e geometria das UTs no SAP
      const { rows: utRows } = await sapPool.query(`
        SELECT
          ut.id, ut.nome,
          COALESCE(${ denominador_escala ? '$1::int' : 'l.denominador_escala' }, 25000) AS denom_escala,
          lp.nome AS lp_nome
        FROM macrocontrole.unidade_trabalho ut
        LEFT JOIN macrocontrole.lote          l  ON l.id  = ut.lote_id
        LEFT JOIN macrocontrole.linha_producao lp ON lp.id = l.linha_producao_id
        WHERE ut.id = ANY(${ denominador_escala ? '$2' : '$1' }::int[])
      `, denominador_escala ? [denominador_escala, ids] : [ids]);

      if (utRows.length === 0)
        return res.status(404).json({ erro: "Nenhuma UT encontrada para os IDs fornecidos." });

      // 2. Geometria unificada
      const { rows: geomRows } = await sapPool.query(`
        SELECT ST_AsText(ST_Union(ST_Transform(geom, 4674))) AS wkt_union
        FROM macrocontrole.unidade_trabalho WHERE id = ANY($1::int[])
      `, [ids]);
      geomWKT = geomRows[0]?.wkt_union;
      if (!geomWKT) return res.status(400).json({ erro: "Geometria das UTs inválida ou nula." });

      // Área e GeoJSON para mapa
      const { rows: metaRows } = await sapPool.query(`
        SELECT
          ROUND((ST_Area(ST_Union(ST_Transform(geom, 4674))::geography) / 1e6)::numeric, 1) AS area_km2,
          ST_AsGeoJSON(ST_Union(ST_Transform(geom, 4326)))::json AS geojson
        FROM macrocontrole.unidade_trabalho WHERE id = ANY($1::int[])
      `, [ids]);
      areaKm2    = metaRows[0]?.area_km2 || null;
      geomForMap = metaRows[0]?.geojson  || null;

      utInfoList   = utRows;
      denomEscala  = denominador_escala || utRows[0].denom_escala || 25000;

      // LP keys: explícito ou detectado das UTs
      lpKeysToCalc = Array.isArray(lp_keys) && lp_keys.length > 0
        ? [...new Set(lp_keys)]
        : [...new Set(utRows.map(r => detectLPKey(r.lp_nome)))];
    }

    // ── Cálculo comum ─────────────────────────────────────────────────────────
    const multEscala = calcMultEscala(denomEscala, lpKeysToCalc[0]);
    const extraData  = curva_nivel_token ? { curva_nivel_token } : {};

    const lpResults = await Promise.all(
      lpKeysToCalc.map(async lpKey => {
        // Nome amigável: da LP do SAP, ou fallback pelo mapeamento
        let lpNome = LP_NOMES_AMIGAVEIS[lpKey] || lpKey;
        const utComLp = utInfoList.find(r => detectLPKey(r.lp_nome) === lpKey);
        if (utComLp?.lp_nome) lpNome = utComLp.lp_nome;

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout 120s para LP ${lpKey}`)), 120_000)
        );
        const result = await Promise.race([
          calculateAllSubfases(geomWKT, multEscala, lpKey, extraData),
          timeoutPromise,
        ]);

        return { key: lpKey, nome: lpNome, total: result.total, subfases: result.subfases };
      })
    );

    res.json({
      uts:         utInfoList.map(r => ({ id: r.id, nome: r.nome, lp_nome: r.lp_nome })),
      escala:      denomEscala,
      mult_escala: multEscala,
      area_km2:    areaKm2,
      geom:        geomForMap,
      lps:         lpResults,
    });
  } catch (e) {
    console.error("[calcular/mi]", e);
    res.status(500).json({ erro: e.message });
  }
});

// ── Refinamento MI: recalcula UMA subfase com banco EDGV diferente ──────────
// POST /api/calcular/mi/refine
// Body: { subfase_key, lp_key, banco, ut_ids | geom_geojson, denominador_escala? }
// O banco EDGV é trocado temporariamente só durante este cálculo.
router.post("/calcular/mi/refine", async (req, res) => {
  try {
    const { subfase_key, lp_key, banco, ut_ids, geom_geojson, denominador_escala } = req.body;

    if (!subfase_key) return res.status(400).json({ erro: "subfase_key é obrigatório" });
    if (!lp_key)      return res.status(400).json({ erro: "lp_key é obrigatório" });
    if (!banco)       return res.status(400).json({ erro: "banco é obrigatório" });

    // ── Resolve geometria e escala (mesmo padrão do /calcular/mi) ──────────────
    let geomWKT, denomEscala;

    if (geom_geojson) {
      const geoms = Array.isArray(geom_geojson) ? geom_geojson : [geom_geojson];
      const { rows } = await edgvPool.query(`
        SELECT ST_AsText(ST_Union(g.geom)) AS wkt
        FROM (
          SELECT ST_Force2D(ST_GeomFromGeoJSON(elem::text)) AS geom
          FROM json_array_elements($1::json) elem
        ) g
      `, [JSON.stringify(geoms)]);
      geomWKT     = rows[0]?.wkt;
      denomEscala = denominador_escala || 25000;

    } else if (Array.isArray(ut_ids) && ut_ids.length > 0) {
      const ids = ut_ids.map(Number).filter(n => !isNaN(n));
      const { rows } = await sapPool.query(`
        SELECT
          ST_AsText(ST_Union(ST_Transform(ut.geom, 4674))) AS wkt,
          MAX(l.denominador_escala)                        AS denom_escala
        FROM macrocontrole.unidade_trabalho ut
        LEFT JOIN macrocontrole.lote l ON l.id = ut.lote_id
        WHERE ut.id = ANY($1::int[])
      `, [ids]);
      geomWKT     = rows[0]?.wkt;
      denomEscala = denominador_escala || rows[0]?.denom_escala || 25000;

    } else {
      return res.status(400).json({ erro: "Forneça ut_ids ou geom_geojson." });
    }

    if (!geomWKT) return res.status(400).json({ erro: "Geometria inválida ou nula." });

    const multEscala = calcMultEscala(denomEscala, lp_key);
    const extraData  = resolveExtraData(req.body);

    // ── Troca temporária do banco EDGV ────────────────────────────────────────
    const bancoOriginal = getEdgvDb();
    let resultado;
    try {
      if (banco !== bancoOriginal) setEdgvDb(banco);
      resultado = await calculateScore(geomWKT, subfase_key, multEscala, extraData, lp_key);
    } finally {
      if (banco !== bancoOriginal) setEdgvDb(bancoOriginal);
    }

    res.json({
      subfase_key,
      lp_key,
      banco,
      pts:        resultado.score_total,
      por_camada: (resultado.por_camada || []).filter(d => d.subfase === subfase_key),
      avisos:     resultado.avisos_query || [],
    });

  } catch (e) {
    console.error("[calcular/mi/refine]", e.message);
    res.status(500).json({ erro: e.message });
  }
});

// ── Diagnóstico do banco OSM ──────────────────────────────────────────────────
router.get("/health/osm", async (req, res) => {
  try {
    // Testa conexão
    await osmPool.query('SELECT 1');

    // Lista schemas disponíveis
    const { rows: schemas } = await osmPool.query(
      `SELECT schema_name FROM information_schema.schemata ORDER BY schema_name`
    );

    // Busca infra_via_deslocamento_l em qualquer schema
    const { rows: tabelas } = await osmPool.query(`
      SELECT table_schema, table_name,
             (SELECT COUNT(*) FROM information_schema.columns
              WHERE table_schema = t.table_schema AND table_name = t.table_name) AS n_colunas
      FROM information_schema.tables t
      WHERE table_name LIKE '%via%deslocamento%' OR table_name LIKE '%infra_via%'
      ORDER BY table_schema, table_name
    `);

    res.json({
      banco:   process.env.OSM_DB || 'insumos_osm',
      ok:      true,
      schemas: schemas.map(r => r.schema_name),
      tabelas_via: tabelas,
    });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

module.exports = router;
