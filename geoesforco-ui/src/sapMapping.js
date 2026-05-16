/**
 * Mapeamento automático de subfases SAP → chaves internas.
 *
 * Em vez de IDs hard-coded no JSON, usa padrões de nome (sap_nome_contains)
 * definidos em mapeamento_topo.json para detectar automaticamente os IDs
 * do banco SAP em tempo de execução.
 *
 * Uso:
 *   const sm = require('./sapMapping');
 *   await sm.buildMapping(sapPool);   // uma vez na inicialização
 *   sm.sapIdToKey(7)                  // → 'ext_vias_deslocamento'
 *   sm.getSapIds('ext_ferrovia')      // → [4, 23]
 */

const fs   = require('fs');
const path = require('path');

const MAPEAMENTO_PATH = path.join(__dirname, '../../calculadora_pontos/mapeamento_topo.json');

function loadMapeamento() {
  return JSON.parse(fs.readFileSync(MAPEAMENTO_PATH, 'utf8'));
}

// Extrai mensagem legível de erros (incluindo AggregateError do node-postgres)
function errMsg(e) {
  if (e?.message) return e.message;
  if (e?.errors?.[0]?.message) return e.errors[0].message;
  return e?.code || String(e);
}

// Normaliza string: minúsculas + remove acentos + colapsa espaços
function norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // remove combining diacritical marks
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Cache em memória ────────────────────────────────────────────────────────
let _idToKey  = new Map();  // sapId (number) → subfaseKey (string)
let _keyToIds = {};         // subfaseKey → number[]
let _sapRows  = [];         // rows brutos de macrocontrole.subfase
let _built    = false;

// ── Build ───────────────────────────────────────────────────────────────────

async function buildMapping(sapPool) {
  const mapeamento = loadMapeamento();

  // Tenta buscar subfases com linha_producao_id via JOIN em macrocontrole.fase.
  // Se a coluna não existir nessa tabela, usa fallback simples sem esse campo.
  let rows;
  try {
    const r = await sapPool.query(`
      SELECT sf.id, sf.nome, f.linha_producao_id
      FROM macrocontrole.subfase sf
      JOIN macrocontrole.fase    f ON f.id = sf.fase_id
      ORDER BY sf.id
    `);
    rows = r.rows;
    console.log(`[sap-mapping] ${rows.length} subfases encontradas no SAP (com linha_producao_id via fase)`);
  } catch (e) {
    console.warn(`[sap-mapping] fallback — query com fase.linha_producao_id falhou: ${errMsg(e)}`);
    // Fallback 1: tenta sem JOIN em fase (subfase pode ter lp_id diretamente)
    try {
      const r = await sapPool.query(`
        SELECT sf.id, sf.nome,
               COALESCE(sf.linha_producao_id, NULL) AS linha_producao_id
        FROM macrocontrole.subfase sf
        ORDER BY sf.id
      `);
      rows = r.rows;
      console.log(`[sap-mapping] ${rows.length} subfases encontradas (fallback com sf.linha_producao_id)`);
    } catch (e2) {
      // Fallback 2: query mínima, sem linha_producao_id
      console.warn(`[sap-mapping] fallback2 — sem linha_producao_id: ${errMsg(e2)}`);
      try {
        const r = await sapPool.query(`
          SELECT id, nome, NULL::int AS linha_producao_id
          FROM macrocontrole.subfase
          ORDER BY id
        `);
        rows = r.rows;
        console.log(`[sap-mapping] ${rows.length} subfases encontradas (fallback mínimo)`);
      } catch (e3) {
        console.error(`[sap-mapping] erro fatal ao listar subfases (SAP offline?): ${errMsg(e3)}`);
        return getFullMapping();
      }
    }
  }

  _sapRows = rows;

  // Log dos nomes encontrados para diagnóstico
  console.log(`[sap-mapping] subfases no SAP: ${rows.map(r => `${r.id}:"${r.nome}"`).join(', ')}`);

  const newIdToKey  = new Map();
  const newKeyToIds = {};

  for (const sapSf of rows) {
    const normSap = norm(sapSf.nome);
    let bestKey   = null;
    let bestScore = 0;

    for (const [key, sub] of Object.entries(mapeamento.subfases)) {
      for (const pat of (sub.sap_nome_contains || [])) {
        const normPat = norm(pat);
        if (normSap.includes(normPat)) {
          const score = normPat.length;  // padrão mais longo = mais específico
          if (score > bestScore) {
            bestScore = score;
            bestKey   = key;
          }
        }
      }
    }

    if (bestKey) {
      newIdToKey.set(sapSf.id, bestKey);
      (newKeyToIds[bestKey] = newKeyToIds[bestKey] || []).push(sapSf.id);
    }
  }

  _idToKey  = newIdToKey;
  _keyToIds = newKeyToIds;
  _built    = true;

  const nIds  = newIdToKey.size;
  const nKeys = Object.keys(newKeyToIds).length;
  console.log(`[sap-mapping] ${nIds} subfases SAP mapeadas para ${nKeys} chaves`);

  if (rows.length - nIds > 0) {
    const naoMapeadas = rows.filter(r => !newIdToKey.has(r.id)).map(r => `${r.id}:${r.nome}`);
    console.log(`[sap-mapping] ${naoMapeadas.length} subfases sem mapeamento: ${naoMapeadas.join(', ')}`);
  }

  return getFullMapping();
}

