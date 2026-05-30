# 🏅 GeoEsforço — Como o Score de Esforço é Calculado

> **Uma UT não é só um polígono no mapa. É um volume de trabalho real, mensurável, comparável. O GeoEsforço transforma isso em número.**

---

## ✨ Por que isso importa?

Você já distribuiu unidades de trabalho "no olho" e descobriu depois que um operador ficou com o dobro do esforço real de outro?

O GeoEsforço resolve isso. Ele lê o banco de dados EDGV, mede cada feição que o operador vai precisar extrair naquela área, e devolve um **score de esforço calibrado** — por subfase, por escala, por topologia da rede.

**Resultado direto:**

| Sem GeoEsforço | Com GeoEsforço |
|---|---|
| Distribuição por "tamanho visual" da UT | Distribuição por esforço real mensurado |
| Operadores desbalanceados | Cargas niveladas ±15% |
| Replanejamento no meio do ciclo | Previsibilidade no início |
| Produtividade estimada no cheiro | Taxa pts/hora rastreável |

---

## 🧠 A Fórmula Central

Tudo se resume a esta equação:

```
pontos_camada = valor^expoente × peso_geometria × mult_subfase × mult_escala
```

**Onde:**

| Variável | O que é | Exemplo |
|---|---|---|
| `valor` | Quantidade bruta extraída do banco (km, unidades, ha) | `12.4 km` de drenagem |
| `expoente` | Amplifica progressivamente valores altos (default = 1) | `1.0` |
| `peso_geometria` | Quanto cada tipo de geometria "pesa" por unidade | `2.5` pts/km |
| `mult_subfase` | Multiplicador da subfase (quão trabalhosa é aquela fase) | `1.8` para hidrografia |
| `mult_escala` | Correção pelo denominador da escala de produção | `1.0` para 1:50k |

**Pontuação da subfase = soma de todos os pontos das camadas que a compõem.**

**Score total = Σ subfases + Verificação Final.**

---

## 📐 Pesos de Geometria (v1)

Cada tipo de métrica tem um peso base que reflete o esforço de vetorização:

```
qtd    → 1.0 pt por feição
km     → 2.5 pts por quilômetro
ha/km² → 2.5 pts por unidade
perim  → 2.5 pts/km de perímetro  (polígonos mapeados pelo contorno)
```

> **Por que perímetro e não área?** Porque o operador vetoriza o *contorno* do polígono. Uma área edificada de 200 ha com perímetro sinuoso é muito mais trabalhosa que um quadrado de mesmo tamanho.

---

## 🔬 Métricas: Como o Banco Fala

O engine nunca usa dados "pré-computados". A cada cálculo, ele dispara queries **PostGIS ao vivo** contra o banco EDGV:

### `km` — Comprimento Real
```sql
ROUND(SUM(ST_Length(
  ST_Intersection(geom, $ut_geom)::geography
)) / 1000, 3) AS valor
```
Recorta cada feição ao polígono da UT e mede o comprimento geográfico real — em metros convertidos para km. Não soma o que está fora da fronteira.

---

### `qtd` — Contagem de Feições
```sql
COUNT(*) FROM tabela WHERE ST_Within(geom, $ut_geom)
```
Conta apenas feições completamente **dentro** da UT. Feições cortadas pela borda não contam duas vezes.

---

### `perim` — Perímetro de Polígonos
```sql
SUM(ST_Perimeter(
  ST_Intersection(geom, $ut_geom)::geography
)) / 1000 AS valor
```
Mesmo raciocínio do `km`, mas aplicado ao contorno de áreas. Usado em `cobter_area_edificada_a`, `elemnat_elemento_hidrografico_a`, etc.

---

### `dens_ent` — 🚦 Densidade de Entroncamentos
> **A métrica mais sofisticada do sistema.**

Mede não só quantos km de via há na UT, mas **quão complexa é a malha viária** — o quanto o operador vai precisar cortar, ajustar e conectar nós.

**Pipeline topológico (ST_Node):**
```
1. Recorta todas as vias à UT (infra_via_deslocamento_l + infra_elemento_viario_l + infra_mobilidade_urbana_l)
2. ST_Node → explode a rede em segmentos com nós explícitos
3. Conta endpoints onde ≥ 3 segmentos se encontram → entroncamentos
4. Calcula dens_ent = n_entroncamentos / km_vias
```

