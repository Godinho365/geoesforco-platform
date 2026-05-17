/* ════════════════════════════════════════
   GeoEsforço — Frontend
════════════════════════════════════════ */

// ── Histórico de cálculos (localStorage) ─────────────────────────────────────
const GECalcStore = (() => {
  const KEY = 'ge_calculos_v1';
  const MAX = 150;
  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (_) { return []; }
  }
  function save(entry) {
    let list = load();
    list.unshift({ id: Date.now().toString(36), salvo_em: new Date().toISOString(), ...entry });
    if (list.length > MAX) list = list.slice(0, MAX);
    try { localStorage.setItem(KEY, JSON.stringify(list)); }
    catch (_) {
      // quota excedida: corta metade e tenta novamente
      try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, Math.floor(MAX / 2)))); } catch (__) {}
    }
  }
  function remove(id) {
    localStorage.setItem(KEY, JSON.stringify(load().filter(e => e.id !== id)));
  }
  function clear() { localStorage.removeItem(KEY); }
  return { load, save, remove, clear };
})();

// ── Mapa ──────────────────────────────────────────────────────────────
const map = L.map('map', { center: [-15, -52], zoom: 5, zoomControl: false });

// Camadas base
const tileOSM = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
  maxZoom: 19,
});
const tileSat = L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
  attribution: '© Google',
  maxZoom: 20,
  subdomains: ['mt0','mt1','mt2','mt3'],
});
let activeBase = 'osm';
tileOSM.addTo(map);

// Controle de zoom — canto inferior direito para não conflitar
L.control.zoom({ position: 'bottomright' }).addTo(map);

// Controle de fundo — OSM / Satélite
const BaseControl = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    const div = L.DomUtil.create('div', 'map-base-ctrl leaflet-bar');
    div.innerHTML =
      `<button class="mbc-btn mbc-active" data-b="osm">OSM</button>` +
      `<button class="mbc-btn" data-b="sat">🛰 Satélite</button>`;
    L.DomEvent.disableClickPropagation(div);
    div.querySelectorAll('.mbc-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const b = btn.dataset.b;
        if (b === activeBase) return;
        if (activeBase === 'osm') { map.removeLayer(tileOSM); tileSat.addTo(map); tileSat.setZIndex(0); }
        else                      { map.removeLayer(tileSat);  tileOSM.addTo(map); tileOSM.setZIndex(0); }
        activeBase = b;
        div.querySelectorAll('.mbc-btn').forEach(x => x.classList.toggle('mbc-active', x.dataset.b === b));
      });
    });
    return div;
  },
});
new BaseControl().addTo(map);

// ── Legenda de pontuação + filtro por range (visível somente após lote) ──
let _legendMin = 0, _legendMax = 1;

const LegendControl = L.Control.extend({
  options: { position: 'bottomleft' },
  onAdd() {
    const div = L.DomUtil.create('div', 'map-legend leaflet-bar hidden');
    div.innerHTML = `
      <div class="legend-title">Pontuação das UTs</div>
      <div class="legend-gradient"></div>
      <div class="legend-labels">
        <span id="legend-min" class="legend-val">–</span>
        <span class="legend-axis">Baixo → Alto</span>
        <span id="legend-max" class="legend-val">–</span>
      </div>
      <div class="lf-ctrl">
        <button id="btn-lf-toggle" class="lf-toggle-btn">🎚 Filtrar</button>
        <div id="lf-inputs" class="hidden">
          <div class="lf-row"><span class="lf-lbl">Mín</span><input type="range" id="lf-min" class="lf-range" min="0" max="100" value="0"></div>
          <div class="lf-row"><span class="lf-lbl">Máx</span><input type="range" id="lf-max" class="lf-range" min="0" max="100" value="100"></div>
          <div id="lf-info" class="lf-info"></div>
        </div>
      </div>`;
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);

    div.querySelector('#btn-lf-toggle').addEventListener('click', () => {
      const inputs  = div.querySelector('#lf-inputs');
      const nowOpen = !inputs.classList.contains('hidden');
      inputs.classList.toggle('hidden');
      div.querySelector('#btn-lf-toggle').textContent = nowOpen ? '🎚 Filtrar' : '✕ Limpar filtro';
      if (nowOpen) {
        // Fechou: reset sliders e restaura todos
        div.querySelector('#lf-min').value = '0';
        div.querySelector('#lf-max').value = '100';
      }
      applyLegendFilter();
    });
    div.querySelector('#lf-min').addEventListener('input', applyLegendFilter);
    div.querySelector('#lf-max').addEventListener('input', applyLegendFilter);

    // U3 · Tooltips nos sliders — mostrar valor absoluto
    const getLabel = pct => {
      const abs = _legendMin + pct * (_legendMax - _legendMin || 1);
      return Math.round(abs).toLocaleString('pt-BR');
    };
    attachSliderTooltip(div.querySelector('#lf-min'), getLabel);
    attachSliderTooltip(div.querySelector('#lf-max'), getLabel);

    return div;
  },
});
const mapLegend = new LegendControl().addTo(map);

function applyLegendFilter() {
  const minSlider = document.getElementById('lf-min');
  const maxSlider = document.getElementById('lf-max');
  const infoEl    = document.getElementById('lf-info');
  if (!minSlider || !maxSlider) return;

  const pctMin = parseInt(minSlider.value) / 100;
  const pctMax = parseInt(maxSlider.value) / 100;
  const range  = _legendMax - _legendMin || 1;
  const absMin = _legendMin + pctMin * range;
  const absMax = _legendMin + pctMax * range;

  const fmt = v => Math.round(v).toLocaleString('pt-BR');
  if (infoEl) infoEl.textContent = `${fmt(absMin)} – ${fmt(absMax)} pts`;

  batchLayer.eachLayer(geoJsonLayer => {
    // Tenta obter ut_id direto da feature (L.geoJSON wrapping a single Feature)
    // ou percorrendo sub-layers (L.GeoJSON contendo Polygons)
    let ut_id = geoJsonLayer.feature?.properties?.ut_id ?? null;
    if (ut_id == null && typeof geoJsonLayer.eachLayer === 'function') {
      geoJsonLayer.eachLayer(sub => {
        if (ut_id == null && sub.feature?.properties?.ut_id != null)
          ut_id = sub.feature.properties.ut_id;
      });
    }
    const r   = ut_id != null ? batchResultById.get(ut_id) : null;
    const pts = r ? subtotalPts(r) : 0;
    const ok  = pts >= absMin && pts <= absMax;
    geoJsonLayer.setStyle({ opacity: ok ? 1 : 0.06, fillOpacity: ok ? 0.65 : 0.06 });
  });

  // Aplicar também ao layer de arquivo (resultado lote arquivo)
  if (_arquivoResults.length > 0) {
    _arquivoResults.forEach(({ index, result, erro }) => {
      const lyr = _arquivoIndivLayers[index];
      if (!lyr || erro) return;
      const pts = subtotalPts(result);
      const ok  = pts >= absMin && pts <= absMax;
      lyr.setStyle({ opacity: ok ? 1 : 0.06, fillOpacity: ok ? 0.65 : 0.06 });
    });
  }
}

function showLegend(minPts, maxPts) {
  _legendMin = minPts;
  _legendMax = maxPts;
  const el = document.querySelector('.map-legend');
  if (!el) return;
  const fmt = v => Number.isFinite(v) ? v.toLocaleString('pt-BR', { maximumFractionDigits: 0 }) : '–';
  document.getElementById('legend-min').textContent = fmt(minPts);
  document.getElementById('legend-max').textContent = fmt(maxPts);
  // Reset filtro
  const minS = document.getElementById('lf-min');
  const maxS = document.getElementById('lf-max');
  const lfI  = document.getElementById('lf-inputs');
  const lfT  = document.getElementById('btn-lf-toggle');
  if (minS) minS.value = '0';
  if (maxS) maxS.value = '100';
  if (lfI)  lfI.classList.add('hidden');
  if (lfT)  lfT.textContent = '🎚 Filtrar';
  el.classList.remove('hidden');
}

function hideLegend() {
  document.querySelector('.map-legend')?.classList.add('hidden');
  // Restaura opacidade de todas as layers
  batchLayer.eachLayer(l => l.setStyle({ opacity: 1, fillOpacity: 0.65 }));
}

const molduraLayer  = L.geoJSON(null, {
  style: { color: '#4fc3f7', weight: 2, fillOpacity: 0.04, dashArray: '6 4' },
}).addTo(map);
// Camada de preview: todas as UTs do filtro lote+subfase
const filterLayer = L.geoJSON(null, {
  style: { color: '#4fc3f7', weight: 1.5, fillColor: '#4fc3f7', fillOpacity: 0.08 },
  onEachFeature(feature, layer) {
    const p = feature.properties;
    const esc = p.denominador_escala
      ? `<br><span style="color:#ffb74d">1:${Number(p.denominador_escala).toLocaleString('pt-BR')}</span>` : '';
    layer.bindTooltip(
      `<strong>${p.nome}</strong>${esc}<br><span style="color:#aaa;font-size:11px">${p.subfase_nome || ''}</span>`,
      { sticky: true }
    );
    layer.on('click', () => selecionarUt(p.id));
  },
}).addTo(map);
const utLayer    = L.geoJSON(null, { style: { color: '#ff9800', weight: 2.5, fillOpacity: 0.25 } }).addTo(map);
const batchLayer = L.geoJSON(null).addTo(map);  // cada feature tem style próprio
const drawnLayer = new L.FeatureGroup().addTo(map);

// Camada de vetores EDGV (linhas, pontos, áreas das camadas calculadas)
const vetoresLayer = L.geoJSON(null, {
  style: feat => {
    const tipo = feat.properties?.tipo;
    if (tipo === 'linha') return { color: '#00e5ff', weight: 1.8, opacity: 0.85, fillOpacity: 0 };
    if (tipo === 'area')  return { color: '#69f0ae', weight: 1,   opacity: 0.7,  fillColor: '#69f0ae', fillOpacity: 0.15 };
    return {};
  },
  pointToLayer: (feat, ll) => {
    const camada = feat.properties?.camada;
    // Confluências de drenagem — azul água, maior
    if (camada === 'confluencias')
      return L.circleMarker(ll, { radius: 5, color: '#fff', weight: 1.5, fillColor: '#00bcd4', fillOpacity: 0.95 });
    // Entroncamentos de vias — laranja-âmbar
    if (camada === 'entroncamentos')
      return L.circleMarker(ll, { radius: 4, color: '#fff', weight: 1,   fillColor: '#ff9800', fillOpacity: 0.95 });
    // Demais pontos EDGV — amarelo
    return L.circleMarker(ll, { radius: 4, color: '#fff', weight: 1,   fillColor: '#ffd740', fillOpacity: 0.9  });
  },
  onEachFeature(feat, layer) {
    layer.bindTooltip(`<span style="font-size:11px">${feat.properties.camada}</span>`, { sticky: true });
  },
}).addTo(map);
let vetoresAtivos = false;

const drawControl = new L.Control.Draw({
  draw: {
    polygon:   { shapeOptions: { color: '#ff9800' } },
    rectangle: { shapeOptions: { color: '#ff9800' } },
    circle: false, marker: false, polyline: false, circlemarker: false,
  },
  edit: { featureGroup: drawnLayer },
});
map.addControl(drawControl);

// ── Estado global ──────────────────────────────────────────────────────
let currentGeojson           = null;
let currentUtId              = null;
let currentUtNome            = '';
let currentSubfaseKey        = null;
let currentDenominadorEscala = null;
let currentDificuldade       = null;   // dificuldade da UT SAP selecionada
let currentProjetoId         = null;   // projeto ativo (null = todos)
let currentLpId              = null;   // linha de produção ativa (null = todas)
let curvaNivelToken          = null;   // token do arquivo de curva de nível carregado
// Estado multi-feature (SHP/GPKG com várias feições)
let _arquivoFeatures         = [];         // [{geojson, properties, index}] do arquivo atual
let _arquivoLayerGroup       = null;       // L.featureGroup com layers clicáveis
let _arquivoSelectedIndices  = new Set();  // índices das feições selecionadas (multi)
let _arquivoIndivLayers      = [];         // parallel array de layers por índice
let _arquivoCurrentFileName  = '';         // nome do arquivo aberto
let _arquivoResults          = [];         // resultados individuais após calcularArquivoLote
let lastResult               = null;
let allUTs                   = [];
let allSubfases              = [];
let allProjetos              = [];     // [{id, nome}]
let allLinhasProducao        = [];     // [{id, nome, nome_abrev, subfase_keys}]
let selectedUtId             = null;
let activeTab                = 'sap';
let lastBatchResultados      = null;
let markedUtIds              = new Set();   // UTs marcadas para lote
const batchResultById        = new Map();  // ut_id → result

// ════════════════════════════════════════════════════════════════════
// UTILITÁRIOS GLOBAIS
// ════════════════════════════════════════════════════════════════════

// U2 · Toast notifications
function showToast(msg, type = 'info', duration = 4000) {
  const c = document.getElementById('toast-container');
  if (!c) return;
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  c.appendChild(t);
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('toast-in')));
  setTimeout(() => {
    t.classList.remove('toast-in');
    t.addEventListener('transitionend', () => t.remove(), { once: true });
    setTimeout(() => t.remove(), 500);
  }, duration);
}

