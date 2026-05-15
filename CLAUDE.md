# CLAUDE.md — Sistema de Apoio à Produção de Cartas Topográficas

## Visão Geral do Projeto

Este projeto é um **sistema de apoio à produção de cartas topográficas** baseado na EDGV 3.0 Topo 1.4. O sistema permite:

- Planejamento de projetos cartográficos
- Criação e gerenciamento de unidades de trabalho (UTs)
- Distribuição de esforço entre operadores
- **Calculadora de pontos por unidade de trabalho** (foco do desenvolvimento atual)

O principal desafio operacional é **dividir igualmente o esforço das subfases de extração** entre os operadores, considerando a complexidade real de cada UT com base nos seus insumos geoespaciais.

---

## Linha de Produção — EDGV 3.0 Topo 1.4

Arquivo de referência: `lp_cdgv_edgv_30topo14.json`

### Fases

| Fase ID | Ordem | Nome |
|---------|-------|------|
| 16 | 1 | Preparo |
| 1  | 2 | Extração de Vetores ← **foco principal** |
| 3  | 3 | Validação |
| 5  | 4 | Disseminação |

### Subfases de Extração (Fase 1 — tipo_fase_id: 1)

| Ordem | Subfase | Geometrias na LP |
|-------|---------|-----------------|
| 1  | Extração de Ferrovia | 4 camadas (1P 2L 1A) |
| 2  | Extração da Hidrografia e Altimetria | 11 camadas (3P 6L 2A) |
| 3  | Extração de Topônimos | 8 camadas (3P 3L 2A) |
| 4  | Extração de Vias de Deslocamento | 8 camadas (2P 5L 1A) |
| 5  | Extração de Elemento Hidrográfico | 17 camadas (7P 8L 2A) |
| 6  | Extração de Área sem Dados | 24 camadas (9P 13L 2A) |
| 7  | Extração de Limites | 28 camadas (11P 15L 2A) |
| 8  | Extração de Interseção de Hidrografia e Transporte | 22 camadas (8P 12L 2A) |
| 9  | Extração de Área Edificada | 26 camadas (10P 14L 2A) |
| 10 | Extração de Edificação | 30 camadas (12P 14L 4A) |
| 11 | Extração de Vegetação | 28 camadas (11P 15L 2A) |
| 12 | Extração de Planimetria | 52 camadas (19P 22L 11A) |
| 13 | Verificação Final | 76 camadas (26P 28L 22A) |

### Pré-requisitos entre subfases (dependências)

As subfases possuem pré-requisitos definidos no JSON (`pre_requisito_subfase`). Ferrovia deve preceder Vias de Deslocamento, por exemplo. O sistema de distribuição deve respeitar essa ordem.

---

## Banco de Dados

Arquivo de referência: `edgv_300_topo_14.sql`

### Prefixos temáticos das camadas EDGV

| Prefixo | Tema | Qtd camadas |
|---------|------|-------------|
| `infra` | Infraestrutura (vias, ferrovias, hidrovias, barragens) | 22 |
| `elemnat` | Elementos naturais (drenagem, curvas de nível, vegetação) | 15 |
| `constr` | Construções e edificações | 10 |
| `llp` | Limites e localidades políticas | 8 |
| `cobter` | Cobertura terrestre | 3 |

### Tipos de geometria relevantes para pontuação

- `_p` — Ponto
- `_l` — Linha (comprimento em metros)
- `_a` — Área (área em m²)

---

## Sistema de Pontuação — Conceito e Arquitetura

### Problema a resolver

Cada unidade de trabalho (UT) cobre uma área geográfica diferente. O esforço do operador varia conforme a **densidade e complexidade dos elementos** naquela área. Para distribuir o trabalho igualmente, precisamos de uma **pontuação objetiva** por UT e por subfase.

### Fontes de insumo para cálculo de pontos

Os insumos são levantados das classes EDGV e convertidos em métricas quantitativas:

| Tipo de insumo | Métrica | Conversão sugerida |
|---------------|---------|-------------------|
| Feições pontuais | Contagem de pontos | `n_pontos × peso_subfase` |
| Feições lineares | Comprimento total (km) | `km × peso_subfase` |
| Feições poligonais | Área total (m²) ou contagem | `m² × peso_subfase` ou `n_poligonos × peso` |
| Curvas de nível | Comprimento total (km) | `km × fator_altimetria` |
| Topônimos | Contagem | `n_toponimos × peso_toponimo` |

### Modelo de pontuação proposto

```
pontos_subfase(UT) = Σ (quantidade_insumo × peso_classe × fator_dificuldade)
pontos_total(UT)   = Σ pontos_subfase
```

**Parâmetros configuráveis:**
- `peso_classe` — calibrado por experiência operacional (quanto tempo leva cada classe)
- `fator_dificuldade` — ajuste por tipo de terreno, densidade urbana, cobertura de nuvens etc.
- `fator_subfase` — multiplicador global por subfase (ex: Verificação Final = 1.5× mais esforço por feição)