O resultado não é pontuação linear — é uma **curva de densidade**:

| Entroncamentos/km | Fator bônus |
|---|---|
| até 0.1 | ×1.00 (base) |
| até 0.5 | ×1.06 |
| até 1.0 | ×1.10 |
| até 2.0 | ×1.20 |
| até 4.0 | ×1.35 |
| acima de 6.0 | ×1.55 |

> **Intuição:** Uma estrada rural reta de 30 km é menos trabalho que 30 km de malha urbana com uma rotatória a cada 500m. O GeoEsforço captura essa diferença.

**Fórmula do bônus de entroncamentos:**
```
pts_ent = km_vias × peso_km × (fator_dens − 1.0) × mult_subfase
```

---

### `dens_conf` — 🌊 Densidade de Confluências de Drenagem

Idêntico ao `dens_ent`, mas para redes hidrográficas. Uma bacia com muitos afluentes é muito mais complexa de mapear do que um rio único.

```
dens_conf = n_confluencias / km_drenagem
```

Curva calibrada para densidades típicas de drenagem em 1:50.000 (0.05–0.50 conf/km):

| Confluências/km | Fator bônus |
|---|---|
| até 0.05 | ×1.00 |
| até 0.20 | ×1.08 |
| até 0.50 | ×1.18 |
| até 0.80 | ×1.25 |
| acima de 2.00 | ×1.40 |

---

### `km_named_body` — Corpos d'Água Nomeados

Estratégia especial para lagos e represas. Não mede só km de linha — verifica se o polígono formado pelos delimitadores contém um **centroide nomeado**:

```
1. Recorta delimitador_massa_dagua_l à UT
2. ST_Polygonize → fecha os polígonos
3. Filtra polígonos que contêm centroide com nome IS NOT NULL
4. Retorna perímetro (km) desses polígonos
```

> Apenas áreas com nome próprio (lagos, represas nomeadas) entram no cálculo. Valas anônimas não.

---

## ⚡ Multiplicadores de Subfase

Cada subfase tem um multiplicador que reflete **quanto esforço relativo** ela representa por feição:

| Subfase | Mult | Raciocínio |
|---|---|---|
| 🚂 Ferrovia | **1.2×** | Poucos elementos, alta precisão exigida |
| 💧 Hidrografia & Altimetria | **1.8×** | Alto volume, curvas de nível, confluências |
| 🏷️ Topônimos | **0.5×** | Posicionamento textual, menor esforço vetorial |
| 🛣️ Vias de Deslocamento | **1.5×** | Volume alto + topologia complexa |
| 🌊 Elemento Hidrográfico | **2.0×** | Maior complexidade temática |
| ⬜ Área sem Dados | **0.8×** | Rápido de mapear |
| 🗺️ Limites | **1.5×** | Precisão legal exigida |
| 🔀 Intersecção Hidro/Transp | **0.8×** | Derivado de camadas já mapeadas |
| 🏙️ Área Edificada | **1.2×** | Contornos complexos |
| 🏠 Edificação | **0.5×** | Alta densidade, mas feição simples |
| 🌿 Vegetação | **2.0×** | Delimitação subjetiva, alto volume |
| 📐 Planimetria | **2.0×** | Maior diversidade de camadas (17+) |
| ✅ Verificação Final | **0.2×** | Calculado sobre o subtotal geral |

> **Os multiplicadores são configuráveis no JSON** — à medida que dados históricos de produção forem coletados, os valores são calibrados por regressão.

---

## 📏 Correção de Escala — A Curva

Produzir uma carta em 1:25.000 não é a mesma coisa que em 1:250.000. O sistema aplica um fator global por escala de produção:

| Denominador | Fator | Intuição |
|---|---|---|
| 1:5.000 | **2.80×** | Cada feição exige máxima precisão |
| 1:10.000 | **2.20×** | |
| 1:25.000 | **1.50×** | |
| **1:50.000** | **1.00×** | ← Referência calibrada |
| 1:100.000 | **0.75×** | Menor detalhe exigido |
| 1:250.000 | **0.50×** | Generalização agressiva |