// V3 · Count-up animation
function animateCount(el, from, to, duration = 700) {
  if (!el) return;
  const startTs = performance.now();
  const step = ts => {
    const p    = Math.min((ts - startTs) / duration, 1);
    const ease = 1 - Math.pow(1 - p, 3); // ease-out cubic
    el.textContent = Math.round(from + (to - from) * ease).toLocaleString('pt-BR') + ' pts';
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// V4 · Cores semânticas por subfase
const SF_COLORS = {
  ext_ferrovia:                      '#ef5350',
  ext_hidrografia_altimetria:        '#29b6f6',
  ext_toponimos:                     '#ab47bc',
  ext_vias_deslocamento:             '#ff7043',
  ext_elemento_hidrografico:         '#26c6da',
  ext_area_sem_dados:                '#78909c',
  ext_limites:                       '#ffca28',
  ext_intersecao_hidro_transporte:   '#42a5f5',
  ext_area_edificada:                '#ff8a65',
  ext_edificacao:                    '#ec407a',
  ext_vegetacao:                     '#66bb6a',
  ext_planimetria:                   '#ffa726',
  verificacao_final:                 '#26a69a',
};

// D3 · Gauge SVG semicircular
function buildGaugeSVG(pct, color = '#4fc3f7') {
  const r = 32, cx = 50, cy = 42;
  const clp   = Math.max(0, Math.min(1, pct));
  const angle = clp * 180;
  const rad   = (180 - angle) * Math.PI / 180;
  const x     = cx + r * Math.cos(rad);
  const y     = cy - r * Math.sin(rad);
  const large = angle > 180 ? 1 : 0;
  const track = `M${cx - r},${cy} A${r},${r} 0 0,1 ${cx + r},${cy}`;
  const arc   = clp <= 0
    ? ''
    : `M${cx - r},${cy} A${r},${r} 0 ${large},1 ${x.toFixed(2)},${y.toFixed(2)}`;
  return `<svg viewBox="0 0 100 48" width="72" height="35" style="display:block">
    <path d="${track}" fill="none" stroke="#1a3358" stroke-width="6" stroke-linecap="round"/>
    ${arc ? `<path d="${arc}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round"/>` : ''}
  </svg>`;
}

// L2 · Drawer open/close
function openResultPanel() {
  const p = document.getElementById('panel-resultado');
  if (!p) return;
  p.classList.add('open');
  setTimeout(() => map.invalidateSize(), 310);
}
function closeResultPanel() {
  const p = document.getElementById('panel-resultado');
  if (!p) return;
  p.classList.remove('open');
  setTimeout(() => map.invalidateSize(), 310);
}

// U3 · Tooltip flutuante nos sliders
function attachSliderTooltip(slider, getLabelFn) {
  if (!slider) return;
  const row = slider.parentElement;
  if (!row) return;
  row.style.position = 'relative';
  const tip = document.createElement('div');
  tip.className = 'slider-tip';
  row.appendChild(tip);
  const update = () => {
    const pct = (slider.value - slider.min) / (slider.max - slider.min);
    tip.style.left = `calc(${(pct * 100).toFixed(1)}% + 22px)`; // offset for the label
    tip.textContent = getLabelFn ? getLabelFn(pct) : slider.value;
  };
  slider.addEventListener('input', update);
  update();
}

// L3 · Sync topbar DB chip
function syncTopbar(dbName) {
  const chip = document.getElementById('tb-db-chip');
  if (!chip) return;
  const LABELS = { insumos_oficiais: 'Oficial', insumo_osm: 'OSM' };
  chip.textContent = LABELS[dbName] || (dbName ? dbName.slice(0, 12) : '–');
}

// L3 · Set topbar health dot
function setTopbarHealth(ok) {
  const dot = document.getElementById('tb-health-dot');
  if (!dot) return;
  dot.className = `tb-dot ${ok ? 'tb-dot-ok' : 'tb-dot-warn'}`;
  dot.title = ok ? 'Banco OK' : 'Banco com tabelas faltando';
}

// ── Banco EDGV ────────────────────────────────────────────────────────
const selDb       = document.getElementById('select-edgv-db');
const customDbRow = document.getElementById('custom-db-row');
const inputDbName = document.getElementById('input-custom-db');
const btnConectar = document.getElementById('btn-conectar-db');
const dbBadge     = document.getElementById('db-badge');
const dbStatus    = document.getElementById('db-status');

function setDbBadge(db) {
  const LABELS = { insumos_oficiais: 'Oficial', insumo_osm: 'OSM' };
  dbBadge.textContent = LABELS[db] || db.slice(0, 10);
  dbBadge.className   = 'chip ' + (db === 'insumo_osm' ? 'chip-green' : 'chip-blue');
  syncTopbar(db);   // L3
}

// A5 — verifica saúde do banco EDGV (tabelas do mapeamento existem?)
async function checkEdgvHealth() {
  const healthEl = document.getElementById('db-health');
  if (!healthEl) return;
  try {
    const data = await fetch('/api/health/edgv').then(r => r.json());
    if (data.resumo?.faltando === 0) {
      healthEl.textContent = '';
      setTopbarHealth(true);   // L3
    } else {
      const n = data.resumo?.faltando ?? '?';
      healthEl.style.color  = '#ffb74d';
      healthEl.textContent  = `⚠ ${n} tabela${n !== 1 ? 's' : ''} não encontrada${n !== 1 ? 's' : ''} no banco`;
      setTopbarHealth(false);  // L3
    }
  } catch {
    healthEl.textContent = '';
  }
}

async function conectarBanco(db) {
  dbStatus.textContent = 'Conectando…';
  try {
    const res = await fetch('/api/databases/ativo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ db }),
    });
    if (!res.ok) { const e = await res.json(); dbStatus.textContent = `Erro: ${e.erro}`; showToast(`Erro ao conectar: ${e.erro}`, 'error'); return false; }
    setDbBadge(db);
    dbStatus.textContent = '';
    molduraLayer.clearLayers();
    loadMoldura();
    checkEdgvHealth();   // A5
    return true;
  } catch (e) { dbStatus.textContent = `Erro: ${e.message}`; showToast(`Erro: ${e.message}`, 'error'); return false; }
}

fetch('/api/databases/ativo')
  .then(r => r.json())
  .then(({ ativo }) => {
    const known = ['insumos_oficiais', 'insumo_osm'];
    if (known.includes(ativo)) { selDb.value = ativo; }
    else { selDb.value = '_custom'; customDbRow.classList.remove('hidden'); inputDbName.value = ativo; }
    setDbBadge(ativo);
    loadMoldura();
    checkEdgvHealth();   // A5
  })
  .catch(() => loadMoldura());

selDb.addEventListener('change', async () => {
  if (selDb.value === '_custom') { customDbRow.classList.remove('hidden'); inputDbName.focus(); }
  else { customDbRow.classList.add('hidden'); await conectarBanco(selDb.value); }
});
btnConectar.addEventListener('click', async () => {
  const db = inputDbName.value.trim();
  if (!db) return;
  btnConectar.disabled = true;
  const ok = await conectarBanco(db);
  btnConectar.disabled = false;
  if (ok) dbStatus.textContent = `Conectado: ${db}`;
});
inputDbName.addEventListener('keydown', e => { if (e.key === 'Enter') btnConectar.click(); });

// ── Tabs ──────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    activeTab = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${activeTab}`).classList.add('active');
    if (activeTab !== 'sap') {
      showSubfaseSelector(true);
      // Arquivo/Mapa: mostrar seletores de escala e LP desde o início
      showEscalaSelector();
      showLpSelector();
    } else {
      // SAP: esconder seletores de escala/LP (escala vem do lote, LP é detectada)
      hideEscalaSelector();
      hideLpSelector();
    }
    updateCalcBtn();
  });
});

// ── Seletor de escala (modos Mapa / Arquivo) ─────────────────────────────────
const escalaSelRow = document.getElementById('escala-sel-row');
const selEscala    = document.getElementById('sel-escala');

function showEscalaSelector() { escalaSelRow.classList.remove('hidden'); }
function hideEscalaSelector() { escalaSelRow.classList.add('hidden'); }

// ── Seletor de LP (modos Mapa / Arquivo) ─────────────────────────────────────
const lpSelRow = document.getElementById('lp-sel-row');
const selLp    = document.getElementById('sel-lp');

function showLpSelector() {
  if (!lpSelRow) return;
  lpSelRow.classList.remove('hidden');
  // Pré-seleciona "Topo 1.4" como padrão se nada foi selecionado ainda
  if (selLp && !selLp.value) {
    selLp.value = 'mapeamento_topo';
    updateCalcBtn();
  }
}
function hideLpSelector() { if (lpSelRow) lpSelRow.classList.add('hidden'); }

// LP key para modos Mapa/Arquivo (SAP detecta automaticamente do banco)
function getLpKey() { return selLp ? selLp.value : 'mapeamento_topo'; }

selEscala.addEventListener('change', () => {
  currentDenominadorEscala = selEscala.value ? +selEscala.value : null;
  updateCalcBtn();
});

if (selLp) selLp.addEventListener('change', () => updateCalcBtn());

// ── Subfases ──────────────────────────────────────────────────────────
const selSubfase   = document.getElementById('select-subfase');
const sfSapInfo    = document.getElementById('subfase-sap-info');
const sfSapNome    = document.getElementById('subfase-sap-nome');
const sfSelector   = document.getElementById('subfase-selector');

fetch('/api/subfases')
  .then(r => r.json())
  .then(subfases => {
    allSubfases = subfases;
    repopulateSelSubfase();   // usa allSubfases + currentLpId (null = todas)
  })
  .catch(() => { selSubfase.innerHTML = '<option value="">Erro ao carregar subfases</option>'; });

selSubfase.addEventListener('change', () => {
  currentSubfaseKey = selSubfase.value || null;
  updateCurvaNivelSection(currentSubfaseKey);
  updateCalcBtn();
});

document.getElementById('btn-trocar-subfase').addEventListener('click', () => {
  showSubfaseSelector(true); currentSubfaseKey = null;
  updateCurvaNivelSection(null);
  updateCalcBtn();
});

// Botão "✦ Total" na aba SAP — calcula todas as subfases direto sem precisar trocar
document.getElementById('btn-calcular-total-sap').addEventListener('click', async () => {
  if (!currentUtId) { showToast('Selecione uma UT primeiro.', 'warn'); return; }
  const sfKeyAnterior = currentSubfaseKey;
  currentSubfaseKey = '__all__';
  await calcularTodasSubfases();
  // Restaura a subfase original para não bagunçar o estado
  currentSubfaseKey = sfKeyAnterior;
  updateCalcBtn();
});

function showSubfaseAuto(key, nome, lpNome) {
  sfSapInfo.classList.remove('hidden');
  sfSapNome.textContent = nome;
  // Chip de LP — mostra sigla/nome da linha de produção
  const lpChip = document.getElementById('subfase-sap-lp');
  if (lpChip) {
    if (lpNome) { lpChip.textContent = lpNome; lpChip.classList.remove('hidden'); }
    else        { lpChip.textContent = '';      lpChip.classList.add('hidden');    }
  }
  sfSelector.classList.add('hidden');
  currentSubfaseKey = key;
  selSubfase.value = key || '';
  updateCurvaNivelSection(key);
}
function showSubfaseSelector(clearVal = false) {
  sfSapInfo.classList.add('hidden');
  sfSelector.classList.remove('hidden');
  repopulateSelSubfase();
  if (clearVal) { selSubfase.value = ''; currentSubfaseKey = null; updateCurvaNivelSection(null); }
}

// ── Curva de Nível — upload de arquivo externo ────────────────────────
(function () {
  const CN_SUBFASE = 'ext_hidrografia_altimetria';
  const sectionCN  = document.getElementById('section-curva-nivel');
  const cnDropLbl  = document.getElementById('cn-drop-label');
  const cnFileInp  = document.getElementById('cn-file-input');
  const cnLoading  = document.getElementById('cn-loading');
  const cnSuccess  = document.getElementById('cn-success');
  const cnError    = document.getElementById('cn-error');
  const cnInfoTxt  = document.getElementById('cn-info-txt');
  const cnErrTxt   = document.getElementById('cn-error-txt');

  function cnShowIdle()  {
    cnDropLbl.classList.remove('hidden');
    cnLoading.classList.add('hidden');
    cnSuccess.classList.add('hidden');
    cnError.classList.add('hidden');
  }
  function cnShowLoading() {
    cnDropLbl.classList.add('hidden');
    cnLoading.classList.remove('hidden');
    cnSuccess.classList.add('hidden');
    cnError.classList.add('hidden');
  }
  function cnShowSuccess(nLinhas, srid) {
    cnDropLbl.classList.add('hidden');
    cnLoading.classList.add('hidden');
    cnSuccess.classList.remove('hidden');
    cnError.classList.add('hidden');
    cnInfoTxt.textContent = `${nLinhas.toLocaleString('pt-BR')} curvas carregadas (EPSG:${srid})`;
  }
  function cnShowError(msg) {
    cnDropLbl.classList.remove('hidden');
    cnLoading.classList.add('hidden');
    cnSuccess.classList.add('hidden');
    cnError.classList.remove('hidden');
    cnErrTxt.textContent = msg;
  }

  // Exposta globalmente para que updateCurvaNivelSection() a veja
  window.updateCurvaNivelSection = function (sfKey) {
    if (sfKey === CN_SUBFASE) {
      sectionCN.classList.remove('hidden');
    } else {
      sectionCN.classList.add('hidden');
      if (curvaNivelToken) {
        curvaNivelToken = null;
        cnFileInp.value = '';
        cnShowIdle();
      }
    }
  };

  async function uploadCurvaNivel(file) {
    cnShowLoading();
    const fd = new FormData();
    fd.append('curva_nivel', file);
    try {
      const res  = await fetch('/api/curva-nivel/parse', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) { cnShowError(data.erro || `Erro ${res.status}`); return; }
      curvaNivelToken = data.token;
      cnShowSuccess(data.nLinhas, data.srid);
    } catch (err) {
      cnShowError(`Erro ao processar: ${err.message}`);
    }
  }

  cnFileInp.addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    uploadCurvaNivel(f);
  });

  document.getElementById('btn-cn-remover').addEventListener('click', () => {
    curvaNivelToken = null;
    cnFileInp.value = '';
    cnShowIdle();
  });

  document.getElementById('btn-cn-retry').addEventListener('click', () => {
    cnShowIdle();
    cnFileInp.value = '';
  });
})();

// ── Moldura EDGV ──────────────────────────────────────────────────────
function loadMoldura() {
  fetch('/api/moldura').then(r => r.json()).then(f => {
    if (!f) return;
    molduraLayer.clearLayers().addData(f);
    map.fitBounds(molduraLayer.getBounds(), { padding: [20, 20] });
  }).catch(() => {});
}

// ── U5 · Skeleton loading na lista de UTs ────────────────────────────
;(function() {
  const lista = document.getElementById('ut-lista');
  if (lista) {
    lista.innerHTML = Array(6).fill(
      `<div class="skel-row">
        <div class="skel-line skel-w70"></div>
        <div class="skel-line skel-w40"></div>
      </div>`
    ).join('');
  }
})();

// ── Lista UTs (SAP) ───────────────────────────────────────────────────
const searchInp      = document.getElementById('search-ut');
const filterProjeto  = document.getElementById('filter-projeto');
const filterLp       = document.getElementById('filter-lp');
const filterLote     = document.getElementById('filter-lote');
const filterSf       = document.getElementById('filter-subfase-sap');
const utLista        = document.getElementById('ut-lista');
const sapStatus      = document.getElementById('sap-status');
const selectLpManual = document.getElementById('select-lp-manual');

// ── Helpers de opção ─────────────────────────────────────────────────────
function makeOpt(value, text) {
  return Object.assign(document.createElement('option'), { value, textContent: text });
}

// ── Índice canônico de subfases (construído uma vez após carregar allUTs) ─────
// Problema: diferentes LPs têm subfases com mesmo nome mas subfase_id distintos.
// Solução: agrupar por nome, eleger uma key canônica por grupo (prefere key mapeada),
//          e manter o inverso (key canônica → Set de subfase_ids) para filtrar.
let _sfIdToKey    = new Map();  // subfase_id → key canônica do grupo
let _sfKeyToIds   = new Map();  // key canônica → Set<subfase_id>

function buildSfIdToKey() {
  _sfIdToKey  = new Map();
  _sfKeyToIds = new Map();

  // 1) key inicial por ID: mapeada se disponível, senão "id_N"
  const idToRawKey = new Map();
  allUTs.forEach(u => {
    if (!u.subfase_id) return;
    const id = Number(u.subfase_id);
    if (!idToRawKey.has(id))
      idToRawKey.set(id, u.subfase_key || `id_${id}`);
    else if (!idToRawKey.get(id).startsWith('id_') === false && u.subfase_key)
      idToRawKey.set(id, u.subfase_key);  // promove para key mapeada
  });

  // 2) agrupa IDs pelo subfase_nome para eleger key canônica do grupo
  const nomeToIds = new Map();   // nome → [id, ...]
  allUTs.forEach(u => {
    if (!u.subfase_id || !u.subfase_nome) return;
    const id = Number(u.subfase_id);
    const arr = nomeToIds.get(u.subfase_nome) || [];
    if (!arr.includes(id)) arr.push(id);
    nomeToIds.set(u.subfase_nome, arr);
  });

  // 3) por grupo de nome: escolhe key canônica (mapeada > id_N)
  nomeToIds.forEach((ids) => {
    const mapped = ids.map(id => idToRawKey.get(id) || `id_${id}`);
    const canon  = mapped.find(k => !k.startsWith('id_')) || mapped[0];
    ids.forEach(id => _sfIdToKey.set(id, canon));
    if (!_sfKeyToIds.has(canon)) _sfKeyToIds.set(canon, new Set());
    ids.forEach(id => _sfKeyToIds.get(canon).add(id));
  });
}

function utSfKey(u) {
  return u.subfase_id ? (_sfIdToKey.get(Number(u.subfase_id)) ?? null) : null;
}

// ── Popula todos os dropdowns em cascata (lê currentProjetoId + currentLpId)
function populateFilterDropdowns() {
  const pId  = currentProjetoId;
  const lpId = currentLpId;

  // ① LP dropdown — derivado das UTs (não depende de allLinhasProducao)
  const lpsNoProjeto = new Map();
  allUTs
    .filter(u => !pId || u.projeto_id === pId)
    .forEach(u => {
      if (u.linha_producao_id && !lpsNoProjeto.has(u.linha_producao_id)) {
        const lp = allLinhasProducao.find(l => l.id === u.linha_producao_id);
        lpsNoProjeto.set(u.linha_producao_id, lp ? (lp.nome_abrev || lp.nome) : `LP ${u.linha_producao_id}`);
      }
    });
  const prevLp = filterLp.value;
  filterLp.innerHTML = '<option value="">Todas as linhas de produção</option>';
  [...lpsNoProjeto.entries()]
    .sort((a, b) => (a[1]||'').localeCompare(b[1]||''))
    .forEach(([id, nome]) => filterLp.appendChild(makeOpt(id, nome)));
  if (prevLp && lpsNoProjeto.has(Number(prevLp))) filterLp.value = prevLp;
  else if (currentLpId && !lpsNoProjeto.has(currentLpId)) {
    currentLpId = null; filterLp.value = ''; syncLpSelects();
  }

  // ② Lote dropdown — lotes nas UTs filtradas por projeto + LP (sem nulos)
  const utsSrc = allUTs.filter(u =>
    (!pId  || u.projeto_id        === pId) &&
    (!lpId || u.linha_producao_id === lpId)
  );
  const lotesMap = new Map(
    utsSrc
      .filter(u => u.lote_id != null && u.lote)
      .map(u => [Number(u.lote_id), u.lote])
  );
  const prevLote = filterLote.value;
  filterLote.innerHTML = '<option value="">Todos os lotes</option>';
  [...lotesMap.entries()]
    .sort((a, b) => (a[1]||'').localeCompare(b[1]||''))
    .forEach(([id, nome]) => filterLote.appendChild(makeOpt(id, nome)));
  if (prevLote && lotesMap.has(Number(prevLote))) filterLote.value = prevLote;

  // ③ Subfase dropdown — deduplicado por nome, preferindo key mapeada sobre id_N
  // (LPs diferentes podem ter subfases com mesmo nome mas subfase_id distintos)
  const sfByNome = new Map();  // nome → { key, mapped }
  utsSrc.forEach(u => {
    const key  = utSfKey(u);
    const nome = u.subfase_nome;
    if (!key || !nome) return;
    const mapped = !key.startsWith('id_');
    const cur = sfByNome.get(nome);
    if (!cur || (!cur.mapped && mapped)) sfByNome.set(nome, { key, mapped });
  });
  // Inverte: key → nome  (garante também que keys duplicadas com nomes diferentes coexistam)
  const sfMap = new Map([...sfByNome.values()].map(({ key }) => [key, '']));
  sfByNome.forEach((v, nome) => sfMap.set(v.key, nome));

  const prevSf = filterSf.value;
  filterSf.innerHTML = '<option value="">Todas as subfases</option>';
  [...sfMap.entries()]
    .sort((a, b) => (a[1]||'').localeCompare(b[1]||''))
    .forEach(([key, nome]) => filterSf.appendChild(makeOpt(key, nome)));
  if (prevSf && sfMap.has(prevSf)) filterSf.value = prevSf;
}

