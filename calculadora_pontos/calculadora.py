"""
Sprint 1 — Prova de conceito: cálculo de score por UT com dados PostGIS reais.

O banco tem uma única moldura (~772 km²). Para simular 3 UTs, a moldura é
dividida em 3 colunas (grade 3×1) pelo bounding box.

Uso:
    python calculadora.py --db 0734_1_2025_12_03_Andre
    python calculadora.py --db 0734_1_2025_12_03_Andre --host localhost --user postgres
"""

import argparse
import json
import os
import re
import sys

from datetime import datetime
from pathlib import Path

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    sys.exit("Dependência ausente: pip install psycopg2-binary")

BASE_DIR = Path(__file__).parent
SQL_PATH = BASE_DIR.parent / "banco" / "queries" / "extrair_metricas.sql"


# ------------------------------------------------------------------ #
# Configurações                                                        #
# ------------------------------------------------------------------ #

def _carregar_json(caminho: Path) -> dict:
    with open(caminho, encoding="utf-8") as f:
        return json.load(f)


def carregar_pesos() -> dict:
    return _carregar_json(BASE_DIR / "pesos" / "pesos_v1.json")


def carregar_mapeamento() -> dict:
    return _carregar_json(BASE_DIR / "mapeamento_camadas.json")


# ------------------------------------------------------------------ #
# Criação das UTs virtuais (grade 3×1 sobre a moldura)               #
# ------------------------------------------------------------------ #

SQL_MOLDURA_BBOX = """
SELECT
    ST_XMin(ST_Extent(geom)) AS xmin,
    ST_YMin(ST_Extent(geom)) AS ymin,
    ST_XMax(ST_Extent(geom)) AS xmax,
    ST_YMax(ST_Extent(geom)) AS ymax,
    ST_AsText(ST_Union(geom))  AS moldura_wkt
FROM edgv.aux_moldura_a;
"""

SQL_CELULAS = """
WITH bbox AS (
  SELECT
    ST_XMin(ST_Extent(geom)) AS x0,
    ST_XMax(ST_Extent(geom)) AS x1,
    ST_YMin(ST_Extent(geom)) AS y0,
    ST_YMax(ST_Extent(geom)) AS y1,
    ST_Union(geom) AS moldura
  FROM edgv.aux_moldura_a
),
grade AS (
  SELECT
    n,
    ST_Intersection(
      moldura,
      ST_MakeEnvelope(
        x0 + (x1 - x0) * (n - 1) / 3.0,
        y0,
        x0 + (x1 - x0) *  n      / 3.0,
        y1,
        4674
      )
    ) AS geom
  FROM bbox, generate_series(1, 3) AS n
)
SELECT n AS ut_id, ST_AsText(geom) AS geom_wkt,
       ROUND((ST_Area(geom::geography) / 1000000)::numeric, 2) AS area_km2
FROM grade
WHERE NOT ST_IsEmpty(geom);
"""


def criar_uts_virtuais(conn) -> list[dict]:
    """Divide a moldura em 3 células e retorna lista de {ut_id, geom_wkt, area_km2}."""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(SQL_CELULAS)
        return [dict(r) for r in cur.fetchall()]


# ------------------------------------------------------------------ #
# Extração de métricas do PostGIS                                     #
# ------------------------------------------------------------------ #

def extrair_metricas(conn, uts: list[dict]) -> list[dict]:
    """
    Cria tabela temporária com as geometrias das UTs, executa o SQL de métricas
    substituindo a CTE _uts por referência à temp table, e retorna os resultados.
    """
    sql_template = SQL_PATH.read_text(encoding="utf-8")

    # Trocar a CTE _uts (placeholder) por referência à temp table
    sql_metricas = re.sub(
        r"WITH _uts \(ut_id, geom\) AS \(.*?^\)",
        "WITH _uts AS (\n  SELECT ut_id, geom FROM _uts_temp\n)",
        sql_template,
        flags=re.DOTALL | re.MULTILINE,
    )

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        # Criar temp table e popular
        cur.execute(
            "CREATE TEMP TABLE _uts_temp (ut_id integer, geom geometry(MultiPolygon, 4674))"
        )
        for ut in uts:
            cur.execute(
                "INSERT INTO _uts_temp VALUES (%s, ST_Multi(ST_GeomFromText(%s, 4674)))",
                (ut["ut_id"], ut["geom_wkt"]),
            )

        cur.execute(sql_metricas)
        return [dict(r) for r in cur.fetchall()]


# ------------------------------------------------------------------ #
# Índice camada → subfase                                             #
# ------------------------------------------------------------------ #

def _indice_camada_subfase(mapeamento: dict) -> dict[str, list[str]]:
    indice: dict[str, list[str]] = {}
    for subfase_key, subfase in mapeamento["subfases"].items():
        for c in subfase.get("camadas", []):
            indice.setdefault(c["tabela"], []).append(subfase_key)
    return indice


# ------------------------------------------------------------------ #
# Aplicação de pesos                                                  #
# ------------------------------------------------------------------ #