**Amplitude de ~7× entre os extremos** — reflete fielmente a diferença de exigência cartográfica entre as escalas.

### Fallback matemático
Se a curva não cobrir a escala solicitada:
```
mult = (50.000 / denominador_escala) ^ 0.2
```

---

## 🇧🇷 Recorte ao Território Nacional

Antes de qualquer cálculo, a geometria da UT é **recortada à União das Unidades Federativas**:

```sql
ST_Intersection(geom_ut, ST_Union(llp_unidade_federacao_a.geom))
```

**Por que isso importa?** UTs de fronteira frequentemente se estendem para países vizinhos. O banco OSM cobre todo o continente — sem esse filtro, estradas argentinas ou paraguaias entrariam no score de uma UT brasileira de fronteira.

O sistema faz fallback automático para o banco `insumos_oficiais` se o banco ativo não tiver a camada populada.

---

## 🔗 Joins Cross-Database

Algumas subfases cruzam **dois bancos diferentes** simultaneamente:

```
Interseção Hidro × Transporte:
  ├── Drenagem (insumos_oficiais/edgv) × Vias (insumo_osm)
  └── Conta pares (drenagem_i × via_j) que se cruzam em pontos
```

**Pipeline de 2 passos para joins cross-db:**
1. Coleta geometrias de A no banco A → WKT
2. No banco B, conta feições B que intersectam cada geometria A
3. Combina resultados no servidor Node.js

> Sem esse mecanismo, não seria possível cruzar a drenagem oficial com as vias do OpenStreetMap em uma única query.

---

## ✅ Verificação Final — O Multiplicador do Todo

A subfase `verificacao_final` não tem lógica própria de camadas únicas — ela é **proporcional ao subtotal de tudo que foi mapeado**:

```
subtotal = Σ(pontos de todas as subfases × mult_escala)
pontos_VF = subtotal × 0.20
score_total = subtotal + pontos_VF
```

**Por quê?** A verificação final de uma UT complexa (800 pts de extração) é genuinamente mais trabalhosa que a de uma simples (80 pts). O fator 0.20 é calibrável no JSON de pesos.

---

## 🗄️ O Banco GeoEsforço — Persistência por MI

Cada score calculado pode ser persistido no banco `geoesforco`, vinculado ao **MI (Moldura Internacional)** que contém a UT:

```
UT calculada
    ↓
ST_Contains(mi.geom, ST_Centroid(ut.geom))
    ↓
Encontra o MI correspondente na aux_moldura_a
    ↓
UPSERT em pontuacao.topo / pontuacao.orto
```

**Estratégia de UPSERT inteligente:**

| Modo | Estratégia |
|---|---|
| Uma subfase calculada | `MERGE` — adiciona/atualiza só aquela chave no JSONB `por_subfase` |
| Todas as subfases | `REPLACE` — substitui o registro completo do MI |

A coluna `por_subfase` é JSONB — o operador `||` do PostgreSQL faz o merge chave a chave sem sobrescrever as demais subfases já calculadas.

---

## 📊 Arquitetura de Dados

```
calculadora_pontos/
├── mapeamento_topo.json     → quais camadas, métricas e filtros por subfase (Topo 1.4)
├── mapeamento_orto.json     → mesmo para mapeamento ortofoto
├── pesos/
│   ├── pesos_topo_v1.json   → pesos de geometria, curva de escala, multiplicadores
│   └── pesos_orto_v1.json
└── registro_lps.json        → mapeamento LP SAP → arquivo de mapeamento

geoesforco (banco PostgreSQL)
└── pontuacao/
    ├── topo                 → um registro por MI, por LP Topo
    │   ├── mi TEXT          → chave natural (ex: "SF-23-Y-A-I")
    │   ├── geom GEOMETRY    → polígono do MI em SIRGAS 2000
    │   ├── score_total      → pontuação total com escala
    │   ├── por_subfase JSONB → {"ext_ferrovia": 45.2, "ext_hidrografia_altimetria": 312.8, ...}
    │   └── por_camada JSONB → detalhamento completo por camada (valor, fator, pts)
    └── orto                 → idem para LP Orto
```

---

## 🎯 Fluxo Completo de um Cálculo

