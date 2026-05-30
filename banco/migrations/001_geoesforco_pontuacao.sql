-- Migration: cria banco geoesforco com schema pontuacao e tabelas por LP
-- Executar conectado ao banco 'geoesforco' após criá-lo com:
--   CREATE DATABASE geoesforco;
--   \c geoesforco
--   CREATE EXTENSION IF NOT EXISTS postgis;

CREATE SCHEMA IF NOT EXISTS pontuacao;

-- ── Tabela LP Topo (mapeamento_topo) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pontuacao.topo (
    id            BIGSERIAL PRIMARY KEY,
    mi            TEXT NOT NULL,
    geom          GEOMETRY(GEOMETRY, 4674),
    escala        INTEGER,
    mult_escala   NUMERIC(10,4),
    score_total   NUMERIC(14,2),
    por_subfase   JSONB,
    por_camada    JSONB,
    versao_pesos  TEXT,
    banco_edgv    TEXT,
    atualizado_em TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT topo_mi_unique UNIQUE (mi)
);

CREATE INDEX IF NOT EXISTS topo_geom_idx    ON pontuacao.topo USING GIST (geom);
CREATE INDEX IF NOT EXISTS topo_mi_idx      ON pontuacao.topo (mi);
CREATE INDEX IF NOT EXISTS topo_score_idx   ON pontuacao.topo (score_total DESC NULLS LAST);

-- ── Tabela LP Orto (mapeamento_orto) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pontuacao.orto (
    id            BIGSERIAL PRIMARY KEY,
    mi            TEXT NOT NULL,
    geom          GEOMETRY(GEOMETRY, 4674),
    escala        INTEGER,
    mult_escala   NUMERIC(10,4),
    score_total   NUMERIC(14,2),
    por_subfase   JSONB,
    por_camada    JSONB,
    versao_pesos  TEXT,
    banco_edgv    TEXT,
    atualizado_em TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT orto_mi_unique UNIQUE (mi)
);

CREATE INDEX IF NOT EXISTS orto_geom_idx    ON pontuacao.orto USING GIST (geom);
CREATE INDEX IF NOT EXISTS orto_mi_idx      ON pontuacao.orto (mi);
CREATE INDEX IF NOT EXISTS orto_score_idx   ON pontuacao.orto (score_total DESC NULLS LAST);
