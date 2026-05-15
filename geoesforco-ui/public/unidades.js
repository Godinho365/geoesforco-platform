/* ════════════════════════════════════════════════════════════════
   GeoEsforço — Unidades de Trabalho
   Tabela gerenciável: filtro, ordenação, edição inline, export CSV
════════════════════════════════════════════════════════════════ */

'use strict';

const PAGE_SIZE = 60;

// ── Estado ──────────────────────────────────────────────────────────────
let allUTs    = [];
let projetos  = [];
let lps       = [];
let lotes     = [];
let subfases  = [];

let filters  = { search: '', projeto_id: null, lp_id: null, lote_id: null,
                 subfase_key: null, disponivel: null, com_dif: null };
let sort     = { col: 'prioridade', dir: 'asc' };
let page     = 0;
let pending  = new Map();   // ut_id → { dificuldade?, prioridade? }
let loading  = false;

// ── Bootstrap ────────────────────────────────────────────────────────────
async function init() {
  setLoading(true);
  try {
    const [utsRes, projRes, lpsRes] = await Promise.allSettled([
      fetch('/api/uts/lista').then(r => r.json()),
      fetch('/api/projetos').then(r => r.json()),
      fetch('/api/linhas-producao').then(r => r.json()),
    ]);

    allUTs   = utsRes.status   === 'fulfilled' && Array.isArray(utsRes.value)   ? utsRes.value   : [];
    projetos = projRes.status  === 'fulfilled' && Array.isArray(projRes.value)  ? projRes.value  : [];
    lps      = lpsRes.status   === 'fulfilled' && Array.isArray(lpsRes.value)   ? lpsRes.value   : [];

    // Deriva lotes e subfases dos dados das UTs (evita endpoint extra)
    const lotesMap = new Map();
    const sfMap    = new Map();
    allUTs.forEach(u => {
      if (u.lote_id && !lotesMap.has(u.lote_id))
        lotesMap.set(u.lote_id, { id: u.lote_id, nome: u.lote || '–',
          projeto_id: u.projeto_id, linha_producao_id: u.linha_producao_id });
      if (u.subfase_key && !sfMap.has(u.subfase_key))
        sfMap.set(u.subfase_key, { key: u.subfase_key, nome: u.subfase_nome || u.subfase_key });
    });
    lotes    = [...lotesMap.values()].sort((a, b) => a.nome.localeCompare(b.nome));
    subfases = [...sfMap.values()].sort((a, b) => a.nome.localeCompare(b.nome));

    populateFiltros();
    render();
  } catch (err) {
    document.getElementById('uts-tbody').innerHTML =
      `<tr><td colspan="10" class="empty-msg">Erro ao carregar dados: ${esc(err.message)}</td></tr>`;
  } finally {
    setLoading(false);
  }
}

