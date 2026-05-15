const { Pool } = require('pg');

const BASE = {
  host:                    process.env.PG_HOST     || 'localhost',
  port:                    parseInt(process.env.PG_PORT || '5432'),
  user:                    process.env.PG_USER     || 'postgres',
  password:                process.env.PG_PASSWORD || 'postgres',
  max:                     20,    // máximo de conexões simultâneas
  connectionTimeoutMillis: 5000,  // espera até 5 s para obter conexão do pool
  idleTimeoutMillis:       30000, // fecha conexões ociosas após 30 s
  query_timeout:           60000, // timeout padrão por query: 60 s
};

// Banco SAP — contém as UTs (macrocontrole.unidade_trabalho)
const sapPool = new Pool({ ...BASE, database: process.env.SAP_DB || 'sap' });

// Pool ativo para EDGV — trocável em runtime via setEdgvDb()
let _edgvDb   = process.env.EDGV_DB || 'insumos_oficiais';
let _edgvPool = new Pool({ ...BASE, database: _edgvDb });

// Pool de referência para dados estáticos (camadas de limite como llp_unidade_federacao_a).
// Sempre usa insumos_oficiais independentemente do banco EDGV ativo, pois alguns bancos
// (ex.: insumos_osm) podem não ter essas camadas populadas.
const refPool = new Pool({ ...BASE, database: process.env.REF_DB || 'insumos_oficiais' });

// Pool para o banco OSM — contém infra_via_deslocamento_l e outras camadas OSM-derivadas.
// Configurável via OSM_DB (padrão: insumos_osm).
const osmPool = new Pool({ ...BASE, database: process.env.OSM_DB || 'insumos_osm' });

function getEdgvDb()  { return _edgvDb; }
function getEdgvPool(){ return _edgvPool; }

function setEdgvDb(dbName) {
  if (dbName === _edgvDb) return;
  const old = _edgvPool;
  _edgvDb   = dbName;
  _edgvPool = new Pool({ ...BASE, database: dbName });
  old.end().catch(() => {});
}

// Proxy transparente — mantém compatibilidade com código existente
const edgvPool = new Proxy({}, {
  get(_, prop) { return _edgvPool[prop].bind(_edgvPool); },
});

module.exports = { sapPool, edgvPool, refPool, osmPool, getEdgvDb, getEdgvPool, setEdgvDb };
