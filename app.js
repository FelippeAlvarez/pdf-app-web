'use strict';
/* Interface do app. Fala com o motor via Tauri: invoke('api', {name, payload}).
   Diálogos de arquivo: invoke('pick_files' | 'pick_folder' | 'reveal'). */
const T = window.__TAURI__;
const invoke = (cmd, args) => T.core.invoke(cmd, args);
const api = (name, payload) => invoke('api', { name, payload });
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const baseName = p => p.split(/[\\/]/).pop();
const stem = p => baseName(p).replace(/\.pdf$/i, '');
const oldAce = n => n.replace(/_OldAce$/i, '') + '_OldAce';
const IS_WEB = !!window.PDF_OLD_ACE_WEB;
const dirOf = p => p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')));
const mb = b => b < 1048576 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / 1048576).toFixed(2).replace('.', ',') + ' MB';
const errMsg = e => (e && e.message) ? e.message : String(e);

/* ---------- abas ---------- */
$$('.tab').forEach(b => b.addEventListener('click', () => {
  $$('.tab').forEach(x => { x.classList.toggle('active', x === b); x.setAttribute('aria-selected', x === b); });
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + b.dataset.tab));
}));

/* ---------- modal ---------- */
function modal(title, bodyHtml, buttons) {
  return new Promise(res => {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = bodyHtml;
    const act = $('#modal-actions'); act.innerHTML = '';
    buttons.forEach(b => {
      const el = document.createElement('button');
      el.textContent = b.label; if (b.primary) el.className = 'primary';
      el.onclick = () => { const v = b.value; const extra = $('#modal-body input') ? $('#modal-body input').value : null; $('#modal').hidden = true; res({ value: v, input: extra }); };
      act.appendChild(el);
    });
    $('#modal').hidden = false;
    const f = $('#modal-body input') || act.querySelector('.primary'); if (f) f.focus();
  });
}

/* ---------- estado: organizar ---------- */
const S = { sources: [], entries: [], sel: new Set(), last: null, hist: [], nextId: 1, thumbs: new Map(), outDir: '', busy: false };
const key = (src, page) => src + ':' + page;

function snapshot() { S.hist.push(JSON.stringify(S.entries)); if (S.hist.length > 100) S.hist.shift(); $('#btn-undo').disabled = false; }
function undo() {
  if (!S.hist.length) return;
  S.entries = JSON.parse(S.hist.pop()); S.sel = new Set([...S.sel].filter(id => S.entries.some(e => e.id === id)));
  $('#btn-undo').disabled = !S.hist.length; render();
}

async function openWithPassword(path) {
  let password = null;
  for (;;) {
    try { const info = await api('open_info', { path, password }); return { info, password }; }
    catch (e) {
      if (e && e.code === 'password_required' || e && e.code === 'password_wrong') {
        const r = await modal('PDF protegido por senha',
          `<p>${esc(baseName(path))}</p>${e.code === 'password_wrong' ? '<p class="msg err">Senha incorreta.</p>' : ''}<input type="password" id="pw" autocomplete="off" aria-label="Senha">`,
          [{ label: 'Cancelar', value: 'no' }, { label: 'Abrir', value: 'ok', primary: true }]);
        if (r.value !== 'ok' || !r.input) return null;
        password = r.input;
      } else throw e;
    }
  }
}

async function addSource(path, insertAt /* índice na lista de entries ou null */) {
  const got = await openWithPassword(path); if (!got) return 0;
  const { info, password } = got;
  $('#banner-signed').hidden = !info.signed;
  if (info.signed) { toast('err', 'O arquivo "' + baseName(path) + '" possui assinatura digital e não pode ser processado; foi ignorado.'); return 0; }
  const idx = S.sources.length;
  S.sources.push({ path, password, pages: info.pages, name: baseName(path), form: info.has_form, size: info.size_bytes });
  const news = Array.from({ length: info.pages }, (_, i) => ({ id: S.nextId++, src: idx, page: i + 1, rot: 0 }));
  if (insertAt == null) S.entries.push(...news); else S.entries.splice(insertAt, 0, ...news);
  if (idx === 0) {
    $('#base-name').value = oldAce(stem(path));
    S.outDir = IS_WEB ? '' : dirOf(path); $('#out-dir').value = S.outDir;
  }
  render();
  return news.length;
}