// ── Popula selSubfase (modo manual) filtrado por LP ────────────────────────
function repopulateSelSubfase() {
  const lpKeys = currentLpId
    ? (allLinhasProducao.find(lp => lp.id === currentLpId)?.subfase_keys || null)
    : null;
  // Filtra por LP apenas se lpKeys for array não-vazio; caso contrário mostra todas
  const filtered = (lpKeys && lpKeys.length > 0)
    ? allSubfases.filter(s => lpKeys.includes(s.key))
    : allSubfases;
  const prev = selSubfase.value;
  selSubfase.innerHTML = '<option value="">Selecione a subfase…</option>';
  filtered.forEach(s => {
    selSubfase.appendChild(makeOpt(s.key, s.nome));
  });
  // Opção especial para calcular todas as subfases de uma vez (Total MI)
  const optAll = document.createElement('option');
  optAll.value = '__all__';
  optAll.textContent = '✦ Todas as subfases (Total)';
  selSubfase.appendChild(optAll);
  if (prev) selSubfase.value = prev;
}

// ── Sincroniza os dois selects de LP (SAP tab + manual) sem disparar eventos
function syncLpSelects() {
  const v = currentLpId?.toString() || '';
  if (filterLp.value     !== v) filterLp.value     = v;
  if (selectLpManual.value !== v) selectLpManual.value = v;
}

// ── Muda o projeto ativo ───────────────────────────────────────────────────
function setCurrentProjeto(projetoId) {
  currentProjetoId = projetoId ? Number(projetoId) : null;
  if (filterProjeto.value !== (currentProjetoId?.toString() || ''))
    filterProjeto.value = currentProjetoId || '';
  // Reseta LP e lote se mudou o projeto
  currentLpId = null;
  syncLpSelects();
  filterLote.value = '';
  filterSf.value   = '';
  populateFilterDropdowns();
  repopulateSelSubfase();
}

// ── Muda o LP ativo (sincroniza os dois selects e atualiza filtros) ────────
function setCurrentLp(lpId) {
  currentLpId = lpId ? Number(lpId) : null;
  syncLpSelects();
  populateFilterDropdowns();
  repopulateSelSubfase();
}

// ── Define Projeto + LP atomicamente (evita dois ciclos de populateFilter) ─
function setCurrentProjetoLp(projetoId, lpId) {
  currentProjetoId = projetoId ? Number(projetoId) : null;
  currentLpId      = lpId      ? Number(lpId)      : null;
  if (filterProjeto.value !== (currentProjetoId?.toString() || ''))
    filterProjeto.value = currentProjetoId || '';
  syncLpSelects();
  populateFilterDropdowns();
  repopulateSelSubfase();
  saveState();   // C4
}

// ── Carrega dados do SAP na inicialização ────────────────────────────────────
// Promise.allSettled: aguarda os 3 fetches (sucesso ou falha) antes de popular.
Promise.allSettled([
  fetch('/api/projetos').then(r => r.json()),
  fetch('/api/linhas-producao').then(r => r.json()),
  fetch('/api/uts/lista').then(r => r.json()),
]).then(([projRes, lpRes, utRes]) => {

  // Projetos
  if (projRes.status === 'fulfilled' && Array.isArray(projRes.value))
    allProjetos = projRes.value;
  else console.warn('[Projetos]', projRes.reason?.message || projRes.value);

  // Linhas de produção
  if (lpRes.status === 'fulfilled' && Array.isArray(lpRes.value))
    allLinhasProducao = lpRes.value;
  else console.warn('[LP]', lpRes.reason?.message || lpRes.value);

  // UTs — obrigatório
  if (utRes.status === 'fulfilled' && Array.isArray(utRes.value)) {
    allUTs = utRes.value;
    buildSfIdToKey();   // normaliza keys de subfase
  } else {
    const msg = utRes.reason?.message || (utRes.value?.erro ?? 'erro desconhecido');
    utLista.innerHTML = `<p class="empty-msg">Erro ao carregar UTs: ${msg}</p>`;
    return;
  }

  // Popula select de Projeto
  allProjetos.forEach(p => filterProjeto.appendChild(makeOpt(p.id, p.nome)));

  // Popula select de LP manual (o filterLp é populado dentro de populateFilterDropdowns)
  allLinhasProducao.forEach(lp =>
    selectLpManual.appendChild(makeOpt(lp.id, lp.nome_abrev || lp.nome))
  );

  if (!allUTs.length) {
    utLista.innerHTML = '<p class="empty-msg">Nenhuma UT no SAP.</p>';
    _stateLoaded = true;
    return;
  }
  populateFilterDropdowns();

  // C4 — restaurar sessão salva
  (function restoreState() {
    const s = loadSavedState();
    if (!s || !Object.keys(s).length) return;
    if (s.projetoId || s.lpId) setCurrentProjetoLp(s.projetoId, s.lpId);
    if (s.loteId && [...filterLote.options].some(o => o.value === s.loteId))
      filterLote.value = s.loteId;
    if (s.sfKey && [...filterSf.options].some(o => o.value === s.sfKey))
      filterSf.value = s.sfKey;
    if (Array.isArray(s.markedUtIds) && s.markedUtIds.length) {
      const validIds = new Set(allUTs.map(u => u.id));
      s.markedUtIds.forEach(id => { if (validIds.has(id)) markedUtIds.add(id); });
      if (markedUtIds.size) atualizarEstadoMarcacao();
    }
    if (s.loteId || s.sfKey) {
      loadFilteredGeometries();
      atualizarPreviewFiltro();
    }
  })();

  _stateLoaded = true;
  sapStatus.textContent = `${allUTs.length} UTs no SAP.`;
  renderUtLista();
});

function getUtsFiltradas() {
  const q    = searchInp.value.trim().toLowerCase();
  const pId  = currentProjetoId;
  const lpId = currentLpId;
  const lId  = filterLote.value ? parseInt(filterLote.value) : null;
  const sfK  = filterSf.value || null;
  // Set de subfase_ids que pertencem à key canônica selecionada
  const sfIds = sfK ? (_sfKeyToIds.get(sfK) ?? new Set()) : null;
  return allUTs.filter(u => {
    if (q    && !(u.nome ?? '').toLowerCase().includes(q))    return false;
    if (pId  && u.projeto_id        !== pId)                 return false;
    if (lpId && u.linha_producao_id !== lpId)                return false;
    if (lId  && Number(u.lote_id)   !== lId)                 return false;
    if (sfIds && !sfIds.has(Number(u.subfase_id)))           return false;
    return true;
  });
}

function renderUtLista() {
  const filt = getUtsFiltradas();
  if (!filt.length) {
    utLista.innerHTML = '<div class="empty-state"><span class="empty-state-icon">🔍</span><p>Nenhuma UT encontrada</p></div>';
    return;
  }
  const MAX  = 80;
  const show = filt.slice(0, MAX);
  utLista.innerHTML = show.map(u => {
    const esc     = u.denominador_escala ? `1:${u.denominador_escala.toLocaleString('pt-BR')}` : '';
    const isSel   = u.id === selectedUtId;
    const isMark  = markedUtIds.has(u.id);
    const classes = ['ut-item', isSel && 'selected', isMark && 'marked'].filter(Boolean).join(' ');
    const check   = isMark ? '✓ ' : '';
    return `<div class="${classes}" data-id="${u.id}">
      <div class="ut-item-nome">${check}${u.nome}</div>
      <div class="ut-item-meta">
        <span>${u.lote || '–'}</span>
        <span>${u.subfase_nome || '–'}</span>
        ${esc ? `<span class="escala-tag">${esc}</span>` : ''}
      </div>
    </div>`;
  }).join('');
  if (filt.length > MAX)
    utLista.insertAdjacentHTML('beforeend',
      `<p class="empty-msg">+${filt.length - MAX} — refine a busca</p>`);
  utLista.querySelectorAll('.ut-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = parseInt(el.dataset.id);
      if (markedUtIds.size > 0) {
        // modo marcação: toggle individual
        if (markedUtIds.has(id)) markedUtIds.delete(id); else markedUtIds.add(id);
        atualizarEstadoMarcacao();
      } else {
        selecionarUt(id);
      }
    });
  });
}

let _debounce;
searchInp.addEventListener('input', () => { clearTimeout(_debounce); _debounce = setTimeout(onFilter, 180); });
filterProjeto.addEventListener('change', () => {
  setCurrentProjeto(filterProjeto.value || null);
  onFilterComMapa();
});
filterLp.addEventListener('change', () => {
  setCurrentLp(filterLp.value || null);
  onFilterComMapa();
});
filterLote.addEventListener('change', onFilterComMapa);
filterSf.addEventListener('change', onFilterComMapa);

// Checkbox "Calcular todas as subfases" — atualiza texto do botão ao marcar/desmarcar
document.getElementById('chk-todas-subfases')?.addEventListener('change', updateCalcBtn);
selectLpManual.addEventListener('change', () => {
  setCurrentLp(selectLpManual.value || null);
  updateCalcBtn();
});

function onFilter() { renderUtLista(); }

function onFilterComMapa() {
  renderUtLista();
  loadFilteredGeometries();
  updateCalcBtn();
  atualizarPreviewFiltro();
  saveState();   // C4
}

// ── Botões Marcar / Desmarcar ─────────────────────────────────────────
document.getElementById('btn-marcar-todas').addEventListener('click', () => {
  const filt = getUtsFiltradas();
  if (!filt.length) return;
  filt.forEach(u => markedUtIds.add(u.id));
  atualizarEstadoMarcacao();
});

document.getElementById('btn-desmarcar').addEventListener('click', () => {
  markedUtIds.clear();
  atualizarEstadoMarcacao();
});

function atualizarEstadoMarcacao() {
  const n      = markedUtIds.size;
  const countEl = document.getElementById('marcadas-count');
  const desBtn  = document.getElementById('btn-desmarcar');
  countEl.textContent = n > 0 ? `${n} marcada${n > 1 ? 's' : ''}` : '';
  desBtn.classList.toggle('hidden', n === 0);
  renderUtLista();
  updateCalcBtn();
  atualizarPreviewFiltro();
  saveState();   // C4
}

// Carrega e exibe no mapa todas as UTs do filtro lote+subfase
let _filterAbort = null;
async function loadFilteredGeometries() {
  const loteId = filterLote.value || null;
  const sfKey  = filterSf.value  || null;

  // Limpa se nenhum filtro ativo
  if (!loteId && !sfKey) { filterLayer.clearLayers(); return; }

  const params = new URLSearchParams();
  if (loteId) params.set('lote_id', loteId);
  if (sfKey)  params.set('subfase_key', sfKey);

  // Cancela requisição anterior se ainda não terminou
  if (_filterAbort) _filterAbort.cancelled = true;
  const ctrl = { cancelled: false };
  _filterAbort = ctrl;

  try {
    const fc = await fetch(`/api/uts?${params}`).then(r => r.json());
    if (ctrl.cancelled) return;

    filterLayer.clearLayers();
    if (fc.features?.length) {
      filterLayer.addData(fc);
      map.fitBounds(filterLayer.getBounds(), { padding: [20, 20] });
      sapStatus.textContent = `${fc.features.length} UT(s) no filtro.`;
    } else {
      sapStatus.textContent = 'Nenhuma UT encontrada para este filtro.';
    }
  } catch (e) {
    if (!ctrl.cancelled) sapStatus.textContent = `Erro ao carregar geometrias: ${e.message}`;
  }
}

async function selecionarUt(id) {
  selectedUtId = id;
  renderUtLista();
  const meta = allUTs.find(u => u.id === id);
  sapStatus.textContent = 'Carregando geometria…';
  try {
    const feature = await fetch(`/api/uts/${id}`).then(r => r.json());
    currentGeojson           = feature.geometry;
    currentUtId              = id;
    currentUtNome            = meta?.nome || `UT ${id}`;
    currentDenominadorEscala = meta?.denominador_escala || null;
    currentDificuldade       = meta?.dificuldade ?? null;
    hideEscalaSelector(); hideLpSelector();   // escala/LP vêm do lote — não precisa de seleção manual
    showDifRow(id, currentDificuldade);

    // Sincroniza Projeto + LP da UT selecionada (sem disparar onFilterComMapa)
    // Sempre chama para garantir que selectLpManual e filterLp reflitam a LP da UT
    setCurrentProjetoLp(meta?.projeto_id ?? currentProjetoId, meta?.linha_producao_id ?? currentLpId);

    utLayer.clearLayers().addData(feature);
    if (utLayer.getLayers().length) map.fitBounds(utLayer.getBounds(), { padding: [40, 40] });

    // Destaca a UT selecionada na camada de preview
    filterLayer.eachLayer(l => {
      const isSelected = l.feature?.properties?.id === id;
      l.setStyle(isSelected
        ? { color: '#ff9800', weight: 2.5, fillOpacity: 0.22 }
        : { color: '#90caf9', weight: 1.5, fillColor: '#90caf9', fillOpacity: 0.08 }
      );
    });

    const lpMeta      = allLinhasProducao.find(lp => lp.id === meta?.linha_producao_id);
    const projetoMeta = allProjetos.find(p  => p.id  === meta?.projeto_id);
    setUtPreview(currentUtNome, {
      Projeto: projetoMeta?.nome || null,
      Lote:    meta?.lote,
      LP:      lpMeta?.nome_abrev || null,
      Escala:  meta?.denominador_escala ? `1:${meta.denominador_escala.toLocaleString('pt-BR')}` : null,
    });

    const lpNome = lpMeta?.nome_abrev || lpMeta?.nome || null;

    // Resolve subfase: prefere key do mapeamento; fallback → casa pelo nome (ignora acentos/case)
    let autoKey  = meta?.subfase_key ?? null;
    let autoNome = meta?.subfase_nome ?? null;
    if (!autoKey && autoNome) {
      const norm = s => (s || '').toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
      const n = norm(autoNome);
      const found = allSubfases.find(s => norm(s.nome) === n)
                 ?? allSubfases.find(s => n.includes(norm(s.nome)))
                 ?? allSubfases.find(s => norm(s.nome).includes(n));
      if (found) { autoKey = found.key; autoNome = found.nome; }
    }

    if (autoKey) showSubfaseAuto(autoKey, autoNome, lpNome);
    else { showSubfaseSelector(true); sapStatus.textContent = 'Subfase não mapeada — selecione manualmente.'; }

    sapStatus.textContent = '';
    updateCalcBtn();
  } catch (e) { sapStatus.textContent = `Erro: ${e.message}`; }
}

// ── Aba Mapa ──────────────────────────────────────────────────────────
map.on(L.Draw.Event.CREATED, e => {
  drawnLayer.clearLayers().addLayer(e.layer);
  currentGeojson = e.layer.toGeoJSON().geometry;
  currentUtId = null; currentUtNome = 'UT desenhada';
  currentDenominadorEscala = null; selEscala.value = '';
  setUtPreview('UT desenhada no mapa', {});
  showSubfaseSelector(false); showEscalaSelector(); showLpSelector();
  updateCalcBtn();
});
document.getElementById('btn-limpar-desenho').addEventListener('click', () => {
  drawnLayer.clearLayers(); resetGeom();
});

// ── Aba Arquivo ───────────────────────────────────────────────────────

