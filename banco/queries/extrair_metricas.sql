-- ============================================================
-- SPRINT 1 — Extração de métricas por UT
-- Banco: 0734_1_2025_12_03_Andre | SRID: 4674 (SIRGAS 2000)
--
-- As UTs são passadas como polígonos via CTE _uts.
-- A calculadora.py cria _uts dividindo a moldura em 3 células.
-- ============================================================
-- Parâmetros via psycopg2 (substituídos pelo Python):
--   %(geoms_wkt)s → WKT das geometrias de UT como JSON array
-- A calculadora injeta as UTs diretamente via VALUES.
-- ============================================================

WITH _uts (ut_id, geom) AS (
  VALUES
    -- Substituído pela calculadora.py com os 3 polígonos reais
    -- Exemplo de placeholder (nunca executado diretamente):
    (1, ST_GeomFromText('POLYGON EMPTY', 4674))
),

-- ============================================================
-- SUBFASE 2 — Hidrografia e Altimetria
-- ============================================================
trecho_drenagem AS (
  SELECT ut.ut_id, 'elemnat_trecho_drenagem_l'::text AS camada, 'km'::text AS metrica,
    ROUND((SUM(ST_Length(ST_Intersection(f.geom, ut.geom)::geography)) / 1000)::numeric, 3) AS valor
  FROM _uts ut JOIN edgv.elemnat_trecho_drenagem_l f ON ST_Intersects(f.geom, ut.geom)
  GROUP BY ut.ut_id
),
curva_nivel AS (
  SELECT ut.ut_id, 'elemnat_curva_nivel_l'::text, 'km'::text,
    ROUND((SUM(ST_Length(ST_Intersection(f.geom, ut.geom)::geography)) / 1000)::numeric, 3)
  FROM _uts ut JOIN edgv.elemnat_curva_nivel_l f ON ST_Intersects(f.geom, ut.geom)
  GROUP BY ut.ut_id
),
ponto_cotado AS (
  SELECT ut.ut_id, 'elemnat_ponto_cotado_p'::text, 'qtd'::text,
    COUNT(*)::numeric
  FROM _uts ut JOIN edgv.elemnat_ponto_cotado_p f ON ST_Contains(ut.geom, f.geom)
  GROUP BY ut.ut_id
),

-- ============================================================
-- SUBFASE 3 — Topônimos
-- ============================================================
localidade AS (
  SELECT ut.ut_id, 'llp_localidade_p'::text, 'qtd'::text,
    COUNT(*)::numeric
  FROM _uts ut JOIN edgv.llp_localidade_p f ON ST_Contains(ut.geom, f.geom)
  GROUP BY ut.ut_id
),
toponimo_p AS (
  SELECT ut.ut_id, 'elemnat_toponimo_fisiografico_natural_p'::text, 'qtd'::text,
    COUNT(*)::numeric
  FROM _uts ut JOIN edgv.elemnat_toponimo_fisiografico_natural_p f ON ST_Contains(ut.geom, f.geom)
  GROUP BY ut.ut_id
),
toponimo_l AS (
  SELECT ut.ut_id, 'elemnat_toponimo_fisiografico_natural_l'::text, 'km'::text,
    ROUND((SUM(ST_Length(ST_Intersection(f.geom, ut.geom)::geography)) / 1000)::numeric, 3)
  FROM _uts ut JOIN edgv.elemnat_toponimo_fisiografico_natural_l f ON ST_Intersects(f.geom, ut.geom)
  GROUP BY ut.ut_id
),