// ── Dados filtrados e ordenados ──────────────────────────────────────────
function getFiltered() {
  const q = filters.search.toLowerCase().trim();
  return allUTs.filter(u => {
    if (q) {
      const haystack = `${u.nome} ${u.lote || ''} ${u.subfase_nome || ''}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (filters.projeto_id  != null && u.projeto_id        !== filters.projeto_id)  return false;
    if (filters.lp_id       != null && u.linha_producao_id !== filters.lp_id)       return false;
    if (filters.lote_id     != null && u.lote_id           !== filters.lote_id)     return false;
    if (filters.subfase_key != null && u.subfase_key        !== filters.subfase_key) return false;
    if (filters.disponivel  != null && u.disponivel         !== filters.disponivel)  return false;
    if (filters.com_dif === 'sim' && getDif(u) === 0) return false;
    if (filters.com_dif === 'nao' && getDif(u) !== 0) return false;
    return true;
  });
}

function getDif(u)  { const p = pending.get(u.id); return p?.dificuldade !== undefined ? p.dificuldade : (u.dificuldade ?? 0); }
function getPrio(u) { const p = pending.get(u.id); return p?.prioridade  !== undefined ? p.prioridade  : (u.prioridade  ?? 1); }

function getSorted(arr) {
  const { col, dir } = sort;
  return [...arr].sort((a, b) => {
    let va = col === 'dificuldade' ? getDif(a)
           : col === 'prioridade'  ? getPrio(a)
           : (a[col] ?? '');
    let vb = col === 'dificuldade' ? getDif(b)
           : col === 'prioridade'  ? getPrio(b)
           : (b[col] ?? '');
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ?  1 : -1;
    return 0;
  });
}

// ── Render principal ─────────────────────────────────────────────────────
function render() {
  const filtered = getFiltered();
  const sorted   = getSorted(filtered);
  const total    = sorted.length;
  const pages    = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page >= pages) page = pages - 1;
  if (page < 0)      page = 0;

  const slice = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Calcula escala de cores de dificuldade com base nos valores filtrados
  const difVals   = filtered.map(getDif).filter(v => v > 0);
  const difMin    = difVals.length ? Math.min(...difVals) : 0;
  const difMax    = difVals.length ? Math.max(...difVals) : 0;

  renderStats(filtered, difMin, difMax);
  renderTabela(slice, sorted, difMin, difMax);
  renderPaginacao(total, pages);
  renderPendingBar();
  renderSortHeaders();
}

// ── Stats bar ────────────────────────────────────────────────────────────
function renderStats(filtered, difMin, difMax) {
  const disp    = filtered.filter(u => u.disponivel).length;
  const comDif  = filtered.filter(u => getDif(u) > 0).length;
  const difs    = filtered.map(getDif);
  const somaPos = difs.filter(v => v > 0);
  const media   = somaPos.length ? (somaPos.reduce((a, b) => a + b, 0) / somaPos.length) : 0;

  document.getElementById('st-total').textContent      = filtered.length.toLocaleString('pt-BR');
  document.getElementById('st-disp').textContent       = disp.toLocaleString('pt-BR');
  document.getElementById('st-com-dif').textContent    = comDif.toLocaleString('pt-BR');
  document.getElementById('st-dif-media').textContent  = media > 0 ? media.toFixed(1) : '–';
  document.getElementById('st-dif-range').textContent  =
    difMin === difMax && difMin === 0 ? '' : `${difMin.toLocaleString('pt-BR')} – ${difMax.toLocaleString('pt-BR')}`;

  // Histograma com 6 baldes uniformes sobre o range
  renderHistograma(difs, difMin, difMax);
}

function renderHistograma(difs, difMin, difMax) {
  const el = document.getElementById('st-hist');
  if (difMax === 0) { el.innerHTML = ''; return; }

  const N     = 6;
  const step  = (difMax - difMin) / N || 1;
  const balde = Array(N).fill(0);
  difs.filter(v => v > 0).forEach(v => {
    const i = Math.min(N - 1, Math.floor((v - difMin) / step));
    balde[i]++;
  });
  const maxB = Math.max(1, ...balde);
  const colors = ['#43a047','#66bb6a','#f9a825','#fb8c00','#e53935','#b71c1c'];

  el.innerHTML = balde.map((n, i) => {
    const h     = Math.round((n / maxB) * 28) + 2;
    const label = i === 0 ? difMin.toLocaleString('pt-BR')
                : i === N-1 ? difMax.toLocaleString('pt-BR') : '';
    return `<span class="hist-bar" title="${Math.round(difMin + i*step)}–${Math.round(difMin + (i+1)*step)}: ${n} UTs"
              style="height:${h}px;background:${colors[i]}"></span>`;
  }).join('') + `<span class="hist-label-l">${difMin.toLocaleString('pt-BR')}</span>`
              + `<span class="hist-label-r">${difMax.toLocaleString('pt-BR')}</span>`;
}

// ── Tabela ───────────────────────────────────────────────────────────────
function renderTabela(slice, allSorted, difMin, difMax) {
  const tbody    = document.getElementById('uts-tbody');
  const startIdx = page * PAGE_SIZE;

  if (!slice.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty-msg">Nenhuma UT encontrada para os filtros aplicados.</td></tr>';
    return;
  }

  tbody.innerHTML = slice.map((u, i) => {
    const dif     = getDif(u);
    const prio    = getPrio(u);
    const isDirty = pending.has(u.id);
    const rowIdx  = startIdx + i + 1;

    const difBadge  = renderDifBadge(dif, difMin, difMax);
    const dispBadge = u.disponivel
      ? '<span class="badge badge-green">Sim</span>'
      : '<span class="badge badge-gray">Não</span>';
    const escStr = u.denominador_escala
      ? `1:${Number(u.denominador_escala).toLocaleString('pt-BR')}` : '–';
    const lpNome = lps.find(l => l.id === u.linha_producao_id)?.nome_abrev
                || lps.find(l => l.id === u.linha_producao_id)?.nome || '–';

    return `<tr data-id="${u.id}" class="${isDirty ? 'row-dirty' : ''}">
      <td class="col-idx">${rowIdx}</td>
      <td class="col-nome">
        <span class="ut-nome">${esc(u.nome)}</span>
        ${isDirty ? '<span class="dirty-dot" title="Alteração pendente">●</span>' : ''}
      </td>
      <td class="col-lote" title="${esc(u.lote || '')}"><span class="truncate">${esc(u.lote || '–')}</span></td>
      <td class="col-lp">${esc(lpNome)}</td>
      <td class="col-sf" title="${esc(u.subfase_nome || '')}"><span class="truncate">${esc(u.subfase_nome || '–')}</span></td>
      <td class="col-esc">${escStr}</td>
      <td class="col-disp">${dispBadge}</td>
      <td class="col-prio editable" data-field="prioridade" data-id="${u.id}" title="Clique para editar prioridade">
        <span class="prio-val">${prio}</span>
        <span class="edit-icon">✎</span>
      </td>
      <td class="col-dif editable" data-field="dificuldade" data-id="${u.id}" title="Clique para editar dificuldade">
        ${difBadge}
        <span class="edit-icon">✎</span>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.editable').forEach(cell => {
    cell.addEventListener('click', () => iniciarEdicao(cell));
  });
}

function renderDifBadge(dif, difMin, difMax) {
  if (dif === 0) return '<span class="dif-badge dif-zero">–</span>';
  const t     = difMax > difMin ? (dif - difMin) / (difMax - difMin) : 0.5;
  const color = scoreColor(t);
  return `<span class="dif-badge" style="background:${color}">${dif.toLocaleString('pt-BR')}</span>`;
}

// Reutiliza a mesma paleta do mapa principal (azul→amarelo→vermelho)
function scoreColor(t) {
  if (t < 0.5) {
    const g = Math.round(150 + t * 2 * 105);
    return `rgb(30,${g},220)`;
  }
  const r = Math.round(200 + (t - 0.5) * 2 * 55);
  const g = Math.round(200 - (t - 0.5) * 2 * 170);
  return `rgb(${r},${g},30)`;
}

// ── Edição inline ────────────────────────────────────────────────────────
function iniciarEdicao(cell) {
  if (cell.querySelector('input')) return;

  const field = cell.dataset.field;
  const id    = parseInt(cell.dataset.id);
  const ut    = allUTs.find(u => u.id === id);
  const p     = pending.get(id) || {};
  const cur   = p[field] !== undefined ? p[field] : (ut[field] ?? 0);

  const inp = document.createElement('input');
  inp.type      = 'number';
  inp.min       = '0';
  inp.step      = '1';
  inp.value     = cur;
  inp.className = 'cell-inp';

  cell.innerHTML = '';
  cell.appendChild(inp);
  inp.focus();
  inp.select();

  function commit() {
    const v = parseInt(inp.value);
    if (!isNaN(v) && v >= 0) {
      const entry = pending.get(id) || {};
      entry[field] = v;
      pending.set(id, entry);
    }
    render();
  }

  inp.addEventListener('blur',    commit);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); inp.blur(); }
    if (e.key === 'Escape') { pending.delete(id); render(); }
  });
}