/** Remove o layer de múltiplas feições do mapa e limpa estado. */
function _clearArquivoLayers() {
  if (_arquivoLayerGroup) { map.removeLayer(_arquivoLayerGroup); _arquivoLayerGroup = null; }
  _arquivoFeatures        = [];
  _arquivoSelectedIndices = new Set();
  _arquivoIndivLayers     = [];
  _arquivoCurrentFileName = '';
  _arquivoResults         = [];
  const ctrl = document.getElementById('arquivo-multi-ctrl');
  if (ctrl) ctrl.classList.add('hidden');
}

/** Obtém o nome de exibição de uma feição a partir de suas propriedades. */
function _featureLabel(props, fallback) {
  if (!props) return fallback;
  const candidatos = ['nome', 'name', 'NAME', 'NOME', 'nr', 'NR', 'id', 'ID',
                      'ut', 'UT', 'folha', 'FOLHA', 'label', 'LABEL'];
  for (const k of candidatos) {
    if (props[k] != null && String(props[k]).trim()) return String(props[k]).trim();
  }
  // Tenta a primeira propriedade textual
  const firstTxt = Object.entries(props).find(([, v]) => typeof v === 'string' && v.trim());
  if (firstTxt) return firstTxt[1].trim();
  return fallback;
}

/** Atualiza o estado do app após mudança na seleção de feições do arquivo. */
function _onArquivoSelectionChange() {
  const n        = _arquivoSelectedIndices.size;
  const total    = _arquivoFeatures.length;
  const fileName = _arquivoCurrentFileName;

  // Atualiza contador no painel
  const countEl = document.getElementById('arquivo-sel-count');
  if (countEl) countEl.textContent = n === 0 ? '' : `${n} selecionada${n > 1 ? 's' : ''}`;

  currentUtId = null;
  utLayer.clearLayers();

  if (n === 0) {
    currentGeojson = null;
    currentUtNome  = null;
    document.getElementById('arquivo-status').textContent =
      `${total} feições — clique para selecionar`;
  } else if (n === 1) {
    const idx  = [..._arquivoSelectedIndices][0];
    const feat = _arquivoFeatures[idx];
    currentGeojson = feat.geojson;
    currentUtNome  = _featureLabel(feat.properties, `Feição ${idx + 1}`);
    currentDenominadorEscala = null; selEscala.value = '';
    setUtPreview(currentUtNome, { Arquivo: fileName, Feição: `${idx + 1} / ${total}` });
    document.getElementById('arquivo-status').textContent =
      `${total} feições — selecionada: ${currentUtNome} (${idx + 1}/${total})`;
  } else {
    // Múltiplas selecionadas — usa sentinel truthy para habilitar o botão
    currentGeojson = { _multi: true };
    currentUtNome  = `${n} feições selecionadas`;
    currentDenominadorEscala = null; selEscala.value = '';
    setUtPreview(`${n} feições selecionadas`, { Arquivo: fileName, Total: total });
    document.getElementById('arquivo-status').textContent =
      `${total} feições — ${n} selecionadas`;
  }

  showSubfaseSelector(false); showEscalaSelector(); showLpSelector(); updateCalcBtn();
}

/**
 * Exibe múltiplas feições no mapa como layers clicáveis com suporte a multi-seleção.
 * Clique numa feição toggle a sua seleção (verde = selecionada, azul = disponível).
 */
function _renderArquivoFeatures(features, fileName) {
  _clearArquivoLayers();
  _arquivoFeatures        = features;
  _arquivoCurrentFileName = fileName;

  const ST_DEFAULT  = { color: '#4fc3f7', weight: 1.5, fillColor: '#4fc3f7', fillOpacity: 0.08 };
  const ST_HOVER    = { color: '#ffa726', weight: 2,   fillColor: '#ffa726', fillOpacity: 0.15 };
  const ST_SELECTED = { color: '#66bb6a', weight: 2.5, fillColor: '#66bb6a', fillOpacity: 0.22 };

  _arquivoLayerGroup = L.featureGroup().addTo(map);

  features.forEach((feat, i) => {
    const lyr = L.geoJSON(
      { type: 'Feature', geometry: feat.geojson, properties: feat.properties },
      { style: ST_DEFAULT }
    );

    lyr.on('mouseover', () => {
      if (!_arquivoSelectedIndices.has(i)) lyr.setStyle(ST_HOVER);
    });
    lyr.on('mouseout', () => {
      if (!_arquivoSelectedIndices.has(i)) lyr.setStyle(ST_DEFAULT);
    });
    lyr.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      if (_arquivoSelectedIndices.has(i)) {
        _arquivoSelectedIndices.delete(i);
        lyr.setStyle(ST_DEFAULT);
      } else {
        _arquivoSelectedIndices.add(i);
        lyr.setStyle(ST_SELECTED);
      }
      _onArquivoSelectionChange();
    });

    _arquivoIndivLayers.push(lyr);
    _arquivoLayerGroup.addLayer(lyr);
  });

  // Ajusta o mapa para mostrar todas as feições
  const bounds = _arquivoLayerGroup.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30] });

  const dropText = document.getElementById('arquivo-drop-text');
  if (dropText) dropText.textContent = fileName;

  // Mostra controles de seleção
  const ctrl = document.getElementById('arquivo-multi-ctrl');
  if (ctrl) ctrl.classList.remove('hidden');

  document.getElementById('arquivo-status').textContent =
    `${features.length} feições carregadas — clique para selecionar`;
}

/** Aplica a geometria carregada pelo usuário como UT corrente. */
function _aplicarGeomArquivo(geom, fileName) {
  _clearArquivoLayers();   // limpa layers multi-feature se houver
  currentGeojson = geom; currentUtId = null;
  currentUtNome  = fileName.replace(/\.(geojson|json|zip|gpkg)$/i, '');
  currentDenominadorEscala = null; selEscala.value = '';
  utLayer.clearLayers().addData({ type: 'Feature', geometry: geom, properties: {} });
  if (utLayer.getLayers().length) map.fitBounds(utLayer.getBounds(), { padding: [30, 30] });
  setUtPreview(currentUtNome, { Arquivo: fileName });
  showSubfaseSelector(false); showEscalaSelector(); showLpSelector(); updateCalcBtn();
  // Atualiza texto da drop zone (B3)
  const dropText = document.getElementById('arquivo-drop-text');
  if (dropText) dropText.textContent = fileName;
}

document.getElementById('input-geojson').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  const arqStatus = document.getElementById('arquivo-status');
  const ext = (file.name.match(/\.(\w+)$/) || ['', ''])[1].toLowerCase();

  if (ext === 'geojson' || ext === 'json') {
    // Leitura direta no cliente
    const reader = new FileReader();
    reader.onload = evt => {
      try {
        const parsed = JSON.parse(evt.target.result);

        // FeatureCollection com múltiplas feições
        if (parsed.type === 'FeatureCollection' && Array.isArray(parsed.features)) {
          const polys = parsed.features.filter(f =>
            f?.geometry && ['Polygon', 'MultiPolygon'].includes(f.geometry.type)
          );
          if (!polys.length) { arqStatus.textContent = 'Nenhum polígono na FeatureCollection.'; return; }
          if (polys.length === 1) {
            arqStatus.textContent = '';
            _aplicarGeomArquivo(polys[0].geometry, file.name);
          } else {
            arqStatus.textContent = '';
            _renderArquivoFeatures(
              polys.map(f => ({ geojson: f.geometry, properties: f.properties || {} })),
              file.name
            );
            currentGeojson = null; currentUtId = null;
            showSubfaseSelector(false); showEscalaSelector(); showLpSelector();
            updateCalcBtn();
          }
          return;
        }

        // Feature ou geometria simples
        const geom = parsed.geometry || parsed;
        if (!['Polygon', 'MultiPolygon'].includes(geom.type)) {
          arqStatus.textContent = 'Geometria deve ser Polygon ou MultiPolygon.'; return;
        }
        arqStatus.textContent = '';
        _aplicarGeomArquivo(geom, file.name);
      } catch { arqStatus.textContent = 'GeoJSON inválido.'; }
    };
    reader.readAsText(file);

  } else if (ext === 'zip' || ext === 'gpkg') {
    // Enviar ao servidor para parsear (SHP zipado ou GeoPackage)
    arqStatus.textContent = 'Processando arquivo…';
    try {
      const fd = new FormData();
      fd.append('arquivo', file);
      const resp = await fetch('/api/arquivo/parse', { method: 'POST', body: fd });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.erro || 'Erro no servidor');

      if (data.count === 1) {
        // Feição única — aplica direto como antes
        const geom = data.features[0].geojson;
        if (!['Polygon', 'MultiPolygon'].includes(geom?.type))
          throw new Error('Geometria retornada não é Polygon/MultiPolygon');
        arqStatus.textContent = '';
        _aplicarGeomArquivo(geom, file.name);
      } else {
        // Múltiplas feições — exibe todas no mapa como layers clicáveis
        _renderArquivoFeatures(data.features, file.name);
        // currentGeojson fica null até o usuário clicar/selecionar feições
        currentGeojson = null; currentUtId = null;
        showSubfaseSelector(false); showEscalaSelector(); showLpSelector();
        updateCalcBtn();
      }
    } catch (err) {
      arqStatus.textContent = `Erro: ${err.message}`;
    }

  } else {
    arqStatus.textContent = 'Formato não suportado. Use .geojson, .json, .zip (SHP) ou .gpkg.';
  }
});

// ── B3 — Drag & drop na drop zone do Arquivo ─────────────────────────
(function () {
  const dropLabel = document.getElementById('arquivo-drop-label');
  const fileInput = document.getElementById('input-geojson');
  if (!dropLabel || !fileInput) return;

  ['dragenter', 'dragover'].forEach(evt => {
    dropLabel.addEventListener(evt, e => {
      e.preventDefault(); e.stopPropagation();
      dropLabel.classList.add('cn-drop-active');
    });
  });
  ['dragleave', 'dragend'].forEach(evt => {
    dropLabel.addEventListener(evt, () => {
      dropLabel.classList.remove('cn-drop-active');
    });
  });
  dropLabel.addEventListener('drop', e => {
    e.preventDefault(); e.stopPropagation();
    dropLabel.classList.remove('cn-drop-active');
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    // Injeta o arquivo no input e dispara o evento change
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
    } catch { /* Safari não suporta DataTransfer; fallback: processa direto */ }
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  });
})();

// ── Arquivo: selecionar todas / nenhuma ───────────────────────────────
(function () {
  const ST_DEFAULT  = { color: '#4fc3f7', weight: 1.5, fillColor: '#4fc3f7', fillOpacity: 0.08 };
  const ST_SELECTED = { color: '#66bb6a', weight: 2.5, fillColor: '#66bb6a', fillOpacity: 0.22 };

  document.getElementById('btn-sel-todas').addEventListener('click', () => {
    if (!_arquivoFeatures.length) return;
    _arquivoFeatures.forEach((_, i) => {
      _arquivoSelectedIndices.add(i);
      if (_arquivoIndivLayers[i]) _arquivoIndivLayers[i].setStyle(ST_SELECTED);
    });
    _onArquivoSelectionChange();
  });

  document.getElementById('btn-desel-todas').addEventListener('click', () => {
    _arquivoSelectedIndices.clear();
    _arquivoIndivLayers.forEach(lyr => lyr.setStyle(ST_DEFAULT));
    _onArquivoSelectionChange();
  });
})();

// ── Calcular — individual ou lote por filtro ──────────────────────────
document.getElementById('btn-calcular').addEventListener('click', async () => {
  // Modo arquivo com feições carregadas mas nenhuma selecionada → lote SAP ficaria errado
  if (_arquivoFeatures.length > 0 && !currentUtId) {
    if (_arquivoSelectedIndices.size === 0) {
      showToast('Selecione ao menos uma feição no mapa.', 'warn');
      return;
    }
    if (!currentSubfaseKey) {
      showToast('Selecione a subfase antes de calcular.', 'warn');
      return;
    }
    if (!currentDenominadorEscala) {
      showToast('Selecione a escala de produção.', 'warn');
      return;
    }
    // Cai para o bloco de cálculo individual/multi abaixo
  } else if (!currentUtId && !currentGeojson) {
    // Modo lote SAP: nenhuma UT individual selecionada, mas filtros/marcações ativos
    const chkT = document.getElementById('chk-todas-subfases');
    if (chkT?.checked) {
      await calcularLoteTodasSubfases();
    } else {
      await calcularPorFiltro();
    }
    return;
  } else if (!currentUtId && currentGeojson) {
    // Modo Mapa/GeoJSON manual — validação
    if (!currentSubfaseKey) {
      showToast('Selecione a subfase antes de calcular.', 'warn');
      return;
    }
    if (!currentDenominadorEscala) {
      showToast('Selecione a escala de produção.', 'warn');
      return;
    }
  }

  // Modo "Todas as subfases" — chama /api/calcular/mi em vez de /api/calcular
  if (currentSubfaseKey === '__all__') {
    await calcularTodasSubfases();
    return;
  }

  // Múltiplas feições do arquivo → calcula cada uma individualmente
  if (_arquivoFeatures.length > 0 && !currentUtId && _arquivoSelectedIndices.size > 1) {
    await calcularArquivoLote();
    return;
  }

  // Modo individual (SAP, arquivo com 1 feição, ou mapa manual)
  const loading  = document.getElementById('loading');
  const btnCalc  = document.getElementById('btn-calcular');

  btnCalc.disabled = true;
  loading.classList.remove('hidden');
  closeResultPanel();

  try {
    const reqBody = currentUtId
      ? { ut_id: currentUtId, subfase_key: currentSubfaseKey,
          denominador_escala: currentDenominadorEscala }
      : { geojson: currentGeojson, subfase_key: currentSubfaseKey,
          denominador_escala: currentDenominadorEscala, lp_key: getLpKey() };
    if (curvaNivelToken) reqBody.curva_nivel_token = curvaNivelToken;

    const res = await fetch('/api/calcular', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(reqBody),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.erro || `HTTP ${res.status}`);
    }
    lastResult = await res.json();
    renderResultado(lastResult);
    openResultPanel();
    // Auto-save no histórico
    GECalcStore.save({
      tipo:          'single',
      label:         `${currentUtNome || 'UT'} · ${allSubfases.find(s => s.key === lastResult.subfase_key)?.nome || lastResult.subfase_key || '–'}`,
      subfase_key:   lastResult.subfase_key,
      subfase_nome:  allSubfases.find(s => s.key === lastResult.subfase_key)?.nome || null,
      score:         subtotalPts(lastResult),
      escala:        lastResult.denominador_escala ?? null,
      lp_mapeamento: lastResult.lp_mapeamento ?? null,
      banco:         document.getElementById('db-badge')?.textContent?.trim() || null,
      n_uts:         null,
      ut_id:         lastResult.ut_id ?? null,          // para buscar geometria on-demand
      geom_geojson:  currentGeojson ?? null,            // disponível em modo arquivo/mapa
      result:        lastResult,
    });
  } catch (err) {
    showToast(`Erro no cálculo: ${err.message}`, 'error');
  } finally {
    loading.classList.add('hidden');
    btnCalc.disabled = false;
  }
});

// ── Arquivo — lote individual por feição ─────────────────────────────
/**
 * Calcula cada feição selecionada do arquivo individualmente e coloriza o mapa,
 * permitindo clicar em cada feição para ver seu resultado (igual ao lote SAP).
 */