async function onOpen() {
  const files = await invoke('pick_files', { multiple: true }); if (!files || !files.length) return;
  S.sources = []; S.entries = []; S.sel.clear(); S.hist = []; S.thumbs.clear(); $('#btn-undo').disabled = true; $('#result-org').innerHTML = '';
  let ok = 0;
  for (const f of files) { if (await addSource(f, null)) ok++; }
  if (ok > 1) toast('ok', ok + ' arquivos reunidos. Ajuste a ordem dos arquivos ou das páginas e clique em Processar.');
}
async function onInsert() {
  const files = await invoke('pick_files', { multiple: true }); if (!files || !files.length) return;
  snapshot();
  const selIdx = S.entries.map((e, i) => S.sel.has(e.id) ? i : -1).filter(i => i >= 0);
  let at = selIdx.length ? Math.max(...selIdx) + 1 : S.entries.length;
  for (const f of files) at += await addSource(f, at);
}

/* ---------- miniaturas (carga preguiçosa) ---------- */
const thumbQueue = new Map(); let thumbRunning = false;
function wantThumb(src, page) {
  const k = key(src, page); if (S.thumbs.has(k) || thumbQueue.has(k)) return;
  thumbQueue.set(k, { src, page }); pumpThumbs();
}
async function pumpThumbs() {
  if (thumbRunning) return; thumbRunning = true;
  try {
    while (thumbQueue.size) {
      const first = thumbQueue.values().next().value;
      // agrupa páginas consecutivas da mesma fonte (até 8)
      const batch = [first]; thumbQueue.delete(key(first.src, first.page));
      for (let p = first.page + 1; batch.length < 8; p++) {
        const k = key(first.src, p); if (!thumbQueue.has(k)) break;
        batch.push(thumbQueue.get(k)); thumbQueue.delete(k);
      }
      const s = S.sources[first.src]; if (!s) continue;
      try {
        const imgs = await api('thumbnails', { path: s.path, password: s.password, from: first.page, count: batch.length, dpi: 40 });
        imgs.forEach((b64, i) => S.thumbs.set(key(first.src, first.page + i), 'data:image/png;base64,' + b64));
      } catch (e) { batch.forEach(b => S.thumbs.set(key(b.src, b.page), 'err')); }
      paintThumbs();
    }
  } finally { thumbRunning = false; }
}
function paintThumbs() {
  $$('.pcard').forEach(c => {
    const t = S.thumbs.get(key(+c.dataset.src, +c.dataset.page)); const box = $('.thumb', c);
    if (t && !box.dataset.done) {
      box.dataset.done = '1';
      box.innerHTML = t === 'err' ? '<span class="muted">sem prévia</span>' : `<img alt="" src="${t}">`;
      const im = $('img', box); if (im) im.style.transform = `rotate(${+c.dataset.rot}deg)`;
    }
  });
}