-- ============================================================
-- SUBFASE 4 — Vias de Deslocamento
-- ============================================================
via_deslocamento AS (
  SELECT ut.ut_id, 'infra_via_deslocamento_l'::text, 'km'::text,
    ROUND((SUM(ST_Length(ST_Intersection(f.geom, ut.geom)::geography)) / 1000)::numeric, 3)
  FROM _uts ut JOIN edgv.infra_via_deslocamento_l f ON ST_Intersects(f.geom, ut.geom)
  GROUP BY ut.ut_id
),
elemento_viario AS (
  SELECT ut.ut_id, 'infra_elemento_viario_l'::text, 'km'::text,
    ROUND((SUM(ST_Length(ST_Intersection(f.geom, ut.geom)::geography)) / 1000)::numeric, 3)
  FROM _uts ut JOIN edgv.infra_elemento_viario_l f ON ST_Intersects(f.geom, ut.geom)
  GROUP BY ut.ut_id
),
mobilidade_urbana AS (
  SELECT ut.ut_id, 'infra_mobilidade_urbana_l'::text, 'km'::text,
    ROUND((SUM(ST_Length(ST_Intersection(f.geom, ut.geom)::geography)) / 1000)::numeric, 3)
  FROM _uts ut JOIN edgv.infra_mobilidade_urbana_l f ON ST_Intersects(f.geom, ut.geom)
  GROUP BY ut.ut_id
),

-- ============================================================
-- SUBFASE 5 — Elemento Hidrográfico
-- ============================================================
elem_hidro_p AS (
  SELECT ut.ut_id, 'elemnat_elemento_hidrografico_p'::text, 'qtd'::text,
    COUNT(*)::numeric
  FROM _uts ut JOIN edgv.elemnat_elemento_hidrografico_p f ON ST_Contains(ut.geom, f.geom)
  GROUP BY ut.ut_id
),
sumidouro AS (
  SELECT ut.ut_id, 'elemnat_sumidouro_vertedouro_p'::text, 'qtd'::text,
    COUNT(*)::numeric
  FROM _uts ut JOIN edgv.elemnat_sumidouro_vertedouro_p f ON ST_Contains(ut.geom, f.geom)
  GROUP BY ut.ut_id
),
elem_hidro_l AS (
  SELECT ut.ut_id, 'elemnat_elemento_hidrografico_l'::text, 'km'::text,
    ROUND((SUM(ST_Length(ST_Intersection(f.geom, ut.geom)::geography)) / 1000)::numeric, 3)
  FROM _uts ut JOIN edgv.elemnat_elemento_hidrografico_l f ON ST_Intersects(f.geom, ut.geom)
  GROUP BY ut.ut_id
),
elem_hidro_a AS (
  SELECT ut.ut_id, 'elemnat_elemento_hidrografico_a'::text, 'ha'::text,
    ROUND((SUM(ST_Area(ST_Intersection(f.geom, ut.geom)::geography)) / 10000)::numeric, 3)
  FROM _uts ut JOIN edgv.elemnat_elemento_hidrografico_a f ON ST_Intersects(f.geom, ut.geom)
  GROUP BY ut.ut_id
),

-- ============================================================
-- SUBFASE 7 — Limites
-- ============================================================
limite_legal AS (
  SELECT ut.ut_id, 'llp_limite_legal_l'::text, 'km'::text,
    ROUND((SUM(ST_Length(ST_Intersection(f.geom, ut.geom)::geography)) / 1000)::numeric, 3)
  FROM _uts ut JOIN edgv.llp_limite_legal_l f ON ST_Intersects(f.geom, ut.geom)
  GROUP BY ut.ut_id
),
ponto_controle AS (
  SELECT ut.ut_id, 'llp_ponto_controle_p'::text, 'qtd'::text,
    COUNT(*)::numeric
  FROM _uts ut JOIN edgv.llp_ponto_controle_p f ON ST_Contains(ut.geom, f.geom)
  GROUP BY ut.ut_id
),

