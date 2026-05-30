-- Migration 002: tabela de resultados por UT para replay do ranking
-- Executar conectado ao banco 'geoesforco':
--   psql -h HOST -U postgres -d geoesforco -f 002_geoesforco_resultado_ut.sql

CREATE TABLE IF NOT EXISTS pontuacao.resultado_ut (
    id            BIGSERIAL PRIMARY KEY,
    ut_id         INTEGER,            -- ID da UT no SAP (null no modo arquivo)
    nome          TEXT NOT NULL,      -- nome/código da UT
    mi            TEXT,               -- código MI da aux_moldura_a (null se não encontrado)
    lp_key        TEXT NOT NULL,      -- mapeamento_topo | mapeamento_orto
    subfase_key   TEXT,               -- null = todas; ou chave da subfase específica
    escala        INTEGER,
    mult_escala   NUMERIC(10,4),
    score_total   NUMERIC(14,2),
    por_subfase   JSONB,              -- { subfase_key: pts, ... }
    por_camada    JSONB,              -- array detalhado por camada
    banco_edgv    TEXT,
    calculado_em  TIMESTAMPTZ DEFAULT now()
);

-- Unique parcial: só aplica quando temos ut_id (modo SAP)
CREATE UNIQUE INDEX IF NOT EXISTS resultado_ut_sap_unique
    ON pontuacao.resultado_ut (ut_id, lp_key)
    WHERE ut_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS resultado_ut_lp_idx     ON pontuacao.resultado_ut (lp_key);
CREATE INDEX IF NOT EXISTS resultado_ut_mi_idx     ON pontuacao.resultado_ut (mi);
CREATE INDEX IF NOT EXISTS resultado_ut_score_idx  ON pontuacao.resultado_ut (score_total DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS resultado_ut_calc_idx   ON pontuacao.resultado_ut (calculado_em DESC);
CREATE INDEX IF NOT EXISTS resultado_ut_nome_idx   ON pontuacao.resultado_ut (nome);