/* ---------- renderização da grade ---------- */
function render() {
  const has = S.entries.length > 0;
  $('#empty').hidden = has;
  $$('#btn-insert,#btn-rotl,#btn-rotr,#btn-dup,#btn-del,#btn-all,#btn-run,#btn-multi').forEach(b => b.disabled = !has);
  renderFiles();
  const grid = $('#grid'); grid.innerHTML = '';
  S.entries.forEach((e, i) => {
    const c = document.createElement('div');
    c.className = 'pcard' + (S.sel.has(e.id) ? ' sel' : '');
    c.draggable = true; c.tabIndex = 0; c.dataset.id = e.id; c.dataset.src = e.src; c.dataset.page = e.page; c.dataset.rot = e.rot; c.dataset.idx = i;
    const srcTag = S.sources.length > 1 ? `<span class="tag" title="${esc(S.sources[e.src].name)}">${e.src + 1}</span>` : '';
    c.innerHTML = `<div class="thumb"><div class="ph"></div></div><div class="lbl"><span>${i + 1}</span><span>${srcTag} p.${e.page}${e.rot ? ' ↻' + ((e.rot % 360) + 360) % 360 + '°' : ''}</span></div>`;
    c.setAttribute('aria-label', `Posição ${i + 1}, página ${e.page}`);
    c.addEventListener('click', ev => selectCard(e, ev));
    c.addEventListener('contextmenu', ev => ev.preventDefault());
    c.addEventListener('dragstart', ev => { if (!S.sel.has(e.id)) { S.sel = new Set([e.id]); } c.classList.add('dragging'); ev.dataTransfer.setData('text/plain', 'pages'); ev.dataTransfer.effectAllowed = 'move'; });
    c.addEventListener('dragend', () => { c.classList.remove('dragging'); clearDrop(); });
    c.addEventListener('dragover', ev => { ev.preventDefault(); clearDrop(); const r = c.getBoundingClientRect(); c.classList.add(ev.clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after'); });
    c.addEventListener('drop', ev => { ev.preventDefault(); const r = c.getBoundingClientRect(); moveSelectedTo(i + (ev.clientX < r.left + r.width / 2 ? 0 : 1)); clearDrop(); });
    grid.appendChild(c);
    wantThumb(e.src, e.page);
  });
  paintThumbs();
  const total = S.entries.length;
  $('#doc-info').textContent = has ? `${S.sources.map(s => s.name).join(' + ')} — ${total} página${total > 1 ? 's' : ''}${S.sel.size ? `, ${S.sel.size} selecionada${S.sel.size > 1 ? 's' : ''}` : ''}` : '';
  const hasSel = S.sel.size > 0;
  $$('#btn-rotl,#btn-rotr,#btn-dup,#btn-del,#btn-left,#btn-right,#btn-moveto').forEach(b => b.disabled = !hasSel);
  if (!has) $('#btn-undo').disabled = !S.hist.length;
}
function clearDrop() { $$('.drop-before,.drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after')); }

function selectCard(e, ev) {
  const i = S.entries.findIndex(x => x.id === e.id);
  if (ev.shiftKey && S.last != null) {
    const a = Math.min(S.last, i), b = Math.max(S.last, i);
    if (!ev.ctrlKey && !ev.metaKey) S.sel.clear();
    for (let k = a; k <= b; k++) S.sel.add(S.entries[k].id);
  } else if (ev.ctrlKey || ev.metaKey || S.multi) {
    S.sel.has(e.id) ? S.sel.delete(e.id) : S.sel.add(e.id); S.last = i;
  } else { S.sel = new Set([e.id]); S.last = i; }
  render();
}

function moveSelectedTo(pos) {
  const moving = S.entries.filter(e => S.sel.has(e.id)); if (!moving.length) return;
  snapshot();
  const before = S.entries.slice(0, pos).filter(e => !S.sel.has(e.id));
  const after = S.entries.slice(pos).filter(e => !S.sel.has(e.id));
  S.entries = [...before, ...moving, ...after]; render();
}
function rotateSel(d) { if (!S.sel.size) return; snapshot(); S.entries.forEach(e => { if (S.sel.has(e.id)) e.rot = (((e.rot + d) % 360) + 360) % 360; }); render(); }
function deleteSel() {
  if (!S.sel.size) return;
  if (S.sel.size >= S.entries.length) { toast('err', 'Não é possível excluir todas as páginas.'); return; }
  snapshot(); S.entries = S.entries.filter(e => !S.sel.has(e.id)); S.sel.clear(); render();
}
function dupSel() {
  if (!S.sel.size) return; snapshot();
  const out = []; const newSel = new Set();
  S.entries.forEach(e => { out.push(e); if (S.sel.has(e.id)) { const c = { ...e, id: S.nextId++ }; out.push(c); newSel.add(c.id); } });
  S.entries = out; S.sel = newSel; render();
}


/* ---------- mover por botões, por posição e por toque ---------- */
S.multi = false;
function moveSelectedBy(d) {
  if (!S.sel.size) return;
  const idx = S.entries.map((e, i) => S.sel.has(e.id) ? i : -1).filter(i => i >= 0);
  const pos = d < 0 ? Math.max(0, idx[0] - 1) : Math.min(S.entries.length, idx[idx.length - 1] + 2);
  moveSelectedTo(pos);
  const el = document.querySelector('.pcard.sel'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
}
function moveSelectedToIndex(n /* posição final (1-based) da primeira selecionada */) {
  const moving = S.entries.filter(e => S.sel.has(e.id)); if (!moving.length) return;
  snapshot();
  const rest = S.entries.filter(e => !S.sel.has(e.id));
  const at = Math.max(0, Math.min(rest.length, n - 1));
  S.entries = [...rest.slice(0, at), ...moving, ...rest.slice(at)]; render();
}
async function moveSelectedPrompt() {
  if (!S.sel.size) return;
  const r = await modal('Mover para a posição', `<p>Nova posição da primeira página selecionada (1 a ${S.entries.length}).</p><input type="number" min="1" max="${S.entries.length}" value="1" style="width:100%">`, [{ label: 'Cancelar', value: 'no' }, { label: 'Mover', value: 'ok', primary: true }]);
  if (r.value !== 'ok') return;
  const n = Math.round(Number(r.input)); if (!(n >= 1 && n <= S.entries.length)) { toast('err', 'Posição inválida.'); return; }
  moveSelectedToIndex(n);
}
$('#btn-left').onclick = () => moveSelectedBy(-1);
$('#btn-right').onclick = () => moveSelectedBy(1);
$('#btn-moveto').onclick = () => moveSelectedPrompt();
$('#btn-multi').onclick = () => { S.multi = !S.multi; $('#btn-multi').classList.toggle('on', S.multi); $('#btn-multi').setAttribute('aria-pressed', S.multi); };

/* arrastar com o dedo: segurar ~0,4 s numa página e arrastar */
(function touchDrag() {
  const grid = $('#grid'), wrap = $('#grid-wrap');
  let timer = null, drag = null, sx = 0, sy = 0;
  const cardAt = (x, y) => { const el = document.elementFromPoint(x, y); return el && el.closest ? el.closest('.pcard') : null; };
  const cancel = () => { clearTimeout(timer); timer = null; };
  grid.addEventListener('touchstart', ev => {
    if (ev.touches.length !== 1) { cancel(); return; }
    const c = ev.target.closest('.pcard'); if (!c) return;
    const t = ev.touches[0]; sx = t.clientX; sy = t.clientY;
    timer = setTimeout(() => {
      const id = Number(c.dataset.id);
      if (!S.sel.has(id)) { S.sel = new Set([id]); $$('.pcard').forEach(x => x.classList.toggle('sel', S.sel.has(Number(x.dataset.id)))); }
      drag = { pos: null }; c.classList.add('dragging'); if (navigator.vibrate) try { navigator.vibrate(20); } catch (_) { }
    }, 400);
  }, { passive: true });
  grid.addEventListener('touchmove', ev => {
    const t = ev.touches[0];
    if (!drag) { if (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10) cancel(); return; }
    ev.preventDefault();
    clearDrop();
    const c = cardAt(t.clientX, t.clientY);
    if (c) { const r = c.getBoundingClientRect(); const before = t.clientX < r.left + r.width / 2; c.classList.add(before ? 'drop-before' : 'drop-after'); drag.pos = Number(c.dataset.idx) + (before ? 0 : 1); }
    const wr = wrap.getBoundingClientRect();
    if (t.clientY < wr.top + 50) wrap.scrollTop -= 14; else if (t.clientY > wr.bottom - 50) wrap.scrollTop += 14;
  }, { passive: false });
  const end = ev => {
    cancel(); if (!drag) return;
    const pos = drag.pos; drag = null; clearDrop(); $$('.pcard.dragging').forEach(x => x.classList.remove('dragging'));
    ev.preventDefault();
    if (pos != null) moveSelectedTo(pos);
  };
  grid.addEventListener('touchend', end, { passive: false });
  grid.addEventListener('touchcancel', () => { cancel(); drag = null; clearDrop(); $$('.pcard.dragging').forEach(x => x.classList.remove('dragging')); });
})();

/* ---------- ordem dos arquivos (quando há mais de um) ---------- */
function renderFiles() {
  const box = $('#files'); if (!box) return;
  const n = S.sources.length;
  box.hidden = n < 2; if (n < 2) { box.innerHTML = ''; return; }
  // ordem dos arquivos = ordem da primeira aparição na lista de páginas
  const order = []; S.entries.forEach(e => { if (!order.includes(e.src)) order.push(e.src); });
  box.innerHTML = '<div class="files-h"><strong>Arquivos reunidos</strong> <span class="muted">— ▲▼ reagrupam as páginas por arquivo; ✕ remove o arquivo</span></div>';
  order.forEach((si, k) => {
    const s = S.sources[si], cnt = S.entries.filter(e => e.src === si).length;
    const row = document.createElement('div'); row.className = 'frow';
    row.innerHTML = `<span class="tag">${si + 1}</span><span class="fname" title="${esc(s.name)}">${esc(s.name)}</span><span class="muted">${cnt} pág.</span>`;
    const mk = (txt, title, fn, dis) => { const b = document.createElement('button'); b.textContent = txt; b.title = title; b.setAttribute('aria-label', title + ' ' + s.name); b.disabled = !!dis; b.onclick = fn; row.appendChild(b); };
    mk('▲', 'Subir arquivo', () => reorderFiles(order, k, k - 1), k === 0);
    mk('▼', 'Descer arquivo', () => reorderFiles(order, k, k + 1), k === order.length - 1);
    mk('✕', 'Remover arquivo', () => removeFile(si), order.length < 2);
    box.appendChild(row);
  });
}
function reorderFiles(order, from, to) {
  if (to < 0 || to >= order.length) return;
  snapshot();
  const o = order.slice(); const [x] = o.splice(from, 1); o.splice(to, 0, x);
  const rank = new Map(o.map((si, i) => [si, i]));
  // reagrupa por arquivo, mantendo a ordem relativa das páginas de cada arquivo
  S.entries = S.entries.map((e, i) => ({ e, i })).sort((a, b) => (rank.get(a.e.src) - rank.get(b.e.src)) || (a.i - b.i)).map(x => x.e);
  render();
}
function removeFile(si) {
  snapshot();
  S.entries = S.entries.filter(e => e.src !== si);
  S.sel = new Set([...S.sel].filter(id => S.entries.some(e => e.id === id)));
  render();
}

$('#btn-open').onclick = () => onOpen().catch(e => toast('err', errMsg(e)));
$('#btn-insert').onclick = () => onInsert().catch(e => toast('err', errMsg(e)));
$('#btn-rotl').onclick = () => rotateSel(-90);
$('#btn-rotr').onclick = () => rotateSel(90);
$('#btn-dup').onclick = dupSel;
$('#btn-del').onclick = deleteSel;
$('#btn-undo').onclick = undo;
$('#btn-all').onclick = () => { S.sel = (S.sel.size === S.entries.length) ? new Set() : new Set(S.entries.map(e => e.id)); render(); };
document.addEventListener('keydown', ev => {
  if (!$('#tab-org').classList.contains('active') || !$('#modal').hidden) return;
  if (ev.target.matches('input,select,textarea')) return;
  if (ev.key === 'Delete') deleteSel();
  else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') { ev.preventDefault(); undo(); }
  else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a') { ev.preventDefault(); S.sel = new Set(S.entries.map(e => e.id)); render(); }
  else if (ev.key.toLowerCase() === 'r') rotateSel(90);
  else if (ev.key.toLowerCase() === 'l') rotateSel(-90);
});

/* ---------- saída ---------- */
$('#split-on').addEventListener('change', syncSplit);
function syncSplit() { const on = $('#split-on').checked; $('#split-mb').disabled = !on; $$('input[name=oversize]').forEach(r => r.disabled = !on); }
syncSplit();
$('#btn-outdir').onclick = async () => { const d = await invoke('pick_folder', {}); if (d) { S.outDir = d; $('#out-dir').value = d; } };

function toast(kind, text, target = '#result-org') {
  $(target).innerHTML = `<div class="msg ${kind}" role="${kind === 'err' ? 'alert' : 'status'}">${esc(text)}</div>`;
}
function setBusy(which, on, text) {
  const b = $('#busy-' + which); b.hidden = !on; if (text) $('#busy-' + which + '-text').textContent = text;
  S.busy = on; $('#btn-run').disabled = on || !S.entries.length; $('#btn-ext-run').disabled = on || !extPath;
}

function buildRequest(onOversize) {
  const splitOn = $('#split-on').checked;
  const splitMb = parseFloat(String($('#split-mb').value).replace(',', '.'));
  return {
    sources: S.sources.map(s => ({ path: s.path, password: s.password })),
    entries: S.entries.map(e => ({ src: e.src, page: e.page, rot: e.rot })),
    compress: $('#compress').value,
    split_mb: splitOn ? splitMb : null,
    reserve_kb: parseFloat($('#reserve-kb').value) || 0,
    on_oversize: onOversize,
    out_dir: S.outDir || dirOf(S.sources[0].path),
    base_name: ($('#base-name').value || oldAce(stem(S.sources[0].path))).replace(/[\\/:*?"<>|]/g, '_'),
  };
}

async function run() {
  if (!S.entries.length || S.busy) return;
  if ($('#split-on').checked) {
    const v = parseFloat(String($('#split-mb').value).replace(',', '.'));
    if (!(v > 0)) { toast('err', 'Informe um tamanho máximo maior que zero.'); return; }
  }
  const forms = S.sources.filter(s => s.form);
  if (forms.length) {
    const r = await modal('Formulários e links', `<p>${forms.map(s => esc(s.name)).join(', ')} contém campos de formulário. Ao reorganizar, os campos e os links internos são removidos (o texto preenchido permanece só se estiver na própria página). Continuar?</p>`,
      [{ label: 'Cancelar', value: 'no' }, { label: 'Continuar', value: 'ok', primary: true }]);
    if (r.value !== 'ok') return;
  }
  let policy = $('input[name=oversize]:checked').value;
  for (;;) {
    setBusy('org', true, 'Processando… PDFs grandes podem levar alguns minutos.');
    $('#result-org').innerHTML = '';
    let res;
    try { res = await api('process', buildRequest(policy)); }
    catch (e) { setBusy('org', false); toast('err', errMsg(e)); return; }
    setBusy('org', false);
    if (res.status === 'needs_decision') {
      const list = res.oversize.map(o => `<li>página ${o.page}: ${o.mb.toFixed(2).replace('.', ',')} MB</li>`).join('');
      const btns = [{ label: 'Cancelar', value: 'cancel' }];
      if (res.can_escalate) btns.push({ label: 'Aumentar compactação', value: 'escalate', primary: true });
      btns.push({ label: 'Gerar mesmo assim', value: 'proceed' });
      const r = await modal('Página maior que o limite',
        `<p>Estas páginas, sozinhas, passam do tamanho máximo escolhido${res.level_tried ? ` (compactação ${esc(res.level_tried)})` : ''}:</p><ul>${list}</ul><p class="hint">Uma página não pode ser dividida. Escolha como prosseguir.</p>`, btns);
      if (r.value === 'cancel') { toast('warn', 'Processamento cancelado. Nenhum arquivo foi gerado.'); return; }
      policy = r.value; continue;
    }
    showDone(res); return;
  }
}
function showDone(r) {
  const saved = r.original_bytes ? Math.round((1 - r.total_bytes / r.original_bytes) * 100) : 0;
  const rows = r.files.map(f => `<tr><td>${esc(f.name)}</td><td>${f.first_page}–${f.last_page}</td><td class="${f.oversize ? 'over' : ''}">${mb(f.bytes)}${f.oversize ? ' ⚠ acima do limite' : ''}</td></tr>`).join('');
  const warn = (r.warnings || []).map(w => `<div class="msg warn">${esc(w)}</div>`).join('');
  $('#result-org').innerHTML = `<div class="msg ok"><strong>Concluído.</strong> ${r.files.length} arquivo${r.files.length > 1 ? 's' : ''}, ${mb(r.total_bytes)} no total (original: ${mb(r.original_bytes)}${saved > 0 ? `, redução de ${saved}%` : ''}).` +
    `${r.level_used ? ` Compactação: ${esc(r.level_used)}; ${r.images_recompressed} imagem(ns) recomprimida(s).` : ''}</div>` +
    `<table><thead><tr><th>Arquivo</th><th>Págs.</th><th>Tamanho</th></tr></thead><tbody>${rows}</tbody></table>${warn}` +
    `<p><button id="btn-reveal">Mostrar na pasta</button></p>`;
  $('#btn-reveal').onclick = () => invoke('reveal', { path: r.files[0].path }).catch(() => { });
}
$('#btn-run').onclick = () => run().catch(e => { setBusy('org', false); toast('err', errMsg(e)); });

/* ---------- extrair ---------- */
window.addEventListener('pdfapp-progress', e => { const t = $('#busy-ext-text'); if (t) t.textContent = e.detail; });
let extPath = null, extPassword = null, extOut = '', extOutManual = false;
$('#btn-ext-open').onclick = async () => {
  const f = await invoke('pick_files', { multiple: false }); if (!f || !f.length) return;
  const got = await openWithPassword(f[0]).catch(e => { toast('err', errMsg(e), '#result-ext'); return null; });
  if (!got) return;
  extPath = f[0]; extPassword = got.password;
  if (!IS_WEB && !extOutManual) { extOut = dirOf(f[0]); $('#ext-out').value = extOut; }
  $('#ext-file').textContent = `${baseName(f[0])} — ${got.info.pages} página(s)`;
  $('#btn-ext-run').disabled = false; $('#result-ext').innerHTML = '';
};
$('#btn-ext-outdir').onclick = async () => { const d = await invoke('pick_folder', {}); if (d) { extOut = d; extOutManual = true; $('#ext-out').value = d; } };
$('#btn-ext-run').onclick = async () => {
  const formats = $$('.fmt').filter(c => c.checked).map(c => c.value);
  if (!formats.length) { toast('err', 'Escolha ao menos um formato.', '#result-ext'); return; }
  setBusy('ext', true); $('#result-ext').innerHTML = '';
  try {
    const r = await api('extract', { path: extPath, password: extPassword, formats, force_ocr: $('#ext-force').checked, verify_numbers: $('#ext-verify').checked, ocr_images: $('#ext-img').checked, compare_ocr: $('#ext-compare').checked, legal_index: $('#ext-legal').checked, alert_patterns: currentPatterns(), out_dir: extOut || dirOf(extPath), tesseract_dir: null });
    setBusy('ext', false); showExt(r);
  } catch (e) { setBusy('ext', false); toast('err', errMsg(e), '#result-ext'); }
};
// ---- padrões de alerta (editáveis; guardados no aparelho)
let defaultPatterns = '';
const PAT_KEY = 'oldace.patterns';
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* sem armazenamento */ } };
function currentPatterns() {
  const v = $('#ext-patterns').value;
  return v.trim() && v !== defaultPatterns ? v : null;
}
(async function initPatterns() {
  try { defaultPatterns = await api('default_patterns', {}); } catch (_) { defaultPatterns = ''; }
  $('#ext-patterns').value = lsGet(PAT_KEY) || defaultPatterns;
})();
$('#ext-patterns').addEventListener('input', () => { const v = $('#ext-patterns').value; v === defaultPatterns ? lsSet(PAT_KEY, '') : lsSet(PAT_KEY, v); });
$('#btn-pat-default').onclick = () => { $('#ext-patterns').value = defaultPatterns; lsSet(PAT_KEY, ''); };
$('#btn-pat-save').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([$('#ext-patterns').value], { type: 'text/plain;charset=utf-8' }));
  a.download = 'padroes_alertas.txt'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
};
$('#btn-pat-load').onclick = () => $('#pat-file').click();
$('#pat-file').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const t = await f.text(); $('#ext-patterns').value = t; lsSet(PAT_KEY, t === defaultPatterns ? '' : t); e.target.value = '';
};