```
1. Usuário seleciona UT (do SAP ou geometria manual)
             ↓
2. Backend recebe geom WKT + lpKey + escala
             ↓
3. clipToUF() — recorta à fronteira nacional (cache LRU 10min)
             ↓
4. extractMetrics() — dispara N queries PostGIS em paralelo
   ├── queries simples (km, qtd, perim) → Promise.all
   └── queries topológicas (dens_ent, dens_conf) → client isolado + timeout 20s
             ↓
5. applyWeights() — aplica pesos, curvas de densidade, multiplicadores
             ↓
6. calcMultEscala() — interpola na curva de escala
             ↓
7. consolidate() — aplica mult_escala + calcula VF
             ↓
8. Resposta: { score_total, por_subfase, por_camada, mult_escala, ... }
             ↓
9. (opcional) salvarPontuacao() → UPSERT no banco geoesforco
```

**Tempo médio de resposta:** 800ms–3s por UT (varia com complexidade e tamanho da UT).

---

## 🚀 Vantagens Concretas de Ter Este Dado

### 1. 🎯 Distribuição de Carga Justa
Distribua lotes entre operadores com diferença máxima de ±15% de esforço total. Acabou o "quem tirou a UT difícil hoje".

### 2. 📈 Previsibilidade de Prazo Real
Com `taxa_pts_hora` calibrada (default 50 pts/h), o sistema estima automaticamente o tempo de produção:
```
horas_estimadas = score_total / taxa_pts_hora
```

### 3. 🔍 Detecção de Gargalos Temáticos
O score por subfase revela **onde** está o esforço: uma UT com 600 pts de vegetação mas 10 pts de edificação muda completamente a estratégia de execução.

### 4. 📊 Benchmarking entre Escalas e Regiões
Com o score por MI persistido, é possível comparar esforço entre projetos de escalas diferentes, entre regiões geográficas, e entre ciclos de produção.

### 5. 🤖 Calibração Contínua
O sistema foi projetado para **evoluir com dados reais**. Quando o tempo real de produção for registrado contra os scores estimados, os pesos e multiplicadores são recalibrados por regressão — tornando as estimativas progressivamente mais precisas.

### 6. 🗺️ Visualização Espacial de Esforço
Com o score por MI no banco, é possível gerar mapas coropletas de esforço → identificar regiões sistematicamente subestimadas ou superestimadas antes de fechar contratos.

### 7. ✅ Auditoria Total
Cada score é completamente auditável: o campo `por_camada` registra o valor bruto, o fator, o peso e os pontos de cada camada individualmente. Se o score parecer errado, é possível ir até o nível de `ST_Length(infra_ferrovia_l)` e conferir.

---

## ⚙️ Configuração e Extensibilidade

O sistema é 100% declarativo nos JSONs. Para adicionar uma nova camada à pontuação:

```json
// mapeamento_topo.json — dentro da subfase desejada:
{
  "tabela": "nova_camada_l",
  "metrica": "km",
  "where": "tipo = 'principal'",
  "banco": "insumo_osm"
}
```

Para ajustar pesos sem reiniciar o servidor:
```json
// pesos_topo_v1.json
"multiplicadores_subfase": {
  "ext_vegetacao": { "valor": 2.5 }  // era 2.0, aumentado após calibração
}
```

O cache em memória escuta mudanças via `fs.watch` — **a próxima query já usa os novos valores.**

---

## 📌 Referência Rápida

| Parâmetro | Arquivo | Variável de ambiente |
|---|---|---|
| Pesos e multiplicadores | `pesos/pesos_topo_v1.json` | — |
| Camadas por subfase | `mapeamento_topo.json` | — |
| Banco EDGV ativo | — | `EDGV_DB` |
| Banco OSM | — | `OSM_DB` |
| Banco de pontuação | — | `GEOESFORCO_DB` |
| Banco de referência (UFs) | — | pool `refPool` → `insumos_oficiais` |

---

> *"Esforço não medido é esforço não gerenciado."*
>
> O GeoEsforço não é uma estimativa no olho. É física aplicada à cartografia.

---

**Versão da documentação:** 2026-05-28 | **Engine:** `calculadora.js` v1 | **Pesos:** `pesos_topo_v1.json` v1.0
