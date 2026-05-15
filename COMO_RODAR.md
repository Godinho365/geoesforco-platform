# Como Rodar — GeoEsforço

Sistema de cálculo de pontos por Unidade de Trabalho (UT) para produção de cartas topográficas EDGV 3.0 Topo 1.4.

---

## Pré-requisitos

| Ferramenta | Versão mínima | Para quê |
|------------|--------------|----------|
| PostgreSQL + PostGIS | 14+ / 3.0+ | Banco de dados espacial |
| Node.js | 18+ | Interface web |
| Python | 3.10+ | Script de linha de comando (opcional) |
| psycopg2-binary | qualquer | Apenas para o script Python |

---

## Estrutura do projeto

```
GeoEsforço/
├── CLAUDE.md                          ← Documentação do sistema
├── COMO_RODAR.md                      ← Este arquivo
├── geoesforco_sprints.md              ← Planejamento de sprints
│
├── calculadora_pontos/
│   ├── calculadora.py                 ← Script Python (linha de comando)
│   ├── mapeamento_camadas.json        ← Camadas EDGV → subfases
│   ├── pesos/
│   │   └── pesos_v1.json             ← Tabela de pesos (calibrável)
│   └── insumos/
│       └── exemplo_ut_scores.json    ← Último output gerado
│
├── banco/
│   └── queries/
│       ├── descobrir_schema.sql       ← Inspecionar o banco EDGV
│       └── extrair_metricas.sql       ← Template SQL de métricas
│
└── geoesforco-ui/                     ← Interface web Node.js
    ├── package.json
    ├── server.js
    ├── src/
    │   ├── db.js                      ← Conexões SAP + EDGV
    │   ├── calculadora.js             ← Engine de cálculo (JS)
    │   └── routes.js                  ← API REST
    └── public/
        ├── index.html
        ├── app.js
        └── style.css
```

---

## Opção 1 — Interface Web (recomendado)

### 1. Instalar dependências

```bash
cd geoesforco-ui
npm install
```

### 2. Configurar banco de dados (opcional)

Por padrão o sistema usa:
- **SAP:** `localhost:5432/sap` (usuário `postgres`, senha `postgres`)
- **EDGV:** `localhost:5432/0734_1_2025_12_03_Andre`

Para usar outros valores, crie um arquivo `.env` dentro de `geoesforco-ui/`:

```env
PG_HOST=localhost
PG_PORT=5432
PG_USER=postgres
PG_PASSWORD=postgres

SAP_DB=sap
EDGV_DB=0734_1_2025_12_03_Andre
```

> **Nota:** O arquivo `.env` não é carregado automaticamente. Para usá-lo, instale `dotenv`:
> ```bash
> npm install dotenv
> ```
> E adicione `require('dotenv').config()` no topo do `server.js`.

### 3. Iniciar o servidor

```bash
# Produção
node server.js

# Desenvolvimento (reinicia ao salvar)
node --watch server.js
```

### 4. Acessar no navegador

```
http://localhost:3000
```

---

## Opção 2 — Script Python (linha de comando)

Útil para rodar em batch ou integrar em pipelines.

### 1. Instalar dependência

```bash
pip install psycopg2-binary
```

### 2. Rodar

```bash
cd GeoEsforço
python calculadora_pontos/calculadora.py
```

O script usa o banco `0734_1_2025_12_03_Andre` por padrão, divide a moldura em 3 UTs virtuais e calcula o score de cada uma.

**Parâmetros disponíveis:**

```bash
python calculadora_pontos/calculadora.py \
  --host localhost \
  --port 5432 \
  --db NOME_DO_BANCO \
  --user postgres \
  --password postgres
```

**Output:**
- Imprime tabela de scores no terminal
- Salva `calculadora_pontos/insumos/exemplo_ut_scores.json`

---

## Como usar a interface web

### Calcular por UT do SAP

1. Clique na aba **Do SAP**
2. Selecione a UT no dropdown
3. Clique em **Carregar UT selecionada** — a UT aparece no mapa
4. Clique em **Calcular Pontos**
5. O resultado aparece no painel com breakdown por subfase

### Calcular por área desenhada no mapa

1. Clique na aba **Desenhar no mapa**
2. Use a ferramenta de polígono no mapa (ícone no canto superior direito)
3. Desenhe a área da UT
4. Clique em **Calcular Pontos**

### Calcular por arquivo GeoJSON

1. Clique na aba **Carregar arquivo**
2. Selecione um arquivo `.geojson` ou `.json`
3. O arquivo deve conter um `Polygon` ou `MultiPolygon`
4. Clique em **Calcular Pontos**

### Exportar resultado

Após calcular, clique em **Exportar JSON** para baixar o breakdown completo em JSON.

---

## API REST

A interface web consome os seguintes endpoints:

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| `GET` | `/api/moldura` | Moldura do banco EDGV como GeoJSON |
| `GET` | `/api/uts` | Lista de UTs do SAP (FeatureCollection) |
| `GET` | `/api/uts/:id` | UT específica do SAP |
| `POST` | `/api/calcular` | Calcula score para uma geometria |

### POST /api/calcular — exemplos

**Por UT do SAP:**
```json
{ "ut_id": 42 }
```

**Por geometria GeoJSON:**
```json
{
  "geojson": {
    "type": "Polygon",
    "coordinates": [[[-47.5, -4.25], [-47.25, -4.25], [-47.25, -4.0], [-47.5, -4.0], [-47.5, -4.25]]]
  }
}
```

**Resposta:**
```json
{
  "score_total": 449575.76,
  "versao_pesos": "1.0",
  "por_subfase": {
    "ext_vegetacao": 194406.13,
    "ext_hidrografia_altimetria": 22176.23,
    "ext_vias_deslocamento": 2556.19,
    "ext_edificacao": 2412.0,
    "verificacao_final": 224787.88
  }
}
```

---

## Ajustar pesos

Edite `calculadora_pontos/pesos/pesos_v1.json` para calibrar os pesos.

```json
{
  "versao": "1.0",
  "pesos_geometria": {
    "qtd": 1.0,
    "km":  2.5,
    "ha":  1.8
  },
  "multiplicadores_subfase": {
    "ext_hidrografia_altimetria": { "id": 2, "valor": 2.5 },
    "ext_vias_deslocamento":      { "id": 4, "valor": 2.0 }
  }
}
```

A interface web e o script Python leem este arquivo a cada execução — **não é necessário reiniciar o servidor** para que novos pesos entrem em vigor.

---

## Trocar o banco EDGV

Para usar um banco EDGV diferente (ex.: outro projeto cartográfico):

1. Edite `geoesforco-ui/src/db.js`:
   ```js
   database: process.env.EDGV_DB || 'NOME_DO_NOVO_BANCO'
   ```
2. Confirme os nomes das tabelas rodando:
   ```sql
   -- No pgAdmin ou psql, conectado ao novo banco:
   \i banco/queries/descobrir_schema.sql
   ```
3. Atualize `calculadora_pontos/mapeamento_camadas.json` se os nomes diferirem.

---

## Portas padrão

| Serviço | Porta |
|---------|-------|
| Interface web | `http://localhost:3000` |
| PostgreSQL | `5432` |