// ── Paginação ─────────────────────────────────────────────────────────────
function renderPaginacao(total, pages) {
  const el = document.getElementById('uts-paginacao');
  const from = page * PAGE_SIZE + 1;
  const to   = Math.min((page + 1) * PAGE_SIZE, total);

  if (pages <= 1) {
    el.innerHTML = `<span class="pag-info">${total.toLocaleString('pt-BR')} resultado${total !== 1 ? 's' : ''}</span>`;
    return;
  }

  let btns = '';
  const maxBtns = 7;
  let start = Math.max(0, page - Math.floor(maxBtns / 2));
  let end   = Math.min(pages - 1, start + maxBtns - 1);
  if (end - start < maxBtns - 1) start = Math.max(0, end - maxBtns + 1);

  for (let i = start; i <= end; i++) {
    btns += `<button class="pag-btn${i === page ? ' pag-active' : ''}" data-pg="${i}">${i + 1}</button>`;
  }

  el.innerHTML =
    `<span class="pag-info">${from.toLocaleString('pt-BR')}–${to.toLocaleString('pt-BR')} de ${total.toLocaleString('pt-BR')}</span>
     <button class="pag-btn pag-nav" id="pag-prev" ${page === 0 ? 'disabled' : ''}>‹</button>
     ${btns}
     <button class="pag-btn pag-nav" id="pag-next" ${page >= pages - 1 ? 'disabled' : ''}>›</button>`;

  el.querySelector('#pag-prev')?.addEventListener('click', () => { page--; render(); });
  el.querySelector('#pag-next')?.addEventListener('click', () => { page++; render(); });
  el.querySelectorAll('[data-pg]').forEach(b =>
    b.addEventListener('click', () => { page = parseInt(b.dataset.pg); render(); }));
}