-- ============================================================
-- SUBFASE 8 — Interseção Hidrografia/Transporte
-- ============================================================
travessia_p AS (
  SELECT ut.ut_id, 'infra_travessia_hidroviaria_p'::text, 'qtd'::text,
    COUNT(*)::numeric
  FROM _uts ut JOIN edgv.infra_travessia_hidroviaria_p f ON ST_Contains(ut.geom, f.geom)
  GROUP BY ut.ut_id
),
travessia_l AS (
  SELECT ut.ut_id, 'infra_travessia_hidroviaria_l'::text, 'km'::text,
    ROUND((SUM(ST_Length(ST_Intersection(f.geom, ut.geom)::geography)) / 1000)::numeric, 3)
  FROM _uts ut JOIN edgv.infra_travessia_hidroviaria_l f ON ST_Intersects(f.geom, ut.geom)
  GROUP BY ut.ut_id
),
barragem_l AS (
  SELECT ut.ut_id, 'infra_barragem_l'::text, 'km'::text,
    ROUND((SUM(ST_Length(ST_Intersection(f.geom, ut.geom)::geography)) / 1000)::numeric, 3)
  FROM _uts ut JOIN edgv.infra_barragem_l f ON ST_Intersects(f.geom, ut.geom)
  GROUP BY ut.ut_id
),
trecho_hidroviario AS (
  SELECT ut.ut_id, 'infra_trecho_hidroviario_l'::text, 'km'::text,
    ROUND((SUM(ST_Length(ST_Intersection(f.geom, ut.geom)::geography)) / 1000)::numeric, 3)
  FROM _uts ut JOIN edgv.infra_trecho_hidroviario_l f ON ST_Intersects(f.geom, ut.geom)
  GROUP BY ut.ut_id
),

-- ============================================================
-- SUBFASE 9 — Área Edificada
-- ============================================================
area_edificada AS (
  SELECT ut.ut_id, 'cobter_area_edificada_a'::text, 'ha'::text,
    ROUND((SUM(ST_Area(ST_Intersection(f.geom, ut.geom)::geography)) / 10000)::numeric, 3)
  FROM _uts ut JOIN edgv.cobter_area_edificada_a f ON ST_Intersects(f.geom, ut.geom)
  GROUP BY ut.ut_id
),

-- ============================================================
-- SUBFASE 10 — Edificação
-- ============================================================
edificacao_p AS (
  SELECT ut.ut_id, 'constr_edificacao_p'::text, 'qtd'::text,
    COUNT(*)::numeric
  FROM _uts ut JOIN edgv.constr_edificacao_p f ON ST_Contains(ut.geom, f.geom)
  GROUP BY ut.ut_id
),
edificacao_a AS (
  SELECT ut.ut_id, 'constr_edificacao_a'::text, 'ha'::text,
    ROUND((SUM(ST_Area(ST_Intersection(f.geom, ut.geom)::geography)) / 10000)::numeric, 3)
  FROM _uts ut JOIN edgv.constr_edificacao_a f ON ST_Intersects(f.geom, ut.geom)
  GROUP BY ut.ut_id
),
deposito_p AS (
  SELECT ut.ut_id, 'constr_deposito_p'::text, 'qtd'::text,
    COUNT(*)::numeric
  FROM _uts ut JOIN edgv.constr_deposito_p f ON ST_Contains(ut.geom, f.geom)
  GROUP BY ut.ut_id
),

-- ============================================================
-- SUBFASE 11 — Vegetação
-- ============================================================
vegetacao AS (
  SELECT ut.ut_id, 'cobter_vegetacao_a'::text, 'ha'::text,
    ROUND((SUM(ST_Area(ST_Intersection(f.geom, ut.geom)::geography)) / 10000)::numeric, 3)
  FROM _uts ut JOIN edgv.cobter_vegetacao_a f ON ST_Intersects(f.geom, ut.geom)
  GROUP BY ut.ut_id
),
terreno_inundacao AS (
  SELECT ut.ut_id, 'elemnat_terreno_sujeito_inundacao_a'::text, 'ha'::text,
    ROUND((SUM(ST_Area(ST_Intersection(f.geom, ut.geom)::geography)) / 10000)::numeric, 3)
  FROM _uts ut JOIN edgv.elemnat_terreno_sujeito_inundacao_a f ON ST_Intersects(f.geom, ut.geom)
  GROUP BY ut.ut_id
),

