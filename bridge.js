// Ponte da versão web: imita window.__TAURI__ (usado por app.js) com o motor em WebAssembly,
// seletor de arquivos do navegador e OCR via tesseract.js. Nenhum arquivo sai do computador.
(function () {
  'use strict';
  const worker = new Worker('worker.js', { type: 'module' });
  let seq = 0; const pending = new Map();
  worker.onmessage = (ev) => {
    const { id, ok, err } = ev.data; const p = pending.get(id); if (!p) return; pending.delete(id);
    err ? p.reject(err) : p.resolve(ok);
  };
  worker.onerror = (e) => { pending.forEach(p => p.reject({ code: 'other', message: 'Falha ao carregar o motor: ' + (e.message || 'erro desconhecido') })); pending.clear(); };
  const call = (cmd, a, transfer) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); worker.postMessage({ id, cmd, a }, transfer || []); });

  const files = new Map();   // chave -> File
  const dirs = new Map();    // nome -> FileSystemDirectoryHandle
  let nfile = 0;
  const progress = (t) => window.dispatchEvent(new CustomEvent('pdfapp-progress', { detail: t }));

  function pickFiles(multiple) {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.pdf,application/pdf'; inp.multiple = !!multiple;
      inp.onchange = () => {
        const out = [];
        for (const f of inp.files) { const k = (++nfile) + '/' + f.name; files.set(k, f); out.push(k); }
        resolve(out.length ? out : null);
      };
      inp.oncancel = () => resolve(null);
      inp.click();
    });
  }
  async function pickFolder() {
    if (!window.showDirectoryPicker) return null;
    try { const h = await window.showDirectoryPicker({ mode: 'readwrite' }); dirs.set(h.name, h); return h.name; } catch (_) { return null; }
  }

  async function saveFile(outDir, name, data, mime) {
    const blob = new Blob([data], { type: mime });
    const h = outDir && dirs.get(outDir);
    if (h) {
      let n = name, i = 2;
      for (;;) { try { await h.getFileHandle(n); const dot = name.lastIndexOf('.'); n = name.slice(0, dot) + ' (' + i++ + ')' + name.slice(dot); } catch (_) { break; } }
      const fh = await h.getFileHandle(n, { create: true }); const w = await fh.createWritable(); await w.write(blob); await w.close();
      return n;
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    await new Promise(r => setTimeout(r, 300));
    return name;
  }

  const stemOf = (k) => k.split('/').pop().replace(/\.pdf$/i, '');

  async function openInfo(p) {
    const f = files.get(p.path); if (!f) throw { code: 'other', message: 'Arquivo não encontrado. Abra-o novamente.' };
    const info = await call('open', { key: p.path, bytes: await f.arrayBuffer(), password: p.password || null });
    return { path: p.path, ...info };
  }

  // ---- OCR (tesseract.js) ----
  let ocrWorker = null;
  async function getOcr() {
    if (ocrWorker) return ocrWorker;
    if (!window.Tesseract) throw { code: 'other', message: 'O componente de OCR não foi carregado.' };
    progress('Carregando o OCR (primeira vez pode demorar)…');
    ocrWorker = await Tesseract.createWorker('por', 1, {
      workerPath: 'ocr/worker.min.js', corePath: 'ocr/core/', langPath: 'ocr/lang/', gzip: false, cacheMethod: 'none',
    });
    await ocrWorker.setParameters({ tessedit_pageseg_mode: '6' });
    return ocrWorker;
  }

  async function extract(r) {
    const key = r.path;
    const opts = { force_ocr: !!r.force_ocr, verify_numbers: !!r.verify_numbers };
    const plan = await call('plan', { key, opts });
    const ocr = {};
    if (plan.pages.length) {
      const w = await getOcr();
      let done = 0; const total = plan.pages.length * plan.dpis.length;
      for (const page of plan.pages) for (const dpi of plan.dpis) {
        progress(`OCR: página ${page} (${dpi} dpi) — ${done + 1} de ${total}`);
        const buf = await call('page_png', { key, page, dpi });
        const res = await w.recognize(new Blob([buf], { type: 'image/png' }), {}, { tsv: true });
        ocr[page + ':' + dpi] = res.data.tsv || '';
        done++;
      }
    }
    progress('Concluindo…');
    const fin = await call('finish', { key, opts, ocr, title: stemOf(key) });
    const mimes = { md: 'text/markdown', txt: 'text/plain', json: 'application/json' };
    const out = [];
    for (const f of r.formats) {
      const n = await saveFile(r.out_dir, stemOf(key) + '.' + f, new TextEncoder().encode(fin[f]), mimes[f] + ';charset=utf-8');
      out.push({ name: n, path: n, first_page: 1, last_page: fin.pages, bytes: new TextEncoder().encode(fin[f]).length, oversize: false });
    }
    return { files: out, pages: fin.pages, digital: fin.digital, ocr: fin.ocr, empty: fin.empty, divergent_numbers: fin.divergent_numbers, mean_conf: fin.mean_conf, alerts: fin.alerts };
  }

  async function processReq(r) {
    const keys = r.sources.map(s => s.path);
    const req = { entries: r.entries, compress: r.compress, split_mb: r.split_mb, reserve_kb: r.reserve_kb, on_oversize: r.on_oversize, base_name: r.base_name };
    const res = await call('process', { keys, passwords: r.sources.map(s => s.password || null), req });
    if (res.json.status !== 'done') return res.json;
    const names = [];
    for (let i = 0; i < res.json.files.length; i++) {
      const n = await saveFile(r.out_dir, res.json.files[i].name, res.parts[i], 'application/pdf');
      res.json.files[i].name = n; res.json.files[i].path = n; names.push(n);
    }
    return res.json;
  }

  const handlers = {
    open_info: openInfo,
    thumbnails: (p) => call('thumbs', { key: p.path, from: p.from, count: p.count, dpi: p.dpi }),
    process: processReq,
    extract,
  };
  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        if (cmd === 'api') return handlers[args.name](args.payload);
        if (cmd === 'pick_files') return pickFiles(args.multiple);
        if (cmd === 'pick_folder') return pickFolder();
        if (cmd === 'reveal') return null;
        throw new Error('comando desconhecido: ' + cmd);
      },
    },
  };

  // ---- PWA: instalação e uso off-line ----
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; const b = document.getElementById('btn-install'); if (b) b.hidden = false; });
  window.addEventListener('appinstalled', () => { const b = document.getElementById('btn-install'); if (b) b.hidden = true; });
  document.addEventListener('DOMContentLoaded', () => {
    ['out-dir', 'ext-out'].forEach(i => { const e = document.getElementById(i); if (e) e.placeholder = window.showDirectoryPicker ? 'Downloads do navegador (ou escolha uma pasta)' : 'Downloads do navegador'; });
    const b = document.getElementById('btn-install'); if (!b) return;
    b.onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; b.hidden = true; };
  });
})();