async function calcularArquivoLote() {
  const indices  = [..._arquivoSelectedIndices];
  const total    = indices.length;
  const btnCalc  = document.getElementById('btn-calcular');
  const progEl   = document.getElementById('lote-progress');
  const progFill = document.getElementById('progress-fill');
  const progTx   = document.getElementById('progress-text');

  btnCalc.disabled = true;
  document.getElementById('loading').classList.add('hidden');
  progEl.classList.remove('hidden');
  progFill.style.width = '2%';
  progTx.textContent   = `Calculando ${total} feição${total > 1 ? 'ões' : ''}…`;
  closeResultPanel();

  _arquivoResults = [];

  for (let k = 0; k < indices.length; k++) {
    const i    = indices[k];
    const feat = _arquivoFeatures[i];
    const nome = _featureLabel(feat.properties, `Feição ${i + 1}`);

    try {
      const reqBody = {
        geojson:             feat.geojson,
        subfase_key:         currentSubfaseKey,
        denominador_escala:  currentDenominadorEscala,
        lp_key:              getLpKey(),
      };
      if (curvaNivelToken) reqBody.curva_nivel_token = curvaNivelToken;

      const res  = await fetch('/api/calcular', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(reqBody),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.erro || `HTTP ${res.status}`);

      _arquivoResults.push({ index: i, nome, result: data });
    } catch (e) {
      _arquivoResults.push({ index: i, nome, erro: e.message });
    }

    const pct = Math.round(((k + 1) / total) * 100);
    progFill.style.width = `${pct}%`;
    progTx.textContent   = `${k + 1} / ${total} feições calculadas`;
  }

  progEl.classList.add('hidden');
  progFill.style.width = '0%';
  btnCalc.disabled = false;

  _renderArquivoBatchMap(_arquivoResults);

  // Converte para o formato de lastBatchResultados para reutilizar ranking e estatísticas
  const batchFmt = _arquivoResults
    .filter(r => !r.erro)
    .map(r => ({
      ut_id:              null,   // sem id SAP — controla exibição de botões SAP no ranking
      geom:               null,
      nome:               r.nome,
      subfase_key:        r.result.subfase_key,
      denominador_escala: r.result.denominador_escala,
      mult_escala:        r.result.mult_escala,
      score_total:        r.result.score_total,
      por_subfase:        r.result.por_subfase  || {},
      por_camada:         r.result.por_camada   || [],
      avisos_query:       r.result.avisos_query || [],
      lp_mapeamento:      r.result.lp_mapeamento,
      lp_nome:            r.result.lp_nome,
    }))
    .sort((a, b) => subtotalPts(b) - subtotalPts(a));

  const errosList = _arquivoResults
    .filter(r => r.erro)
    .map(r => ({ nome: r.nome, erro: r.erro }));

  if (batchFmt.length) {
    lastBatchResultados = batchFmt;
    document.getElementById('btn-ver-ranking').classList.remove('hidden');
    renderRanking(batchFmt, errosList);
    // Auto-save no histórico
    const sfNomeB = allSubfases.find(s => s.key === batchFmt[0]?.subfase_key)?.nome || batchFmt[0]?.subfase_key || '–';
    GECalcStore.save({
      tipo:          'batch',
      label:         `${_arquivoCurrentFileName || 'Arquivo'} — ${batchFmt.length} feições · ${sfNomeB}`,
      subfase_key:   batchFmt[0]?.subfase_key ?? null,
      subfase_nome:  sfNomeB,
      score:         batchFmt.reduce((s, r) => s + subtotalPts(r), 0),
      escala:        batchFmt[0]?.denominador_escala ?? null,
      lp_mapeamento: batchFmt[0]?.lp_mapeamento ?? null,
      banco:         document.getElementById('db-badge')?.textContent?.trim() || null,
      n_uts:         batchFmt.length,
      result:        { resultados: batchFmt },
    });
  }

  const nErros = errosList.length;
  if (nErros)
    showToast(`${total - nErros} de ${total} feições calculadas (${nErros} com erro)`, 'warn');
  else
    showToast(`${total} feições calculadas — clique em uma para ver o resultado`, 'ok');
}

/**
 * Calcula TODAS as subfases de uma vez para a UT/geometria atual,
 * chamando /api/calcular/mi e exibindo o resultado consolidado.
 */
async function calcularTodasSubfases() {
  const loading = document.getElementById('loading');
  const btnCalc = document.getElementById('btn-calcular');
  btnCalc.disabled = true;
  loading.classList.remove('hidden');
  closeResultPanel();

  try {
    const lpKey = getLpKey();
    let reqBody;
    if (currentUtId) {
      reqBody = { ut_ids: [currentUtId] };
      if (currentDenominadorEscala) reqBody.denominador_escala = currentDenominadorEscala;
    } else if (currentGeojson && !currentGeojson._multi) {
      // Modo arquivo (feição única) ou mapa manual
      reqBody = {
        geom_geojson:        [currentGeojson],
        denominador_escala:  currentDenominadorEscala || 25000,
      };
    } else if (_arquivoSelectedIndices.size > 0) {
      // Modo arquivo multi-feição: coleta as geometrias selecionadas
      const geoms = [..._arquivoSelectedIndices].map(i => _arquivoFeatures[i]?.geojson).filter(Boolean);
      if (!geoms.length) throw new Error('Nenhuma geometria disponível.');
      reqBody = {
        geom_geojson:        geoms,
        denominador_escala:  currentDenominadorEscala || 25000,
      };
    } else {
      throw new Error('Nenhuma geometria disponível.');
    }
    // Passa LP explícita se disponível (modo arquivo/mapa), senão backend detecta via SAP
    if (lpKey) reqBody.lp_keys = [lpKey];
    if (curvaNivelToken) reqBody.curva_nivel_token = curvaNivelToken;

    const res = await fetch('/api/calcular/mi', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(reqBody),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.erro || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const lp = data.lps?.[0];
    if (!lp) throw new Error('Sem dados de LP na resposta do servidor.');

    // Converte a resposta MI para o formato esperado por renderResultado
    const por_subfase = {};
    const por_camada  = [];
    let n_metricas    = 0;
    Object.entries(lp.subfases || {}).forEach(([key, sf]) => {
      por_subfase[key] = sf.pts ?? 0;
      if (sf.pts > 0) n_metricas++;
      (sf.por_camada || []).forEach(c => por_camada.push({ ...c, subfase: key }));
    });

    const synth = {
      subfase_key:        '__all__',
      score_total:        lp.total,
      por_subfase,
      por_camada,
      denominador_escala: data.escala    || null,
      mult_escala:        data.mult_escala || null,
      lp_mapeamento:      lp.key,
      lp_nome:            lp.nome,
      n_metricas_brutas:  n_metricas,
      avisos_query:       [],
      ut_id:              currentUtId || null,
    };

    lastResult = synth;
    renderResultado(synth);
    openResultPanel();

    GECalcStore.save({
      tipo:          'single',
      label:         `${currentUtNome || 'UT'} · Todas as subfases`,
      subfase_key:   '__all__',
      subfase_nome:  'Todas as subfases',
      score:         lp.total,
      escala:        data.escala || null,
      lp_mapeamento: lp.key,
      banco:         document.getElementById('db-badge')?.textContent?.trim() || null,
      n_uts:         null,
      result:        synth,
    });
  } catch (err) {
    showToast(`Erro ao calcular todas as subfases: ${err.message}`, 'error');
  } finally {
    btnCalc.disabled = false;
    loading.classList.add('hidden');
    updateCalcBtn();
  }
}

/**
 * Coloriza as feições do arquivo no mapa de acordo com o score calculado.
 * Clique numa feição abre o painel de resultado individual.
 */
function _renderArquivoBatchMap(results) {
  if (!results.length) return;

  const scores = results.filter(r => !r.erro).map(r => subtotalPts(r.result));
  const minS   = scores.length ? Math.min(...scores) : 0;
  const maxS   = scores.length ? Math.max(...scores) : 1;

  const sfNome = allSubfases.find(s => s.key === currentSubfaseKey)?.nome ?? currentSubfaseKey ?? '–';
  const escStr = currentDenominadorEscala
    ? `1:${Number(currentDenominadorEscala).toLocaleString('pt-BR')}` : '–';

  results.forEach(({ index, nome, result, erro }) => {
    const lyr = _arquivoIndivLayers[index];
    if (!lyr) return;

    let color, tipHtml;
    if (erro) {
      color   = '#ef5350';
      tipHtml = `<strong>${nome}</strong><br><span style="color:#ef5350">Erro: ${erro}</span>`;
    } else {
      const pts = subtotalPts(result);
      const t   = maxS > minS ? (pts - minS) / (maxS - minS) : 0.5;
      color     = scoreColor(t);
      const ptsStr = pts.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
      tipHtml = `<strong>${nome}</strong><br>` +
                `<span style="color:#ffd700;font-weight:700">${ptsStr} pts</span> · ` +
                `<span style="color:#aaa;font-size:11px">${sfNome} · ${escStr}</span>`;
    }

    // Reaplica estilo e remove handlers anteriores
    lyr.setStyle({ color, weight: 1.5, fillColor: color, fillOpacity: 0.65, opacity: 1 });
    lyr.bindTooltip(tipHtml, { sticky: true });
    lyr.off('mouseover').off('mouseout').off('click');

    if (!erro) {
      lyr.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        currentUtNome  = nome;
        currentUtId    = null;
        // Expõe a geometria individual para o botão "Ver vetores"
        currentGeojson = _arquivoFeatures[index]?.geojson || null;
        lastResult     = result;
        renderResultado(result);
        openResultPanel();
      });
    } else {
      lyr.on('click', () => showToast(`Erro em "${nome}": ${erro}`, 'error'));
    }
  });

  // Exibe legenda de pontuação (reutiliza a do lote SAP)
  if (scores.length > 1) showLegend(minS, maxS);
}

// ── Cálculo em lote "todas as subfases" — chama /api/calcular/mi por UT ─
async function calcularLoteTodasSubfases() {
  const pool = markedUtIds.size > 0
    ? allUTs.filter(u => markedUtIds.has(u.id))
    : getUtsFiltradas();

  if (!pool.length) { showToast('Nenhuma UT selecionada.', 'warn'); return; }

  const btnCalc  = document.getElementById('btn-calcular');
  const progEl   = document.getElementById('lote-progress');
  const progFill = document.getElementById('progress-fill');
  const progTx   = document.getElementById('progress-text');

  btnCalc.disabled = true;
  progEl.classList.remove('hidden');
  progFill.style.width = '2%';
  progTx.textContent   = `Calculando todas as subfases — 0 / ${pool.length} UTs…`;

  const resultados = [];
  const erros      = [];

  for (let i = 0; i < pool.length; i++) {
    const ut = pool[i];
    progFill.style.width = `${Math.round(((i + 0.5) / pool.length) * 100)}%`;
    progTx.textContent   = `Calculando subfases — UT ${i + 1} / ${pool.length}: ${ut.nome || ut.id}…`;

    try {
      const res = await fetch('/api/calcular/mi', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ut_ids: [ut.id] }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.erro || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const lp   = data.lps?.[0];
      if (!lp) throw new Error('Sem dados de LP na resposta.');

      // Converte para o formato de resultado do lote (compatível com renderRanking)
      const por_subfase = Object.fromEntries(
        Object.entries(lp.subfases || {}).map(([k, v]) => [k, v.pts ?? 0])
      );
      const por_camada = Object.values(lp.subfases || {}).flatMap(v => v.por_camada || []);

      resultados.push({
        ut_id:              ut.id,
        nome:               ut.nome,
        // data.geom vem do /api/calcular/mi como GeoJSON da UT (união de 1 UT = geom própria)
        geom:               data.geom || null,
        subfase_key:        '__all__',
        denominador_escala: data.escala || null,
        lp_mapeamento:      lp.key,
        lp_nome:            lp.nome,
        score_total:        lp.total,
        por_subfase,
        por_camada,
        mult_escala:        data.mult_escala || null,
        n_metricas_brutas:  Object.values(lp.subfases || {}).filter(v => (v.pts ?? 0) > 0).length,
        avisos_query:       [],
      });
    } catch (e) {
      erros.push({ ut_id: ut.id, nome: ut.nome, erro: e.message });
    }

    progFill.style.width = `${Math.round(((i + 1) / pool.length) * 100)}%`;
  }

  // Ordena decrescente por total
  resultados.sort((a, b) => b.score_total - a.score_total);

  lastBatchResultados = resultados;
  renderBatchMap(resultados);
  renderRanking(resultados, erros);
  document.getElementById('btn-ver-ranking').classList.remove('hidden');

  // Auto-save
  if (resultados.length) {
    GECalcStore.save({
      tipo:          'batch',
      label:         `Lote — ${resultados.length} UTs · Total (todas subfases)`,
      subfase_key:   '__all__',
      subfase_nome:  'Total (todas as subfases)',
      score:         resultados.reduce((s, r) => s + r.score_total, 0),
      escala:        resultados[0]?.denominador_escala ?? null,
      lp_mapeamento: resultados[0]?.lp_mapeamento ?? null,
      banco:         document.getElementById('db-badge')?.textContent?.trim() || null,
      n_uts:         resultados.length,
      result:        { resultados },
    });
  }

  progEl.classList.add('hidden');
  progFill.style.width = '0%';
  btnCalc.disabled = false;
  updateCalcBtn();
}

// ── Cálculo em lote acionado pelo botão principal ─────────────────────
async function calcularPorFiltro() {
  const sfKey = filterSf.value || null;
  // Keys "id_N" são apenas para filtro visual — o backend não as conhece.
  const sfKeyParaApi = (sfKey && !sfKey.startsWith('id_')) ? sfKey : null;

  // Modo "Calcular todas as subfases (total)"
  const chkTodas     = document.getElementById('chk-todas-subfases');
  const todasSf      = chkTodas?.checked ?? false;

  // Prioridade: UTs marcadas > todas as filtradas
  const pool = markedUtIds.size > 0
    ? allUTs.filter(u => markedUtIds.has(u.id))
    : getUtsFiltradas();

  if (!pool.length) { showToast('Nenhuma UT selecionada.', 'warn'); return; }

  const utIds   = pool.map(u => u.id);
  const btnCalc = document.getElementById('btn-calcular');
  const progEl  = document.getElementById('lote-progress');
  const progFill = document.getElementById('progress-fill');
  const progTx  = document.getElementById('progress-text');

  btnCalc.disabled = true;
  document.getElementById('loading').classList.add('hidden');
  progEl.classList.remove('hidden');
  progFill.style.width = '5%';
  progTx.textContent   = `Calculando ${utIds.length} UT${utIds.length > 1 ? 's' : ''}…`;

  try {
    const reqBody = { ut_ids: utIds };
    if (todasSf) {
      reqBody.todas_subfases = true;               // backend calcula todas as subfases por UT
    } else if (sfKeyParaApi) {
      reqBody.subfase_key = sfKeyParaApi;
    }
    if (curvaNivelToken) reqBody.curva_nivel_token = curvaNivelToken;

    const res = await fetch('/api/calcular/lote', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(reqBody),
    });

    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.erro || `HTTP ${res.status}`);
    }

    // Lê o stream NDJSON linha a linha para atualizar a barra em tempo real
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let total  = utIds.length;
    let feitos = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const linhas = buffer.split('\n');
      buffer = linhas.pop(); // última linha incompleta fica no buffer
      for (const linha of linhas) {
        if (!linha.trim()) continue;
        let msg;
        try { msg = JSON.parse(linha); } catch { continue; }

        if (msg.tipo === 'inicio') {
          total = msg.total || total;
          progFill.style.width = '2%';
          progTx.textContent   = `0 / ${total} UTs calculadas`;
        } else if (msg.tipo === 'ut') {
          feitos++;
          const pct = Math.round((feitos / total) * 100);
          progFill.style.width = `${pct}%`;
          progTx.textContent   = `${feitos} / ${total} UTs calculadas${msg.erro ? ' ⚠' : ''}`;
        } else if (msg.tipo === 'fim') {
          lastBatchResultados = msg.resultados ?? [];
          renderBatchMap(lastBatchResultados);
          renderRanking(lastBatchResultados, msg.erros ?? []);
          document.getElementById('btn-ver-ranking').classList.remove('hidden');
          progFill.style.width = '100%';
          // Auto-save no histórico
          if (lastBatchResultados.length) {
            const sfNomeL = lastBatchResultados[0]?.subfase_key === '__all__'
              ? 'Total (todas as subfases)'
              : (allSubfases.find(s => s.key === lastBatchResultados[0]?.subfase_key)?.nome
                 || lastBatchResultados[0]?.subfase_key || '–');
            const loteNome = allUTs.find(u => u.lote_id === lastBatchResultados[0]?.lote_id)?.lote_nome
                           || lastBatchResultados[0]?.lote_nome || 'Lote';
            GECalcStore.save({
              tipo:          'batch',
              label:         `${loteNome} — ${lastBatchResultados.length} UTs · ${sfNomeL}`,
              subfase_key:   lastBatchResultados[0]?.subfase_key ?? null,
              subfase_nome:  sfNomeL,
              score:         lastBatchResultados.reduce((s, r) => s + subtotalPts(r), 0),
              escala:        lastBatchResultados[0]?.denominador_escala ?? null,
              lp_mapeamento: lastBatchResultados[0]?.lp_mapeamento ?? null,
              banco:         document.getElementById('db-badge')?.textContent?.trim() || null,
              n_uts:         lastBatchResultados.length,
              result:        { resultados: lastBatchResultados },
            });
          }
        } else if (msg.tipo === 'erro') {
          throw new Error(msg.erro);
        }
      }
    }

  } catch (err) {
    showToast(`Erro no cálculo em lote: ${err.message}`, 'error');
  } finally {
    btnCalc.disabled = false;
    progEl.classList.add('hidden');
    progFill.style.width = '0%';
  }
}