function showExt(r) {
  const files = r.files.map(f => `<tr><td>${esc(f.name)}</td><td>${mb(f.bytes)}</td></tr>`).join('');
  const sevCls = { 'alta': 'err', 'média': 'warn', 'baixa': 'warn' };
  const items = (r.alert_items || []).map(a => {
    const sev = a.severity === 'media' ? 'média' : a.severity;
    return `<div class="msg ${sevCls[sev] || 'warn'}"><strong>Alerta ${esc(sev)}</strong> — ${a.page ? 'página ' + a.page : 'metadados'}, regra «${esc(a.pattern)}»${a.matched ? ', trecho «' + esc(a.matched) + '»' : ''}<br><em>Frase:</em> ${esc(a.sentence)}</div>`;
  }).join('');
  const alerts = items || (r.alerts || []).map(a => `<div class="msg warn"><strong>Alerta:</strong> ${esc(a)}</div>`).join('');
  const none = !alerts ? '<div class="msg ok">Nenhum alerta de instrução dirigida a IA (a detecção é heurística e não garante ausência).</div>' : '';
  const perr = (r.pattern_errors || []).map(e => `<div class="msg warn">${esc(e)}</div>`).join('');
  const conf = r.mean_conf != null ? `, confiança média do OCR ${Math.round(r.mean_conf)}%` : '';
  const hid = r.hidden_blocks ? `<div class="msg warn">${r.hidden_blocks} trecho(s) de texto oculto foram retirados do corpo e transcritos, rotulados, no arquivo.</div>` : '';
  const imgs = r.images ? `<div class="msg">${r.images} imagem(ns) incorporada(s) listada(s) no arquivo; nenhuma é omitida em silêncio.</div>` : '';
  const div = r.divergent_numbers ? `<div class="msg warn">${r.divergent_numbers} número(s) divergiram entre duas leituras de OCR e estão listados no arquivo. Confira-os no PDF original.</div>` : '';
  const ocrNote = r.ocr ? `<div class="msg warn">${r.ocr} página(s) foram lidas por OCR e podem conter erros em números, datas, valores e nomes. Confira no original antes de usar.</div>` : '';
  $('#result-ext').innerHTML = `<div class="msg ok"><strong>Concluído.</strong> ${r.pages} página(s): ${r.digital} com texto digital, ${r.ocr} por OCR, ${r.empty} vazia(s)${conf}.</div>${alerts}${none}${perr}${hid}${imgs}${div}${ocrNote}` +
    `<table><thead><tr><th>Arquivo</th><th>Tamanho</th></tr></thead><tbody>${files}</tbody></table><p><button id="btn-reveal2">Mostrar na pasta</button></p>`;
  $('#btn-reveal2').onclick = () => invoke('reveal', { path: r.files[0].path }).catch(() => { });
}