def aplicar_pesos(metricas: list[dict], pesos: dict, mapeamento: dict) -> dict:
    pesos_geo   = pesos["pesos_geometria"]
    mult_sub    = pesos["multiplicadores_subfase"]
    indice      = _indice_camada_subfase(mapeamento)
    scores: dict[int, dict[str, float]] = {}

    for linha in metricas:
        ut_id   = linha["ut_id"]
        camada  = linha["camada"]
        metrica = linha["metrica"]
        valor   = float(linha["valor"] or 0)

        if camada not in indice or valor == 0:
            continue

        peso_geo      = pesos_geo.get(metrica, 1.0)
        pontos_brutos = valor * peso_geo

        for subfase_key in indice[camada]:
            mult   = mult_sub.get(subfase_key, {}).get("valor", 1.0)
            pontos = round(pontos_brutos * mult, 4)
            ut_scores = scores.setdefault(ut_id, {})
            ut_scores[subfase_key] = round(
                ut_scores.get(subfase_key, 0.0) + pontos, 4
            )

    return scores


# ------------------------------------------------------------------ #
# Consolidação                                                         #
# ------------------------------------------------------------------ #

def consolidar(scores_sub: dict, pesos: dict, uts: list[dict]) -> list[dict]:
    mult_vf  = pesos["multiplicadores_subfase"].get("verificacao_final", {}).get("valor", 1.0)
    area_map = {ut["ut_id"]: ut["area_km2"] for ut in uts}
    resultado = []

    for ut_id, por_subfase in sorted(scores_sub.items()):
        subtotal  = sum(por_subfase.values())
        pontos_vf = round(subtotal * mult_vf, 4)
        por_subfase_final = dict(sorted(por_subfase.items(), key=lambda x: -x[1]))
        por_subfase_final["verificacao_final"] = pontos_vf

        resultado.append({
            "ut_id":       ut_id,
            "area_km2":    area_map.get(ut_id),
            "score_total": round(subtotal + pontos_vf, 4),
            "por_subfase": por_subfase_final,
        })

    return resultado


# ------------------------------------------------------------------ #
# Saída                                                               #
# ------------------------------------------------------------------ #

def salvar_output(resultado: list[dict], pesos_versao: str) -> Path:
    saida = BASE_DIR / "insumos" / "exemplo_ut_scores.json"
    saida.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "gerado_em":    datetime.now().isoformat(timespec="seconds"),
        "versao_pesos": pesos_versao,
        "banco":        "0734_1_2025_12_03_Andre",
        "scores":       resultado,
    }
    import decimal

    def _json_default(obj):
        if isinstance(obj, decimal.Decimal):
            return float(obj)
        raise TypeError(f"Object of type {type(obj)} is not JSON serializable")

    with open(saida, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2, default=_json_default)
    return saida


def imprimir_resumo(resultado: list[dict]) -> None:
    print("\n" + "=" * 60)
    print("  SCORES POR UT — Sprint 1 Prova de Conceito")
    print("=" * 60)
    for ut in resultado:
        print(f"\n  UT {ut['ut_id']} ({ut['area_km2']} km²)")
        print(f"  {'Score total':.<35} {ut['score_total']:>10.2f} pts")
        print(f"  {'-' * 46}")
        for subfase, pts in ut["por_subfase"].items():
            if pts > 0:
                print(f"  {subfase:<40} {pts:>8.2f}")
    print("\n" + "=" * 60)

    scores = [ut["score_total"] for ut in resultado]
    if len(scores) > 1:
        desvio = max(scores) - min(scores)
        print(f"  Desequilíbrio máximo: {desvio:.2f} pts "
              f"({desvio / max(scores) * 100:.1f}%)")
    print()


# ------------------------------------------------------------------ #
# Entrypoint                                                          #
# ------------------------------------------------------------------ #

def _parse_args():
    p = argparse.ArgumentParser(description="Calculadora de score por UT — Sprint 1")
    p.add_argument("--host",     default="localhost")
    p.add_argument("--port",     default=5432, type=int)
    p.add_argument("--db",       default="0734_1_2025_12_03_Andre")
    p.add_argument("--user",     default=os.getenv("PGUSER", "postgres"))
    p.add_argument("--password", default=os.getenv("PGPASSWORD", "postgres"))
    return p.parse_args()


def main():
    args  = _parse_args()
    pesos = carregar_pesos()
    mapa  = carregar_mapeamento()

    print(f"Conectando a {args.host}:{args.port}/{args.db} ...")
    conn = psycopg2.connect(
        host=args.host, port=args.port, dbname=args.db,
        user=args.user, password=args.password,
    )

    print("Criando 3 UTs virtuais (grade 3×1 sobre a moldura) ...")
    uts = criar_uts_virtuais(conn)
    for ut in uts:
        print(f"  UT {ut['ut_id']}: {ut['area_km2']} km²")

    print("\nExtraindo métricas do PostGIS ...")
    metricas = extrair_metricas(conn, uts)
    conn.close()

    if not metricas:
        sys.exit("Nenhuma métrica retornada. Verificar dados no banco.")

    print(f"{len(metricas)} linhas de métricas extraídas.")

    scores    = aplicar_pesos(metricas, pesos, mapa)
    resultado = consolidar(scores, pesos, uts)

    imprimir_resumo(resultado)

    saida = salvar_output(resultado, pesos["versao"])
    print(f"Output salvo em: {saida}")


if __name__ == "__main__":
    main()