// ── Barra de pendentes ────────────────────────────────────────────────────
function renderPendingBar() {
  const n   = pending.size;
  const bar = document.getElementById('pending-bar');
  const btn = document.getElementById('btn-salvar');

  if (n === 0) {
    bar.classList.add('hidden');
  } else {
    bar.classList.remove('hidden');
    document.getElementById('pending-count').textContent =
      `${n} alteração${n !== 1 ? 'ões' : ''} pendente${n !== 1 ? 's' : ''}`;
    btn.textContent = `💾 Salvar ${n} alteração${n !== 1 ? 'ões' : ''}`;
  }
}

// ── Sort headers ──────────────────────────────────────────────────────────
function renderSortHeaders() {
  document.querySelectorAll('#uts-table thead th[data-col]').forEach(th => {
    const col = th.dataset.col;
    th.classList.toggle('sort-asc',  sort.col === col && sort.dir === 'asc');
    th.classList.toggle('sort-desc', sort.col === col && sort.dir === 'desc');
  });
}

// ── Populate filtros ──────────────────────────────────────────────────────
function populateFiltros() {
  const add = (sel, id, nome) => {
    const o = Object.assign(document.createElement('option'), { value: id, textContent: nome });
    sel.appendChild(o);
  };

  const pSel = document.getElementById('f-projeto');
  projetos.forEach(p => add(pSel, p.id, p.nome));

  const lpSel = document.getElementById('f-lp');
  lps.forEach(l => add(lpSel, l.id, l.nome_abrev || l.nome));

  atualizarLotesSel();

  const sfSel = document.getElementById('f-subfase');
  subfases.forEach(s => add(sfSel, s.key, s.nome));
}

function atualizarLotesSel() {
  const sel = document.getElementById('f-lote');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Todos os lotes</option>';
  lotes
    .filter(l => (filters.projeto_id == null || l.projeto_id === filters.projeto_id)
              && (filters.lp_id      == null || l.linha_producao_id === filters.lp_id))
    .forEach(l => {
      const o = Object.assign(document.createElement('option'), { value: l.id, textContent: l.nome });
      sel.appendChild(o);
    });
  if ([...sel.options].some(o => Number(o.value) === Number(cur))) sel.value = cur;
}

// ── Event listeners dos filtros ───────────────────────────────────────────
function onFilter(key, parse) {
  return e => {
    filters[key] = parse(e.target.value);
    if (key === 'projeto_id' || key === 'lp_id') atualizarLotesSel();
    page = 0;
    render();
  };
}

document.getElementById('f-search').addEventListener('input', e => {
  filters.search = e.target.value;
  page = 0;
  render();
});
document.getElementById('f-projeto').addEventListener('change',   onFilter('projeto_id',  v => v ? parseInt(v) : null));
document.getElementById('f-lp').addEventListener('change',        onFilter('lp_id',       v => v ? parseInt(v) : null));
document.getElementById('f-lote').addEventListener('change',      onFilter('lote_id',     v => v ? parseInt(v) : null));
document.getElementById('f-subfase').addEventListener('change',   onFilter('subfase_key', v => v || null));
document.getElementById('f-disponivel').addEventListener('change',onFilter('disponivel',  v => v === '' ? null : v === 'true'));
document.getElementById('f-com-dif').addEventListener('change',   onFilter('com_dif',     v => v || null));