document.getElementById('btn-fechar-resultado').addEventListener('click', () => {
  closeResultPanel();
});

// ── Renderizar resultado individual ───────────────────────────────────
function renderResultado(result) {
  const isAllSubfases = result.subfase_key === '__all__';
  const sfNome = isAllSubfases
    ? 'Todas as subfases'
    : (allSubfases.find(s => s.key === result.subfase_key)?.nome
       || result.subfase_key || 'Todas as subfases');

  // Limpar vetores anteriores ao abrir novo resultado
  if (vetoresAtivos) { vetoresLayer.clearLayers(); vetoresAtivos = false; }

  document.getElementById('resultado-nome').textContent  = currentUtNome;
  document.getElementById('resultado-subfase').textContent = sfNome;

  // Score de exibição:
  //   - Modo "todas subfases" → score_total (inclui VF)
  //   - Subfase VF individual → score_total
  //   - Demais → soma por_subfase excluindo VF
  const isVfSubfase = result.subfase_key === 'verificacao_final';
  const displayScore = (isAllSubfases || isVfSubfase)
    ? result.score_total
    : Object.entries(result.por_subfase || {})
        .filter(([k]) => k !== 'verificacao_final')
        .reduce((s, [, v]) => s + v, 0);

  // V3 · Count-up animation no score
  const scoreEl = document.getElementById('resultado-score');
  animateCount(scoreEl, 0, displayScore);

  // D3 · Gauge SVG — percentual relativo ao máximo do lote ou ao próprio score
  const maxBatch = lastBatchResultados?.length
    ? Math.max(...lastBatchResultados.map(r => subtotalPts(r)), 1)
    : 0;
  const gaugePct = maxBatch > 0 ? displayScore / maxBatch : 1;
  const gaugeColor = SF_COLORS[result.subfase_key] ?? '#4fc3f7';
  const gaugeEl = document.getElementById('pr-gauge');
  if (gaugeEl) gaugeEl.innerHTML = buildGaugeSVG(gaugePct, gaugeColor);

  // Denominador para barras
  // Em modo "todas subfases" inclui VF; em modo individual inclui VF só se for a subfase escolhida
  const sfEntries = Object.entries(result.por_subfase || {})
    .filter(([key, pts]) => pts > 0 && (key !== 'verificacao_final' || isVfSubfase || isAllSubfases));
  const barTotal = sfEntries.reduce((s, [, v]) => s + v, 0) || 1;

  // Escala
  const escalaHtml = (result.denominador_escala && result.mult_escala != null)
    ? (() => {
        const m   = result.mult_escala;
        const pct = m === 1 ? 'referência'
                  : m >  1 ? `+${((m - 1) * 100).toFixed(0)}%`
                  :          `${((m - 1) * 100).toFixed(0)}%`;
        return `<div class="escala-chip">
          <span>⚖ Escala 1:${Number(result.denominador_escala).toLocaleString('pt-BR')}</span>
          <span class="escala-mult">×${m.toFixed(2)} <span class="escala-pct">(${pct})</span></span>
        </div>`;
      })() : '';

  const cnUsadaHtml = result.curva_nivel_usada
    ? `<div class="cn-usada-chip">📂 Curva de nível: arquivo externo</div>` : '';

  // LP badge — sigla (nome_abrev) tem prioridade; fallback ao nome ou ao key mapeado
  let lpLabel = null;
  if (result.lp_nome) {
    const lpMeta = (allLinhasProducao || []).find(lp => lp.nome === result.lp_nome);
    lpLabel = lpMeta?.nome_abrev || result.lp_nome;
  } else if (result.lp_mapeamento) {
    lpLabel = result.lp_mapeamento === 'mapeamento_orto'     ? 'Carta Orto'
            : result.lp_mapeamento === 'mapeamento_topo'  ? 'Topo 1.4'
            : result.lp_mapeamento;
  }
  const lpBadgeHtml = lpLabel
    ? `<div class="cn-usada-chip" style="background:rgba(102,187,106,0.12);border-color:rgba(102,187,106,0.3)">📋 LP: ${lpLabel}</div>` : '';

  // Estimativa de horas (C1)
  const horasStr = (result.taxa_pts_hora && result.score_total > 0)
    ? (() => {
        const h = result.score_total / result.taxa_pts_hora;
        return h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1).replace('.', ',')} h`;
      })() : null;

  // D2 · Stat chips
  const nSfComDados = sfEntries.length;
  const statChipsHtml = `<div class="stat-chips">
    <div class="stat-chip">
      <span class="stat-n">${nSfComDados}</span>
      <span class="stat-lbl">subfases</span>
    </div>
    ${result.denominador_escala ? `<div class="stat-chip">
      <span class="stat-n">1:${Math.round(result.denominador_escala / 1000)}k</span>
      <span class="stat-lbl">escala</span>
    </div>` : ''}
    ${horasStr ? `<div class="stat-chip">
      <span class="stat-n">${horasStr}</span>
      <span class="stat-lbl">estimativa</span>
    </div>` : ''}
  </div>`;

  // Aviso diagnóstico
  const zeroMetricasHtml = (result.n_metricas_brutas === 0)
    ? (() => {
        const avisos  = result.avisos_query;
        const detalhe = avisos?.length ? `<br><small style="opacity:.75">${avisos[0]}</small>` : '';
        const temErros = avisos?.length > 0;
        return `<div class="zero-metricas-warn">
          ${temErros
            ? `⚠ Erro ao consultar tabelas no banco EDGV — verifique se o esquema <code>edgv</code> existe e as tabelas estão populadas.${detalhe}`
            : `ℹ Nenhuma feição encontrada no banco EDGV para esta área e subfase.<br><small style="opacity:.75">Banco possivelmente vazio ou área sem dados vetorizados.</small>`
          }
        </div>`;
      })() : '';

  // D1 · Barras de subfase modernas (V4 · cores semânticas)
  const sortedEntries = [...sfEntries].sort(([, a], [, b]) => b - a);
  const sfBarsHtml = sortedEntries.length
    ? `<div class="sf-bars-section">
        <div class="sf-bars-title">Pontuação por subfase</div>
        ${sortedEntries.map(([key, pts]) => {
          const pct   = (pts / barTotal) * 100;
          const color = SF_COLORS[key] ?? '#4fc3f7';
          const nome  = allSubfases.find(s => s.key === key)?.nome ?? key.replace(/_/g, ' ');
          const nomeShort = nome.replace(/^Extração (d[eoa] )?/i, '');
          return `<div class="sf-bar-row" style="--sf-c:${color}" data-pct="${pct.toFixed(2)}">
            <div class="sf-bar-label">
              <span class="sf-bar-dot"></span>
              <span class="sf-bar-name" title="${nome}">${nomeShort}</span>
              <span class="sf-bar-pts">${pts.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}</span>
            </div>
            <div class="sf-bar-track">
              <div class="sf-bar-fill" data-w="${Math.max(pct, 1).toFixed(2)}" style="width:0%"></div>
            </div>
          </div>`;
        }).join('')}
      </div>`
    : `<div class="empty-state"><span class="empty-state-icon">📊</span><p>Sem pontuação para esta subfase</p></div>`;

  // Detalhamento por camada
  const camRows = (result.por_camada || [])
    .sort((a,b) => b.pts - a.pts)
    .map(d => {
      const join    = d.camada.includes('__x__') ? ' <span class="tag-join">join</span>' : '';
      const camNome = d.camada.replace(/__x__.*/, '');
      const ptsStr  = d.pts.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
      let valorCell;
      if (d.metrica === 'dens_ent') {
        const nEnt = d.n_ent != null ? d.n_ent : '?';
        valorCell = `${nEnt} <span class="cam-metrica">ent</span> <span class="cam-dens">${d.valor}/km</span> <span class="cam-fator">×${d.fator}</span>`;
      } else if (d.metrica === 'dens_conf') {
        const nConf = d.n_conf != null ? d.n_conf : '?';
        valorCell = `${nConf} <span class="cam-metrica">conf</span> <span class="cam-dens">${d.valor}/km</span> <span class="cam-fator">×${d.fator}</span>`;
      } else {
        const exp = d.expoente !== 1 ? `<sup>${d.expoente}</sup>` : '';
        valorCell = `${d.valor} <span class="cam-metrica">${d.metrica}${exp}</span>`;
      }
      return `<tr>
        <td><span class="camada-nome">${camNome}</span>${join}</td>
        <td class="cam-valor">${valorCell}</td>
        <td class="cam-pts">${ptsStr}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="3" class="empty-cell">Sem dados de camada</td></tr>';

  const utIdVet  = result.ut_id || currentUtId;
  const sfKeyVet = result.subfase_key;
  // Geom disponível para modo arquivo/mapa (sem ut_id)
  const geomVet  = !utIdVet && currentGeojson && !currentGeojson._multi ? currentGeojson : null;
  const temVet   = !!(utIdVet || geomVet);

  document.getElementById('pr-body').innerHTML = `
    ${zeroMetricasHtml}
    ${statChipsHtml}
    ${escalaHtml}${cnUsadaHtml}${lpBadgeHtml}
    ${sfBarsHtml}
    <details class="detail-block">
      <summary>▸ Detalhamento por camada (${(result.por_camada||[]).length})</summary>
      <table class="result-table cam-table" style="margin-top:8px">
        <thead><tr><th>Camada</th><th>Valor</th><th class="cam-pts">Pts</th></tr></thead>
        <tbody>${camRows}</tbody>
      </table>
    </details>
    <div class="pr-actions">
      ${temVet ? `<button class="btn btn-sm btn-vet" id="btn-toggle-vet">📍 Ver vetores</button>` : ''}
      ${lastBatchResultados ? `<button class="btn btn-sm btn-rank" id="btn-abrir-rank">📊 Ranking</button>` : ''}
      <button class="btn btn-sm btn-secondary" id="btn-exportar">⬇ JSON</button>
      <button class="btn btn-sm btn-secondary" id="btn-exportar-csv">⬇ CSV</button>
    </div>
  `;

  // D1 · Animar barras (largura de 0 → valor real após render)
  requestAnimationFrame(() => {
    document.querySelectorAll('.sf-bar-fill[data-w]').forEach(el => {
      const w = el.getAttribute('data-w');
      el.style.width = `${w}%`;
    });
  });

  if (temVet) {
    document.getElementById('btn-toggle-vet').addEventListener('click', () =>
      toggleVetores(utIdVet, sfKeyVet, result.lp_mapeamento, geomVet));
  }
  if (lastBatchResultados) {
    document.getElementById('btn-abrir-rank').addEventListener('click', () => abrirRanking());
  }
  document.getElementById('btn-exportar').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ ut: currentUtNome, ...result }, null, 2)], { type:'application/json' });
    Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `score_${currentUtNome.replace(/\s+/g,'_')}.json`
    }).click();
  });

  document.getElementById('btn-exportar-csv').addEventListener('click', () => {
    const linhas = [
      ['UT', 'Subfase', 'Pts_subfase', 'Escala', 'Mult_escala', 'Score_total'],
      ...Object.entries(result.por_subfase ?? {}).map(([sf, pts]) => [
        currentUtNome, sf, pts,
        result.denominador_escala ?? '',
        result.mult_escala ?? '',
        result.score_total,
      ]),
    ];
    const csv  = linhas.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }); // BOM para Excel
    Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `score_${currentUtNome.replace(/\s+/g,'_')}.csv`
    }).click();
  });
}

// ── Vetores EDGV no mapa ──────────────────────────────────────────────
/**
 * Mostra/oculta feições EDGV da subfase no mapa.
 * utId + sfKey → GET (modo SAP)
 * geomRef (GeoJSON) → POST /api/vetores (modo Arquivo / Mapa)
 */