// ── Lookups ─────────────────────────────────────────────────────────────────

function sapIdToKey(id) {
  return _idToKey.get(Number(id)) ?? null;
}

function getSapIds(key) {
  return _keyToIds[key] ?? [];
}

function isBuilt() {
  return _built;
}

// ── Relatório completo (para endpoint /api/sap-mapping) ─────────────────────

function getFullMapping() {
  const mapeamento = loadMapeamento();
  const mapeado    = {};

  for (const [key, sub] of Object.entries(mapeamento.subfases)) {
    const ids = _keyToIds[key] || [];
    mapeado[key] = {
      nome:         sub.nome,
      sap_ids:      ids,
      subfases_sap: ids.map(id => {
        const row = _sapRows.find(r => r.id === id);
        return row
          ? { id: row.id, nome: row.nome, linha_producao_id: row.linha_producao_id }
          : { id };
      }),
    };
  }

  const nao_mapeado = _sapRows
    .filter(r => !_idToKey.has(r.id))
    .map(r => ({ id: r.id, nome: r.nome, linha_producao_id: r.linha_producao_id }));

  return { mapeado, nao_mapeado };
}

// ── Por linha de produção ────────────────────────────────────────────────────

/**
 * Retorna as subfaseKeys disponíveis para uma linha de produção.
 * Se lp_id for null/undefined, retorna todas as keys mapeadas.
 * Se não houver informação de LP nos dados (todos null), também retorna tudo.
 */
function getSubfaseKeysByLP(lp_id) {
  if (!lp_id) return Object.keys(_keyToIds);
  // Verifica se algum row tem linha_producao_id não-nulo
  const hasLpInfo = _sapRows.some(r => r.linha_producao_id != null);
  if (!hasLpInfo) {
    // Sem info de LP: retorna todas as keys mapeadas (não filtra por LP)
    return Object.keys(_keyToIds);
  }
  const keys = new Set();
  for (const row of _sapRows) {
    if (row.linha_producao_id === Number(lp_id)) {
      const key = _idToKey.get(row.id);
      if (key) keys.add(key);
    }
  }
  // Se não encontrou nenhuma key para esse LP, retorna tudo (fallback)
  return keys.size > 0 ? [...keys] : Object.keys(_keyToIds);
}

module.exports = { buildMapping, sapIdToKey, getSapIds, isBuilt, getFullMapping, getSubfaseKeysByLP };