document.getElementById('btn-limpar').addEventListener('click', () => {
  filters = { search: '', projeto_id: null, lp_id: null, lote_id: null, subfase_key: null, disponivel: null, com_dif: null };
  ['f-search','f-projeto','f-lp','f-lote','f-subfase','f-disponivel','f-com-dif']
    .forEach(id => document.getElementById(id).value = '');
  atualizarLotesSel();
  page = 0;
  render();
});

// ── Sort ao clicar no header ──────────────────────────────────────────────
document.querySelector('#uts-table thead').addEventListener('click', e => {
  const th = e.target.closest('th[data-col]');
  if (!th) return;
  const col = th.dataset.col;
  sort.dir = sort.col === col && sort.dir === 'asc' ? 'desc' : 'asc';
  sort.col = col;
  page     = 0;
  render();
});

// ── Salvar pendentes ──────────────────────────────────────────────────────
document.getElementById('btn-salvar').addEventListener('click', salvarPendentes);
document.getElementById('btn-descartar').addEventListener('click', () => {
  pending.clear();
  render();
});

async function salvarPendentes() {
  if (!pending.size) return;

  const btn = document.getElementById('btn-salvar');
  btn.disabled = true;

  const entries    = [...pending.entries()];
  const difUpdates = entries
    .filter(([, v]) => v.dificuldade !== undefined)
    .map(([id, v]) => ({ id, dificuldade: v.dificuldade }));
  const prioUpdates = entries
    .filter(([, v]) => v.prioridade !== undefined)
    .map(([id, v]) => ({ id, prioridade: v.prioridade }));

  try {
    const reqs = [];
    if (difUpdates.length)
      reqs.push(fetch('/api/uts/dificuldade/lote', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body:   JSON.stringify({ updates: difUpdates }),
      }).then(r => r.json()));

    if (prioUpdates.length)
      reqs.push(fetch('/api/uts/prioridade/lote', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body:   JSON.stringify({ updates: prioUpdates }),
      }).then(r => r.json()));

    const results = await Promise.all(reqs);
    const erros   = results.filter(r => r.erro);
    if (erros.length) throw new Error(erros[0].erro);

    // Aplica ao cache local
    entries.forEach(([id, v]) => {
      const ut = allUTs.find(u => u.id === id);
      if (!ut) return;
      if (v.dificuldade !== undefined) ut.dificuldade = v.dificuldade;
      if (v.prioridade  !== undefined) ut.prioridade  = v.prioridade;
    });

    const n = pending.size;
    pending.clear();
    render();
    toast(`✓ ${n} UT${n !== 1 ? 's' : ''} atualizada${n !== 1 ? 's' : ''} com sucesso`, 'success');
  } catch (err) {
    toast(`Erro ao salvar: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ── Exportar CSV ──────────────────────────────────────────────────────────
document.getElementById('btn-csv').addEventListener('click', exportarCSV);

function exportarCSV() {
  const rows = getSorted(getFiltered());
  const cols = ['ID','Nome','Projeto','Lote','LP','Subfase','Escala','Disponível','Prioridade','Dificuldade'];
  const linhas = rows.map(u => [
    u.id,
    u.nome,
    projetos.find(p => p.id === u.projeto_id)?.nome || '',
    u.lote || '',
    lps.find(l => l.id === u.linha_producao_id)?.nome || '',
    u.subfase_nome || '',
    u.denominador_escala ? `1:${u.denominador_escala}` : '',
    u.disponivel ? 'Sim' : 'Não',
    getPrio(u),
    getDif(u),
  ].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));

  const csv  = [cols.join(','), ...linhas].join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob), download: 'unidades_trabalho.csv',
  }).click();
}

// ── Toast ─────────────────────────────────────────────────────────────────
let _toastTimer = null;
function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent  = msg;
  el.className    = `toast toast-${type} toast-show`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('toast-show'), 3200);
}

// ── Loading ────────────────────────────────────────────────────────────────
function setLoading(v) {
  loading = v;
  document.getElementById('uts-loading').classList.toggle('hidden', !v);
  document.getElementById('uts-table-wrap').classList.toggle('hidden', v);
}

// ── Helpers ────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Start ──────────────────────────────────────────────────────────────────
init();