/* ---------- configurações (paletas de cores) ---------- */
(function () {
  const groups = { claras: '#pal-claras', escuras: '#pal-escuras', 'alto contraste': '#pal-alto' };
  const mk = (p) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'pal-b'; b.setAttribute('role', 'radio'); b.dataset.pal = p.id; b.textContent = p.name;
    if (p.v) { b.style.background = p.v.bg; b.style.color = p.v.text; b.style.borderColor = p.v.accent; }
    return b;
  };
  const auto = mk({ id: 'auto', name: 'Automático', v: null });
  $('#pal-auto').appendChild(auto);
  PALETTES.forEach(p => $(groups[p.group]).appendChild(mk(p)));
  const mark = () => $$('.pal-b').forEach(b => b.setAttribute('aria-checked', String(b.dataset.pal === palGet())));
  mark();
  $('#settings').addEventListener('click', (e) => {
    const b = e.target.closest('.pal-b');
    if (b) { palSet(b.dataset.pal); applyPalette(b.dataset.pal); mark(); }
    if (e.target.id === 'settings') close();
  });
  let opener = null;
  const open = () => { opener = document.activeElement; $('#settings').hidden = false; $('#settings-close').focus(); };
  const close = () => { $('#settings').hidden = true; if (opener) opener.focus(); };
  $('#btn-settings').onclick = open;
  $('#settings-close').onclick = close;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#settings').hidden) close(); });
  $('#settings-about').onclick = () => { close(); const t = document.querySelector('.tab[data-tab=manual]'); if (t) t.click(); };
  const gm = $('#go-manual'); if (gm) gm.onclick = ev => { ev.preventDefault(); const t = document.querySelector('.tab[data-tab=manual]'); if (t) t.click(); };
})();