### Distribuição entre operadores

Com os pontos calculados por UT:

1. Somar pontos de todas as UTs do projeto
2. Dividir pelo número de operadores → **meta de pontos por operador**
3. Atribuir UTs a operadores tentando equilibrar o total de pontos
4. Problema: bin-packing (NP-difícil) → usar heurística gulosa ou otimização por ILP

---

## Arquitetura do Sistema

```
projeto/
├── calculadora_pontos/
│   ├── insumos/           # Contagens/métricas extraídas do banco EDGV por UT
│   ├── pesos/             # Tabela de pesos por classe e subfase
│   ├── calculadora.py     # Engine de cálculo de pontos
│   └── distribuidor.py    # Algoritmo de distribuição entre operadores
├── api/
│   ├── endpoints/         # REST endpoints para o frontend
│   └── models/            # Modelos de dados
├── banco/
│   ├── edgv_300_topo_14.sql    # Schema EDGV
│   └── lp_cdgv_edgv_30topo14.json  # Linha de produção
└── frontend/
    └── calculadora_ui/    # Interface de configuração de pesos e visualização
```

---

## Tabela de Pesos — Versão Inicial (a calibrar)

Esta tabela é o **coração do sistema**. Os pesos iniciais são estimativas a serem refinadas com dados históricos de produção.

### Por tipo de geometria

| Geometria | Peso base | Justificativa |
|-----------|-----------|---------------|
| Ponto | 1.0 | Referência |
| Linha (por km) | 2.5 | Vetorização de linhas é mais trabalhosa |
| Polígono (por m²) | 1.8 | Delimitação de área |
| Polígono (por unidade) | 3.0 | Se contagem for mais relevante que área |

### Por subfase (multiplicador)

| Subfase | Multiplicador | Observação |
|---------|--------------|------------|
| Extração de Ferrovia | 1.2 | Poucos elementos, alta precisão |
| Extração da Hidrografia e Altimetria | 2.5 | Alto volume, curvas de nível |
| Extração de Topônimos | 1.5 | Trabalho textual + posicionamento |
| Extração de Vias de Deslocamento | 2.0 | Alto volume linear |
| Extração de Elemento Hidrográfico | 1.8 | |
| Extração de Área sem Dados | 0.8 | Geralmente rápido |
| Extração de Limites | 1.5 | |
| Extração de Interseção de Hidrografia e Transporte | 1.3 | |
| Extração de Área Edificada | 1.6 | |
| Extração de Edificação | 1.4 | Alta densidade pontual em áreas urbanas |
| Extração de Vegetação | 2.0 | |
| Extração de Planimetria | 1.8 | Muitas classes |
| Verificação Final | 1.0× total | Proporcional ao volume total da UT |

---

## Próximos Passos

### Fase 1 — Levantamento de insumos
- [ ] Criar queries SQL para extrair contagens por UT e por classe EDGV
- [ ] Definir a granularidade: por UT? por folha? por lote?
- [ ] Criar tabela `insumos_ut` no banco com as métricas agregadas

### Fase 2 — Calibração de pesos
- [ ] Registrar tempos reais de produção de UTs históricas
- [ ] Fazer regressão para calibrar os pesos por classe
- [ ] Criar interface para ajuste manual de pesos pelo supervisor

### Fase 3 — Calculadora e distribuição
- [ ] Implementar engine de cálculo de pontos
- [ ] Implementar algoritmo de distribuição (greedy first-fit decreasing)
- [ ] Criar visualização do balanceamento (gráfico de barras por operador)

### Fase 4 — Integração com o sistema de planejamento
- [ ] Integrar pontuação com criação de unidades de trabalho
- [ ] Alertas quando desequilíbrio > X% entre operadores
- [ ] Dashboard de produtividade real vs. pontos estimados

---

## Convenções e Decisões Técnicas

- **Linguagem principal:** Python (backend) + SQL (queries EDGV)
- **Banco:** PostgreSQL com PostGIS
- **Referência de linha de produção:** sempre usar `lp_cdgv_edgv_30topo14.json` como fonte de verdade
- **Schema EDGV:** sempre prefixar tabelas com `edgv.` conforme o SQL de referência
- **Pesos são versionados:** cada versão de tabela de pesos deve ter timestamp e autor
- **Distribuição automática é sugestão:** o supervisor sempre pode redistribuir manualmente

---

## Glossário

| Termo | Significado |
|-------|-------------|
| UT | Unidade de Trabalho — menor unidade de planejamento, coberta por um operador |
| EDGV | Estrutura de Dados Geoespaciais Vetoriais — padrão BDGEx |
| LP | Linha de Produção |
| Subfase | Divisão temática dentro de uma fase de produção |
| Pontos | Unidade abstrata de esforço estimado para uma UT |
| Insumo | Dado quantitativo extraído do banco EDGV (contagem, comprimento, área) |
| Balanceamento | Distribuição equilibrada de pontos entre operadores |