async function toggleVetores(utId, sfKey, lpKey, geomRef) {
  const btn = document.getElementById('btn-toggle-vet');
  if (!btn) return;

  if (vetoresAtivos) {
    vetoresLayer.clearLayers();
    vetoresAtivos = false;
    btn.textContent = '📍 Ver vetores';
    btn.classList.remove('btn-vet-on');
    return;
  }

  btn.textContent = '⏳ Carregando…';
  btn.disabled = true;
  try {
    let fc;
    if (utId) {
      // Modo SAP — GET com ut_id
      const lpParam = lpKey ? `&lp_key=${encodeURIComponent(lpKey)}` : '';
      fc = await fetch(`/api/vetores?ut_id=${utId}&subfase_key=${sfKey}${lpParam}`).then(r => r.json());
    } else if (geomRef) {
      // Modo Arquivo / Mapa — POST com geojson
      fc = await fetch('/api/vetores', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ geojson: geomRef, subfase_key: sfKey, lp_key: lpKey }),
      }).then(r => r.json());
    } else {
      throw new Error('Nenhuma geometria disponível');
    }

    if (fc.erro) throw new Error(fc.erro);

    const validas = (fc.features || []).filter(f => f.geometry && f.geometry.type);
    vetoresLayer.clearLayers();
    if (validas.length > 0) {
      vetoresLayer.addData({ type: 'FeatureCollection', features: validas });
    }
    vetoresAtivos = true;
    btn.textContent = validas.length > 0
      ? `📍 Ocultar vetores (${validas.length})`
      : '📍 Sem feições nesta área';
    btn.classList.add('btn-vet-on');
  } catch (e) {
    btn.textContent = '📍 Ver vetores';
    showToast('Erro ao carregar vetores: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}


// ── Mapa — visualização do lote ───────────────────────────────────────
function scoreColor(t) {
  // verde (baixo) → amarelo (médio) → vermelho (alto)
  // Paleta HSL totalmente saturada e de luminosidade média — legível sobre
  // qualquer fundo (OSM claro, Google Híbrido escuro, terreno, etc.)
  const hue = Math.round(120 - t * 120);   // 120° verde → 60° amarelo → 0° vermelho
  return `hsl(${hue}, 95%, 44%)`;
}

function renderBatchMap(resultados) {
  batchLayer.clearLayers();
  batchResultById.clear();
  if (!resultados.length) { hideLegend(); return; }

  const scores = resultados.map(r => subtotalPts(r));
  const minS   = Math.min(...scores);
  const maxS   = Math.max(...scores);

  resultados.forEach(r => {
    if (!r.geom) return;   // pula UTs sem geometria
    batchResultById.set(r.ut_id, r);

    const pts    = subtotalPts(r);
    const t      = maxS > minS ? (pts - minS) / (maxS - minS) : 0.5;
    const color  = scoreColor(t);
    const sfNome = r.subfase_key === '__all__'
      ? 'Total (todas subfases)'
      : (allSubfases.find(s => s.key === r.subfase_key)?.nome ?? r.subfase_key ?? '–');
    const escStr = r.denominador_escala
      ? `1:${Number(r.denominador_escala).toLocaleString('pt-BR')}` : '–';
    const ptsStr = pts.toLocaleString('pt-BR', { maximumFractionDigits: 0 });

    L.geoJSON({ type: 'Feature', geometry: r.geom, properties: { ut_id: r.ut_id } }, {
      style: { color, weight: 1.5, fillColor: color, fillOpacity: 0.65, opacity: 1 },
    })
    .bindTooltip(
      `<strong>${r.nome ?? `UT ${r.ut_id}`}</strong><br>` +
      `<span style="color:#ffd700;font-weight:700">${ptsStr} pts</span> · ` +
      `<span style="color:#aaa;font-size:11px">${sfNome}</span>`,
      { sticky: true }
    )
    .on('click', () => mostrarResultadoNoPopup(r))
    .addTo(batchLayer);
  });

  if (batchLayer.getLayers().length) {
    map.fitBounds(batchLayer.getBounds(), { padding: [20, 20] });
    showLegend(minS, maxS);
  }
}

// Abre o drawer de resultado ao clicar numa UT do lote no mapa
function mostrarResultadoNoPopup(result) {
  currentUtNome = result.nome;
  renderResultado(result);
  openResultPanel();
}

// ── Ranking modal ─────────────────────────────────────────────────────

/**
 * Subtotal de pontos SEM verificacao_final.
 * score_total do backend = subtotal + VF; exibir score_total duplicaria o valor.
 */
function subtotalPts(r) {
  if (!r) return 0;
  // Modo "todas subfases": usa score_total diretamente (inclui Verificação Final)
  if (r.subfase_key === '__all__') return r.score_total ?? 0;
  if (r.por_subfase) {
    return Object.entries(r.por_subfase)
      .filter(([k]) => k !== 'verificacao_final')
      .reduce((acc, [, v]) => acc + v, 0);
  }
  return r.score_total ?? 0;
}

/**
 * Estatísticas descritivas sobre um array de resultados.
 * Retorna null quando o array está vazio.
 */
function calcStats(resultados) {
  if (!resultados.length) return null;

  // Ordena por subtotal ASC para calcular mediana/desvio
  const sorted = [...resultados].sort((a, b) => subtotalPts(a) - subtotalPts(b));
  const scores = sorted.map(r => subtotalPts(r));
  const n      = scores.length;
  const total  = scores.reduce((acc, v) => acc + v, 0);
  const media  = total / n;
  const mediana = n % 2 === 0
    ? (scores[n / 2 - 1] + scores[n / 2]) / 2
    : scores[Math.floor(n / 2)];
  const desvio = Math.sqrt(scores.reduce((acc, v) => acc + (v - media) ** 2, 0) / n);

  // resultados chegam do backend já ordenados DESC por score_total
  return {
    n, total, media, mediana, desvio,
    max: resultados[0],                          // maior pontuação
    min: resultados[resultados.length - 1],      // menor pontuação
  };
}

function abrirRanking() {
  if (lastBatchResultados) renderRanking(lastBatchResultados, []);
}

function renderRanking(resultados, erros) {
  const modal       = document.getElementById('modal-lote');
  const body        = document.getElementById('modal-lote-body');
  // Modo arquivo: sem ut_id — esconde botões específicos do SAP
  const modoArquivo = resultados.length > 0 && resultados[0].ut_id == null;

  // Sem nenhum resultado calculado com sucesso
  if (!resultados.length) {
    const erroLista = (erros || []).slice(0, 10)
      .map(e => `<li><strong>${e.nome || e.ut_id}</strong> — ${e.erro}</li>`)
      .join('');
    const maisErros = erros.length > 10 ? `<li>… e mais ${erros.length - 10} erros</li>` : '';
    body.innerHTML = `
      <p class="msg" style="color:#ef9a9a;font-size:14px;margin-bottom:8px">
        Nenhuma UT calculada com sucesso.
      </p>
      ${erros.length ? `<ul style="color:#ef9a9a;font-size:12px;margin:0;padding-left:18px">
        ${erroLista}${maisErros}
      </ul>
      <p class="hint" style="margin-top:10px">
        Verifique se as subfases estão mapeadas em
        <a href="/api/sap-mapping/status" target="_blank">/api/sap-mapping/status</a>
        ou selecione a subfase manualmente antes de calcular.
      </p>` : ''}
    `;
    modal.classList.remove('hidden');
    return;
  }

  const sfNomes  = Object.fromEntries(allSubfases.map(s => [s.key, s.nome]));
  const maxPts   = subtotalPts(resultados[0]) || 1;
  const st       = calcStats(resultados);
  const fmt      = v => Number.isFinite(v) ? v.toLocaleString('pt-BR', { maximumFractionDigits: 0 }) : '–';
  const fmtD     = v => Number.isFinite(v) ? v.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : '–';
  const cv       = st.media > 0 ? (st.desvio / st.media) * 100 : 0;

  const statsHtml = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-val">${st.n}</div>
        <div class="stat-lbl">UTs</div>
      </div>
      <div class="stat-card">
        <div class="stat-val">${fmt(st.total)}</div>
        <div class="stat-lbl">Total pts</div>
      </div>
      <div class="stat-card">
        <div class="stat-val">${fmtD(st.media)}</div>
        <div class="stat-lbl">Média</div>
      </div>
      <div class="stat-card">
        <div class="stat-val">${fmtD(st.mediana)}</div>
        <div class="stat-lbl">Mediana</div>
      </div>
      <div class="stat-card">
        <div class="stat-val">${fmtD(st.desvio)}</div>
        <div class="stat-lbl">Desvio padrão</div>
      </div>
      <div class="stat-card stat-max">
        <div class="stat-val">${fmt(subtotalPts(st.max))}</div>
        <div class="stat-lbl">Máx — ${st.max?.nome ?? '–'}</div>
      </div>
      <div class="stat-card stat-min">
        <div class="stat-val">${fmt(subtotalPts(st.min))}</div>
        <div class="stat-lbl">Mín — ${st.min?.nome ?? '–'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-val">${fmtD(cv)}%</div>
        <div class="stat-lbl">CV (variação)</div>
      </div>
    </div>`;

  const modoTotal = resultados.length > 0 && resultados[0].subfase_key === '__all__';
  const linhas = resultados.map((r, i) => {
    const pts     = subtotalPts(r);
    const pct     = Math.round((pts / maxPts) * 100);
    const escStr  = r.denominador_escala
      ? `1:${Number(r.denominador_escala).toLocaleString('pt-BR')}` : '–';
    const sfNome  = r.subfase_key === '__all__'
      ? '<span style="color:var(--c-accent,#4fc3f7);font-weight:600">Total</span>'
      : (sfNomes[r.subfase_key] ?? r.subfase_key ?? '–');
    const rankCls = i === 0 ? ' rank-1' : i === 1 ? ' rank-2' : i === 2 ? ' rank-3' : '';
    const barColor = modoTotal ? 'var(--c-accent,#4fc3f7)' : '';
    return `<tr class="${rankCls}">
      <td class="rank-pos">${i + 1}</td>
      <td>
        <span style="font-weight:600">${r.nome ?? `UT ${r.ut_id}`}</span>
        <span class="rank-bar" style="width:${pct}%${barColor ? `;background:${barColor}` : ''}"></span>
      </td>
      <td style="font-size:11px;color:#78909c">${escStr}</td>
      <td style="font-size:11px;color:#78909c;max-width:160px;overflow:hidden;
                 text-overflow:ellipsis;white-space:nowrap">${sfNome}</td>
      <td class="score-mini">${pts.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}</td>
    </tr>`;
  }).join('');

  const erroHtml = erros?.length
    ? `<p class="msg" style="color:#ef9a9a;margin-top:6px">
         ${erros.length} UT${erros.length > 1 ? 's' : ''} com erro (não incluída${erros.length > 1 ? 's' : ''} no ranking).
       </p>`
    : '';

  const labelEntidade = modoArquivo ? 'Feição' : 'UT';

  body.innerHTML = `
    ${statsHtml}
    <div style="overflow:auto;max-height:46vh;margin-top:10px">
      <table id="tabela-ranking">
        <thead><tr><th>#</th><th>${labelEntidade}</th><th>Escala</th><th>Subfase</th><th>Pontos</th></tr></thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>
    ${erroHtml}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center">
      <button class="btn btn-secondary btn-sm" id="btn-exportar-lote">⬇ Exportar JSON</button>
      <button class="btn btn-secondary btn-sm" id="btn-exportar-lote-csv">⬇ Exportar CSV</button>
      ${!modoArquivo ? `<button class="btn btn-primary btn-sm" id="btn-abrir-dif-lote">💾 Salvar dificuldade no SAP</button>` : ''}
      <button class="btn btn-secondary btn-sm" id="btn-abrir-distrib">👥 Distribuir</button>
    </div>
  `;

  document.getElementById('btn-exportar-lote').addEventListener('click', () => {
    const dados = {
      estatisticas: {
        n:             st.n,
        total:         st.total,
        media:         st.media,
        mediana:       st.mediana,
        desvio_padrao: st.desvio,
        cv_pct:        cv,
        maximo: st.max ? { nome: st.max.nome, pts: subtotalPts(st.max) } : null,
        minimo: st.min ? { nome: st.min.nome, pts: subtotalPts(st.min) } : null,
      },
      resultados,
      erros: erros ?? [],
    };
    const blob = new Blob([JSON.stringify(dados, null, 2)], { type: 'application/json' });
    Object.assign(document.createElement('a'), {
      href:     URL.createObjectURL(blob),
      download: modoArquivo ? 'ranking_arquivo.json' : 'ranking_lote.json',
    }).click();
  });

  // Exportar CSV do ranking
  document.getElementById('btn-exportar-lote-csv').addEventListener('click', () => {
    const sfNomesFn = key => allSubfases.find(s => s.key === key)?.nome ?? key ?? '–';
    const header = [labelEntidade, 'Subfase', 'Escala', 'Pontos (subtotal)', 'Score total'].join(',');
    const linhasCSV = resultados.map(r => [
      `"${(r.nome ?? '').replace(/"/g, '""')}"`,
      `"${sfNomesFn(r.subfase_key).replace(/"/g, '""')}"`,
      r.denominador_escala ? `1:${r.denominador_escala}` : '–',
      subtotalPts(r).toFixed(1),
      (r.score_total ?? '').toString(),
    ].join(','));
    const csv  = [header, ...linhasCSV].join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    Object.assign(document.createElement('a'), {
      href:     URL.createObjectURL(blob),
      download: modoArquivo ? 'ranking_arquivo.csv' : 'ranking_lote.csv',
    }).click();
  });

  // Botão Salvar dificuldade no SAP (somente modo SAP)
  if (!modoArquivo) {
  document.getElementById('btn-abrir-dif-lote').addEventListener('click', () => {
    abrirPainelDifLote(resultados);
  });
  }

  // Botão Distribuir entre operadores
  document.getElementById('btn-abrir-distrib').addEventListener('click', () => {
    document.getElementById('distrib-section').classList.remove('hidden');
    document.getElementById('distrib-result').innerHTML = '';
    document.getElementById('btn-exportar-distrib').classList.add('hidden');
    document.getElementById('inp-distrib').focus();
  });

  modal.classList.remove('hidden');
}

// ── Painel de salvar dificuldade em lote ──────────────────────────────

function calcDificuldadesParaSalvar(resultados, modo) {
  const scores = resultados.map(r => subtotalPts(r));
  const minS   = Math.min(...scores);
  const maxS   = Math.max(...scores);

  return resultados.map(r => {
    const pts = subtotalPts(r);
    let dif;
    if (modo === 'quintil') {
      // Mapeia para 1–5 por quintis (baseado na posição relativa no range)
      const t  = maxS > minS ? (pts - minS) / (maxS - minS) : 0.5;
      dif = Math.min(5, Math.max(1, Math.ceil(t * 5) || 1));
    } else {
      dif = Math.round(pts);
    }
    return { id: r.ut_id, nome: r.nome, pts, dif };
  });
}

function abrirPainelDifLote(resultados) {
  const section     = document.getElementById('dif-lote-section');
  const preview     = document.getElementById('dif-lote-preview');
  const statusEl    = document.getElementById('dif-lote-status');
  const confirmar   = document.getElementById('btn-confirmar-dif-lote');
  const radios      = document.querySelectorAll('input[name="dif-modo"]');

  section.classList.remove('hidden');
  statusEl.textContent = '';

  function atualizarPreview() {
    const modo    = [...radios].find(r => r.checked)?.value ?? 'score';
    const updates = calcDificuldadesParaSalvar(resultados, modo);
    // Mostra amostra: primeiro 5 e último
    const amostra = updates.slice(0, 4).concat(updates.length > 5 ? [updates.at(-1)] : []);
    const reticencias = updates.length > 5
      ? `<span class="dif-preview-reticencias">… +${updates.length - 5} UTs</span>` : '';
    preview.innerHTML =
      amostra.map(u =>
        `<span class="dif-preview-item">
          <strong>${u.nome}</strong>&nbsp;<span class="dif-chip">${u.dif}</span>
        </span>`
      ).join('') + reticencias;
  }

  radios.forEach(r => r.addEventListener('change', atualizarPreview));
  atualizarPreview();

  // Remove listener anterior e adiciona novo
  const btnNovo = confirmar.cloneNode(true);
  confirmar.parentNode.replaceChild(btnNovo, confirmar);

  btnNovo.addEventListener('click', async () => {
    const modo    = [...radios].find(r => r.checked)?.value ?? 'score';
    const updates = calcDificuldadesParaSalvar(resultados, modo)
      .map(u => ({ id: u.id, dificuldade: u.dif }));

    statusEl.textContent = 'Salvando…';
    btnNovo.disabled     = true;
    try {
      const res = await fetch('/api/uts/dificuldade/lote', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ updates }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.erro || `HTTP ${res.status}`);
      }
      const r = await res.json();
      // Atualiza cache local
      updates.forEach(u => {
        const ut = allUTs.find(x => x.id === u.id);
        if (ut) ut.dificuldade = u.dificuldade;
      });
      statusEl.textContent = `✓ ${r.updated} UTs atualizadas`;
      btnNovo.disabled     = false;
    } catch (err) {
      statusEl.textContent = `Erro: ${err.message}`;
      btnNovo.disabled     = false;
    }
  });
}

document.getElementById('btn-fechar-dif-lote').addEventListener('click', () => {
  document.getElementById('dif-lote-section').classList.add('hidden');
});

// ── Distribuição de Operadores ────────────────────────────────────────

/**
 * LPT (Longest Processing Time) — atribuição greedy que minimiza o
 * desequilíbrio entre operadores.
 * @param {Array}  uts    — resultados do batch (lastBatchResultados)
 * @param {number} nOps   — nº de operadores
 * @returns {Array<{id,uts,total}>}
 */
function distribuirUTs(uts, nOps) {
  const sorted = [...uts].sort((a, b) => subtotalPts(b) - subtotalPts(a));
  const ops    = Array.from({ length: nOps }, (_, i) => ({ id: i + 1, uts: [], total: 0 }));
  for (const ut of sorted) {
    const pts  = subtotalPts(ut);
    const minOp = ops.reduce((a, b) => a.total <= b.total ? a : b);
    minOp.uts.push(ut);
    minOp.total += pts;
  }
  return ops;
}

// Paleta de 10 cores para identificar operadores
const OP_COLORS = [
  '#4fc3f7','#66bb6a','#ffa726','#ef5350','#ab47bc',
  '#26c6da','#ffca28','#42a5f5','#ff7043','#26a69a',
];

function renderDistribuicao(ops) {
  const total   = ops.reduce((s, o) => s + o.total, 0);
  const maxLoad = Math.max(...ops.map(o => o.total));

  const cards = ops.map((op, i) => {
    const color  = OP_COLORS[i % OP_COLORS.length];
    const pct    = total > 0 ? (op.total / total * 100).toFixed(1) : 0;
    const barPct = maxLoad > 0 ? (op.total / maxLoad * 100).toFixed(1) : 0;
    const itens  = op.uts.map(ut => {
      const pts  = subtotalPts(ut);
      const nome = String(ut.nome ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      return `<div class="distrib-op-item">
        <span class="distrib-op-item-name" title="${nome}">${nome}</span>
        <span class="distrib-op-item-pts">${pts.toLocaleString('pt-BR', {maximumFractionDigits:0})} pts</span>
      </div>`;
    }).join('');

    return `<div class="distrib-op-card">
      <div class="distrib-op-header">
        <div class="distrib-op-title">
          <span class="distrib-op-name" style="color:${color}">Operador ${op.id}</span>
          <span class="distrib-op-pts"  style="color:${color}">
            ${op.total.toLocaleString('pt-BR', {maximumFractionDigits:0})} pts
          </span>
        </div>
        <div style="font-size:10px;color:#546e7a;margin-top:1px">
          ${op.uts.length} UT${op.uts.length !== 1 ? 's' : ''} · ${pct}% do total
        </div>
        <div class="distrib-op-bar-track">
          <div class="distrib-op-bar-fill" data-w="${barPct}"
               style="width:0;background:${color}"></div>
        </div>
      </div>
      <div class="distrib-op-list">${itens}</div>
    </div>`;
  }).join('');

  // Resumo de desequilíbrio
  const media    = total / ops.length;
  const maxDesvio = Math.max(...ops.map(o => Math.abs(o.total - media)));
  const desvPct  = media > 0 ? (maxDesvio / media * 100).toFixed(1) : 0;
  const summary  = `<div class="distrib-summary">
    Total: ${total.toLocaleString('pt-BR', {maximumFractionDigits:0})} pts
    · Média por op: ${media.toLocaleString('pt-BR', {maximumFractionDigits:0})} pts
    · Desequilíbrio máx: ${desvPct}%
  </div>`;

  const el = document.getElementById('distrib-result');
  el.innerHTML = cards + summary;

  // Animar barras
  requestAnimationFrame(() => {
    el.querySelectorAll('.distrib-op-bar-fill').forEach(bar => {
      bar.style.width = bar.dataset.w + '%';
    });
  });
}

function _exportarDistribCSV(ops) {
  const linhas = [['Operador','UT','Pontos']];
  ops.forEach(op => {
    op.uts.forEach(ut => {
      linhas.push([
        `Operador ${op.id}`,
        ut.nome,
        subtotalPts(ut).toFixed(0),
      ]);
    });
  });
  const csv  = linhas.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob), download: 'distribuicao_operadores.csv',
  }).click();
}