-- ============================================================
-- SUBFASE 12 — Planimetria
-- ============================================================
energia_p AS (
  SELECT ut.ut_id, 'infra_elemento_energia_p'::text, 'qtd'::text,
    COUNT(*)::numeric
  FROM _uts ut JOIN edgv.infra_elemento_energia_p f ON ST_Contains(ut.geom, f.geom)
  GROUP BY ut.ut_id
),
energia_l AS (
  SELECT ut.ut_id, 'infra_elemento_energia_l'::text, 'km'::text,
    ROUND((SUM(ST_Length(ST_Intersection(f.geom, ut.geom)::geography)) / 1000)::numeric, 3)
  FROM _uts ut JOIN edgv.infra_elemento_energia_l f ON ST_Intersects(f.geom, ut.geom)
  GROUP BY ut.ut_id
),
trecho_duto AS (
  SELECT ut.ut_id, 'infra_trecho_duto_l'::text, 'km'::text,
    ROUND((SUM(ST_Length(ST_Intersection(f.geom, ut.geom)::geography)) / 1000)::numeric, 3)
  FROM _uts ut JOIN edgv.infra_trecho_duto_l f ON ST_Intersects(f.geom, ut.geom)
  GROUP BY ut.ut_id
),
infra_p AS (
  SELECT ut.ut_id, 'infra_elemento_infraestrutura_p'::text, 'qtd'::text,
    COUNT(*)::numeric
  FROM _uts ut JOIN edgv.infra_elemento_infraestrutura_p f ON ST_Contains(ut.geom, f.geom)
  GROUP BY ut.ut_id
),
constr_solo_p AS (
  SELECT ut.ut_id, 'constr_ocupacao_solo_p'::text, 'qtd'::text,
    COUNT(*)::numeric
  FROM _uts ut JOIN edgv.constr_ocupacao_solo_p f ON ST_Contains(ut.geom, f.geom)
  GROUP BY ut.ut_id
),
elem_fisio_p AS (
  SELECT ut.ut_id, 'elemnat_elemento_fisiografico_p'::text, 'qtd'::text,
    COUNT(*)::numeric
  FROM _uts ut JOIN edgv.elemnat_elemento_fisiografico_p f ON ST_Contains(ut.geom, f.geom)
  GROUP BY ut.ut_id
)

-- ============================================================
-- Resultado final
-- ============================================================
SELECT ut_id, camada, metrica, valor FROM trecho_drenagem
UNION ALL SELECT * FROM curva_nivel
UNION ALL SELECT * FROM ponto_cotado
UNION ALL SELECT * FROM localidade
UNION ALL SELECT * FROM toponimo_p
UNION ALL SELECT * FROM toponimo_l
UNION ALL SELECT * FROM via_deslocamento
UNION ALL SELECT * FROM elemento_viario
UNION ALL SELECT * FROM mobilidade_urbana
UNION ALL SELECT * FROM elem_hidro_p
UNION ALL SELECT * FROM sumidouro
UNION ALL SELECT * FROM elem_hidro_l
UNION ALL SELECT * FROM elem_hidro_a
UNION ALL SELECT * FROM limite_legal
UNION ALL SELECT * FROM ponto_controle
UNION ALL SELECT * FROM travessia_p
UNION ALL SELECT * FROM travessia_l
UNION ALL SELECT * FROM barragem_l
UNION ALL SELECT * FROM trecho_hidroviario
UNION ALL SELECT * FROM area_edificada
UNION ALL SELECT * FROM edificacao_p
UNION ALL SELECT * FROM edificacao_a
UNION ALL SELECT * FROM deposito_p
UNION ALL SELECT * FROM vegetacao
UNION ALL SELECT * FROM terreno_inundacao
UNION ALL SELECT * FROM energia_p
UNION ALL SELECT * FROM energia_l
UNION ALL SELECT * FROM trecho_duto
UNION ALL SELECT * FROM infra_p
UNION ALL SELECT * FROM constr_solo_p
UNION ALL SELECT * FROM elem_fisio_p
ORDER BY ut_id, camada;
