-- ============================================================
-- ETAPA 0 — Descoberta do schema EDGV no PostGIS
-- Rodar antes de qualquer implementação para confirmar nomes
-- reais de tabelas, tipos de geometria e relação com UTs.
-- ============================================================

-- 1. Listar todas as tabelas EDGV com seus tipos de geometria
SELECT
    t.table_schema,
    t.table_name,
    g.type           AS tipo_geometria,
    g.srid
FROM information_schema.tables t
JOIN geometry_columns g
    ON g.f_table_schema = t.table_schema
    AND g.f_table_name  = t.table_name
WHERE t.table_schema = 'edgv'
  AND t.table_name ~ '^(infra|elemnat|constr|llp|cobter)_'
ORDER BY t.table_name;

-- ============================================================
-- 2. Verificar se as tabelas EDGV têm coluna de FK para UT
--    (ex: ut_id, unidade_trabalho_id, lote_id)
-- ============================================================
SELECT
    table_name,
    column_name,
    data_type
FROM information_schema.columns
WHERE table_schema = 'edgv'
  AND table_name ~ '^(infra|elemnat|constr|llp|cobter)_'
  AND column_name ILIKE ANY (ARRAY[
      '%ut%', '%unidade%', '%lote%', '%projeto%'
  ])
ORDER BY table_name, column_name;

-- ============================================================
-- 3. Descobrir a tabela de Unidades de Trabalho (UT)
--    Procurar em todos os schemas
-- ============================================================
SELECT
    table_schema,
    table_name,
    column_name,
    data_type
FROM information_schema.columns
WHERE table_name ILIKE '%unidade%trabalho%'
   OR table_name ILIKE '%ut%'
ORDER BY table_schema, table_name, column_name;

-- ============================================================
-- 4. Contar feições por tabela (amostra de volume)
--    Rodar individualmente para cada tabela de interesse
-- ============================================================
-- Exemplo (substituir pelo nome real da tabela):
-- SELECT COUNT(*) FROM edgv.elemnat_trecho_drenagem_l;
-- SELECT COUNT(*) FROM edgv.infra_via_deslocamento_l;

-- ============================================================
-- 5. Verificar qual schema contém as UTs e sua estrutura
--    (ajustar 'bdgex' se o schema for diferente)
-- ============================================================
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'  -- ajustar conforme ambiente
  AND table_name ILIKE '%unidade%'
ORDER BY ordinal_position;