// Listener — modo (label dinâmico)
document.querySelectorAll('input[name="distrib-modo"]').forEach(r => {
  r.addEventListener('change', () => {
    const modoOp = document.querySelector('input[name="distrib-modo"]:checked').value === 'operadores';
    document.getElementById('distrib-input-label').textContent = modoOp ? 'operadores' : 'pts / operador';
  });
});

// Listener — Calcular distribuição
let _lastOps = null;
document.getElementById('btn-calcular-distrib').addEventListener('click', () => {
  const resultados = lastBatchResultados;
  if (!resultados?.length) return;

  const modo  = document.querySelector('input[name="distrib-modo"]:checked').value;
  const val   = parseInt(document.getElementById('inp-distrib').value);
  if (isNaN(val) || val < 1) { showToast('Informe um valor válido.', 'warn'); return; }

  const total = resultados.reduce((s, r) => s + subtotalPts(r), 0);
  const nOps  = modo === 'operadores'
    ? val
    : Math.max(1, Math.ceil(total / val));

  if (nOps > resultados.length) {
    showToast(`Há apenas ${resultados.length} UTs — máximo de ${resultados.length} operadores.`, 'warn');
    return;
  }

  _lastOps = distribuirUTs(resultados, nOps);
  renderDistribuicao(_lastOps);
  document.getElementById('btn-exportar-distrib').classList.remove('hidden');
});

// Listener — Exportar CSV
document.getElementById('btn-exportar-distrib').addEventListener('click', () => {
  if (_lastOps) _exportarDistribCSV(_lastOps);
});

// Listener — Fechar painel
document.getElementById('btn-fechar-distrib').addEventListener('click', () => {
  document.getElementById('distrib-section').classList.add('hidden');
});

document.getElementById('btn-fechar-lote').addEventListener('click', () => {
  document.getElementById('modal-lote').classList.add('hidden');
  document.getElementById('dif-lote-section').classList.add('hidden');
  document.getElementById('distrib-section').classList.add('hidden');
});
document.getElementById('btn-ver-ranking').addEventListener('click', () => abrirRanking());
document.getElementById('modal-lote').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-lote'))
    document.getElementById('modal-lote').classList.add('hidden');
});

// ── C4 — Sessão em localStorage ───────────────────────────────────────
const GE_STATE_KEY  = 'ge_state_v1';
let   _stateLoaded  = false;  // evita salvar durante a restauração

function saveState() {
  if (!_stateLoaded) return;
  try {
    localStorage.setItem(GE_STATE_KEY, JSON.stringify({
      projetoId:   currentProjetoId   || null,
      lpId:        currentLpId        || null,
      loteId:      filterLote.value   || null,
      sfKey:       filterSf.value     || null,
      markedUtIds: [...markedUtIds],
    }));
  } catch (_) {}
}

function loadSavedState() {
  try { return JSON.parse(localStorage.getItem(GE_STATE_KEY) || '{}'); }
  catch { return {}; }
}

// ── Helpers ───────────────────────────────────────────────────────────
function updateCalcBtn() {
  const btn           = document.getElementById('btn-calcular');
  const hint          = document.getElementById('calc-hint');
  // Em modo Mapa/Arquivo (sem UT do SAP) escala e LP são obrigatórias
  const temGeom       = !!(currentGeojson || currentUtId);
  const temEscala     = !!currentUtId || !!currentDenominadorEscala;
  const temLp         = !!currentUtId || !!getLpKey();   // SAP detecta auto; Mapa/Arquivo requer seleção
  const temIndividual = temGeom && !!currentSubfaseKey && temEscala && temLp;
  const temMarcadas   = markedUtIds.size > 0;
  const temFiltro     = !!(filterLote.value || filterSf.value);

  // Modo Arquivo/Mapa: quando há feições carregadas pelo arquivo OU geojson manual sem UT SAP
  // → nunca usa filtros/marcações do SAP.
  const modoArquivoMapa = !currentUtId && (!!currentGeojson || _arquivoFeatures.length > 0);
  btn.disabled = modoArquivoMapa
    ? !temIndividual
    : (!temIndividual && !temMarcadas && !temFiltro);

  // Exibe o motivo quando o botão está desabilitado em modo individual
  if (hint) {
    if (!modoArquivoMapa && (temMarcadas || (!currentGeojson && !currentUtId && temFiltro))) {
      hint.textContent = '';
    } else if (modoArquivoMapa && _arquivoFeatures.length > 0 && _arquivoSelectedIndices.size === 0) {
      hint.textContent = 'Selecione ao menos uma feição no mapa.';
    } else if (!temGeom) {
      hint.textContent = 'Selecione ou desenhe uma UT primeiro.';
    } else if (!currentSubfaseKey) {
      hint.textContent = 'Selecione a subfase.';
    } else if (!temEscala) {
      hint.textContent = 'Selecione a escala de produção.';
    } else if (!temLp) {
      hint.textContent = 'Selecione a linha de produção.';
    } else {
      hint.textContent = '';
    }
  }

  // Mostrar/ocultar checkbox "todas as subfases" — só faz sentido no modo lote SAP
  const todasSfRow   = document.getElementById('todas-sf-row');
  const chkTodas     = document.getElementById('chk-todas-subfases');
  const modoLoteSap  = !modoArquivoMapa && !currentUtId && (temMarcadas || temFiltro);
  if (todasSfRow) {
    todasSfRow.classList.toggle('hidden', !modoLoteSap);
    todasSfRow.classList.toggle('checked', !!chkTodas?.checked);
  }

  // Texto do botão
  const isAll     = currentSubfaseKey === '__all__';
  const todasAtivo = modoLoteSap && (chkTodas?.checked ?? false);
  if (modoArquivoMapa) {
    const n = _arquivoSelectedIndices.size;
    if (isAll)
      btn.textContent = n > 1 ? `✦ Calcular Total (${n} feições)` : '✦ Calcular Total (todas subfases)';
    else
      btn.textContent = n > 1 ? `⚡ Calcular ${n} feições` : '⚡ Calcular Pontos';
  } else if (isAll) {
    btn.textContent = '✦ Calcular Total (todas subfases)';
  } else if (temMarcadas) {
    const n = markedUtIds.size;
    btn.textContent = todasAtivo
      ? `✦ Calcular Total (${n} UT${n > 1 ? 's' : ''})`
      : `⚡ Calcular ${n} marcada${n > 1 ? 's' : ''}`;
  } else if (!currentUtId && !currentGeojson && temFiltro) {
    const n = getUtsFiltradas().length;
    btn.textContent = todasAtivo
      ? `✦ Calcular Total (${n} UT${n !== 1 ? 's' : ''})`
      : `⚡ Calcular ${n} UT${n !== 1 ? 's' : ''}`;
  } else {
    btn.textContent = '⚡ Calcular Pontos';
  }
}

function atualizarPreviewFiltro() {
  if (currentUtId || currentGeojson) return;
  const div    = document.getElementById('ut-preview');
  const lNome  = filterLote.options[filterLote.selectedIndex]?.text || '';
  const sfNome = filterSf.options[filterSf.selectedIndex]?.text || '';

  if (markedUtIds.size > 0) {
    const n = markedUtIds.size;
    div.innerHTML = `
      <div class="ut-nome">☑ ${n} UT${n > 1 ? 's' : ''} marcada${n > 1 ? 's' : ''}</div>
      <div class="ut-meta">
        ${filterLote.value ? `<span>Lote: <strong>${lNome}</strong></span>` : ''}
        ${filterSf.value   ? `<span>Subfase: <strong>${sfNome}</strong></span>` : ''}
      </div>`;
    return;
  }

  const n = getUtsFiltradas().length;
  if (!n || (!filterLote.value && !filterSf.value)) {
    div.innerHTML = '<div class="empty-state"><span class="empty-state-icon">🗺</span><p>Selecione uma UT na lista ou desenhe no mapa</p></div>';
    return;
  }
  div.innerHTML = `
    <div class="ut-nome">${n} UT${n > 1 ? 's' : ''} no filtro</div>
    <div class="ut-meta">
      ${filterLote.value ? `<span>Lote: <strong>${lNome}</strong></span>` : ''}
      ${filterSf.value   ? `<span>Subfase: <strong>${sfNome}</strong></span>` : ''}
    </div>`;
}

function setUtPreview(nome, props) {
  const extras = Object.entries(props)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `<span><strong>${k}:</strong> ${v}</span>`)
    .join(' · ');
  const div = document.getElementById('ut-preview');
  div.innerHTML =
    `<div class="preview-row">
       <div>
         <div class="ut-nome">${nome}</div>
         ${extras ? `<div class="ut-meta">${extras}</div>` : ''}
       </div>
       <button class="btn-link preview-remover" title="Remover seleção">✕</button>
     </div>`;
  div.querySelector('.preview-remover').addEventListener('click', () => {
    selectedUtId = null;
    utLayer.clearLayers();
    // Restaurar estilo normal em todas as UTs do filterLayer
    filterLayer.eachLayer(l => l.setStyle({ color:'#90caf9', weight:1.5, fillColor:'#90caf9', fillOpacity:0.08 }));
    resetGeom();
    showSubfaseSelector(true);
  });
}

function resetGeom() {
  _clearArquivoLayers();   // remove layers multi-feature do mapa
  currentGeojson = null; currentUtId = null; currentDenominadorEscala = null;
  currentDificuldade = null;
  hideDifRow();
  hideEscalaSelector(); hideLpSelector(); selEscala.value = '';
  // Reseta drop zone (B3)
  const dropText = document.getElementById('arquivo-drop-text');
  if (dropText) dropText.textContent = 'Escolher ou arrastar arquivo…';
  const arqStatus = document.getElementById('arquivo-status');
  if (arqStatus) arqStatus.textContent = '';
  updateCalcBtn();
  atualizarPreviewFiltro();
}

// ── Edição de dificuldade individual ─────────────────────────────────

const difRow       = document.getElementById('dif-row');
const difValor     = document.getElementById('dif-valor');
const difEditGroup = document.getElementById('dif-edit-group');
const difInp       = document.getElementById('inp-dif');
const difStatus    = document.getElementById('dif-status');

function showDifRow(utId, valor) {
  difRow.classList.remove('hidden');
  difValor.textContent   = valor ?? '–';
  difEditGroup.classList.add('hidden');
  difStatus.textContent  = '';
}

function hideDifRow() {
  difRow.classList.add('hidden');
}

document.getElementById('btn-editar-dif').addEventListener('click', () => {
  difInp.value = currentDificuldade ?? 0;
  difEditGroup.classList.remove('hidden');
  difStatus.textContent = '';
  difInp.focus();
  difInp.select();
});

document.getElementById('btn-cancelar-dif').addEventListener('click', () => {
  difEditGroup.classList.add('hidden');
  difStatus.textContent = '';
});

async function salvarDificuldadeIndividual() {
  const novaVal = Number(difInp.value);
  if (!Number.isFinite(novaVal)) { difStatus.textContent = 'Valor inválido'; return; }

  difStatus.textContent = 'Salvando…';
  try {
    const res = await fetch(`/api/uts/${currentUtId}/dificuldade`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dificuldade: novaVal }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.erro || `HTTP ${res.status}`);
    }
    const saved = await res.json();
    currentDificuldade = saved.dificuldade;
    // Atualiza cache local
    const ut = allUTs.find(u => u.id === currentUtId);
    if (ut) ut.dificuldade = saved.dificuldade;
    difValor.textContent = saved.dificuldade;
    difEditGroup.classList.add('hidden');
    difStatus.textContent = '✓ Salvo';
    setTimeout(() => { difStatus.textContent = ''; }, 2500);
  } catch (err) {
    difStatus.textContent = `Erro: ${err.message}`;
  }
}

document.getElementById('btn-salvar-dif').addEventListener('click', salvarDificuldadeIndividual);
difInp.addEventListener('keydown', e => { if (e.key === 'Enter') salvarDificuldadeIndividual(); });

// ── Modal Fórmulas ────────────────────────────────────────────────────
const modalFormulas = document.getElementById('modal-formulas');
const modalBody     = document.getElementById('modal-body');
let   formulasOk    = false;

document.getElementById('btn-formulas').addEventListener('click', async () => {
  modalFormulas.classList.remove('hidden');
  if (formulasOk) return;
  modalBody.innerHTML = `<div style="display:flex;align-items:center;gap:8px;padding:8px 0"><span class="cn-spin"></span><span>Carregando…</span></div>`;
  try {
    const d = await fetch('/api/formulas').then(r => r.json());
    modalBody.innerHTML = renderFormulas(d);
    modalBody.querySelectorAll('.subfase-card-header').forEach(h =>
      h.addEventListener('click', () => h.parentElement.classList.toggle('open'))
    );
    formulasOk = true;
  } catch (e) { modalBody.innerHTML = `<p class="hint">Erro: ${e.message}</p>`; }
});
document.getElementById('btn-fechar-formulas').addEventListener('click', () => modalFormulas.classList.add('hidden'));
modalFormulas.addEventListener('click', e => { if (e.target === modalFormulas) modalFormulas.classList.add('hidden'); });

// L3 · Topbar formula button — same action
document.getElementById('tb-btn-formulas')?.addEventListener('click', () =>
  document.getElementById('btn-formulas').click()
);

// L1 · Sidebar toggle
document.getElementById('btn-sidebar-toggle')?.addEventListener('click', () => {
  const sb   = document.getElementById('sidebar');
  const btn  = document.getElementById('btn-sidebar-toggle');
  const collapsed = sb.classList.toggle('collapsed');
  btn.textContent = collapsed ? '›' : '‹';
  btn.title       = collapsed ? 'Expandir sidebar' : 'Recolher sidebar';
  setTimeout(() => map.invalidateSize(), 310);
});

function renderFormulas(d) {
  const pesosHtml = Object.entries(d.pesos_geometria).map(([tipo, val]) => `
    <div class="peso-chip">
      <div class="tipo">${tipo}</div>
      <div class="valor">${val}</div>
    </div>`).join('');

  const sfHtml = d.subfases.map(sf => {
    const isVF = sf.key === 'verificacao_final';
    const rows = isVF
      ? `<tr><td colspan="4" style="color:#546e7a;font-style:italic;padding:8px">
           Proporcional ao score total das subfases. score_vf = total × ${sf.multiplicador}
         </td></tr>`
      : sf.camadas.map(c => {
          const expTag  = c.expoente !== 1 ? `<span class="tag-exp">^${c.expoente}</span>` : '';
          const joinTag = c.join ? `<br><span class="tag-join">⋈ ${c.join}</span>` : '';
          const formula = c.expoente !== 1
            ? `${c.metricaLabel}<sup>${c.expoente}</sup> × ${c.pesoGeo}`
            : `${c.metricaLabel} × ${c.pesoGeo}`;
          return `<tr>
            <td>${c.tabela}${joinTag}</td>
            <td>${c.metricaLabel}${expTag}</td>
            <td>${c.pesoGeo}</td>
            <td style="color:#90caf9">${formula}</td>
          </tr>`;
        }).join('');

    const notaHtml = sf.nota ? `<p class="hint" style="margin-top:8px;font-style:italic">${sf.nota}</p>` : '';

    return `<div class="subfase-card">
      <div class="subfase-card-header">
        <span class="sf-nome">${sf.nome}</span>
        <span class="sf-mult">× ${sf.multiplicador}</span>
      </div>
      <div class="subfase-card-body">
        ${isVF ? rows + notaHtml : `
        <table class="camadas-table">
          <thead><tr><th>Camada EDGV</th><th>Métrica</th><th>Peso geo</th><th>Contribuição</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>${notaHtml}`}
      </div>
    </div>`;
  }).join('');

  return `
    <p class="hint">Pesos versão <strong style="color:#cfd8dc">${d.versao_pesos}</strong> — ${d.data_pesos}</p>
    <div>
      <h3 style="font-size:11px;color:#4fc3f7;text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px">Fórmula Geral</h3>
      <div class="formula-box">${d.formula_geral.join('\n')}</div>
    </div>
    <div>
      <h3 style="font-size:11px;color:#4fc3f7;text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px">Pesos por Geometria</h3>
      <div class="pesos-grid">${pesosHtml}</div>
    </div>
    <div>
      <h3 style="font-size:11px;color:#4fc3f7;text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px">Subfases — clique para expandir</h3>
      <div style="display:flex;flex-direction:column;gap:6px">${sfHtml}</div>
    </div>`;
}

// ── L4 · Responsividade — colapsar sidebar em telas pequenas ──────────
if (window.innerWidth < 1100) {
  const sb  = document.getElementById('sidebar');
  const btn = document.getElementById('btn-sidebar-toggle');
  if (sb && btn) {
    sb.classList.add('collapsed');
    btn.textContent = '›';
    btn.title = 'Expandir sidebar';
    setTimeout(() => map.invalidateSize(), 310);
  }
}
