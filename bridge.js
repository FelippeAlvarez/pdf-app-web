// Ponte da versão web: imita window.__TAURI__ (usado por app.js) com o motor em WebAssembly,
// seletor de arquivos do navegador e OCR via tesseract.js. Nenhum arquivo sai do computador.
(function () {
  'use strict';
  window.PDF_OLD_ACE_WEB = true;
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

  let lastOut = [];   // arquivos da última operação (para salvar em outro local / compartilhar)
  async function saveFile(outDir, name, data, mime) {
    const blob = new Blob([data], { type: mime });
    const h = outDir && dirs.get(outDir);
    if (h) {
      let n = name, i = 2;
      for (;;) { try { await h.getFileHandle(n); const dot = name.lastIndexOf('.'); n = name.slice(0, dot) + ' (' + i++ + ')' + name.slice(dot); } catch (_) { break; } }
      const fh = await h.getFileHandle(n, { create: true }); const w = await fh.createWritable(); await w.write(blob); await w.close();
      lastOut.push({ name: n, blob });
      return n;
    }
    lastOut.push({ name, blob });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    await new Promise(r => setTimeout(r, 300));
    return name;
  }


  // ---- salvar em outro local / compartilhar ----
  const shareType = (o, alt) => alt ? (/\.(md|txt)$/i.test(o.name) ? 'text/plain' : 'application/octet-stream') : (o.blob.type || 'application/octet-stream');
  async function shareOutputs() {
    if (!lastOut.length) throw { code: 'other', message: 'Não há arquivos recentes para compartilhar.' };
    if (typeof navigator.canShare !== 'function' || typeof navigator.share !== 'function') throw { code: 'other', message: 'Este navegador não permite compartilhar arquivos. Use “Salvar em outro local”.' };
    let list = lastOut.map(o => new File([o.blob], o.name, { type: shareType(o, false) }));
    if (!navigator.canShare({ files: list })) list = lastOut.map(o => new File([o.blob], o.name, { type: shareType(o, true) }));
    if (!navigator.canShare({ files: list })) throw { code: 'other', message: 'Este navegador não permite compartilhar este tipo de arquivo. Use “Salvar em outro local”.' };
    try { await navigator.share({ files: list, title: 'PDF Old Ace' }); }
    catch (e) { if (e && e.name === 'AbortError') return null; throw { code: 'other', message: 'Não foi possível compartilhar: ' + (e && e.message || e) }; }
    return { message: 'Arquivos enviados ao aplicativo escolhido.' };
  }
  let pendingSave = [];
  async function saveOutputsElsewhere() {
    if (!lastOut.length) throw { code: 'other', message: 'Não há arquivos recentes para salvar.' };
    try {
      if (window.showDirectoryPicker) {
        const h = await window.showDirectoryPicker({ mode: 'readwrite' }); let n = 0;
        for (const o of lastOut) {
          let name = o.name, i = 2;
          for (;;) { try { await h.getFileHandle(name); const dot = o.name.lastIndexOf('.'); name = o.name.slice(0, dot) + ' (' + i++ + ')' + o.name.slice(dot); } catch (_) { break; } }
          const fh = await h.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(o.blob); await w.close(); n++;
        }
        return { where: h.name, count: n };
      }
      if (window.showSaveFilePicker) {
        if (!pendingSave.length) pendingSave = lastOut.slice();
        let n = 0;
        while (pendingSave.length) {
          const o = pendingSave[0];
          let fh; try { fh = await window.showSaveFilePicker({ suggestedName: o.name }); }
          catch (e) { if (e && e.name === 'AbortError') { pendingSave = []; return n ? { message: `${n} arquivo(s) salvo(s).` } : null; } if (n) return { message: `${n} arquivo(s) salvo(s). Toque de novo no botão para salvar os ${pendingSave.length} restantes.` }; throw e; }
          const w = await fh.createWritable(); await w.write(o.blob); await w.close(); pendingSave.shift(); n++;
        }
        return { message: `${n} arquivo(s) salvo(s) no local escolhido.` };
      }
    } catch (e) { if (e && e.name === 'AbortError') return null; throw { code: 'other', message: 'Não foi possível salvar: ' + (e && e.message || e) }; }
    // sem seletor de pasta/arquivo: baixa novamente (Downloads) e sugere compartilhar
    for (const o of lastOut) { const a = document.createElement('a'); a.href = URL.createObjectURL(o.blob); a.download = o.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000); await new Promise(r => setTimeout(r, 300)); }
    return { message: 'Este navegador não permite escolher a pasta; os arquivos foram baixados de novo para Downloads. Para enviar a outro lugar, use “Compartilhar”.' };
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

  // recorta um PNG (ArrayBuffer) para a região pedida
  async function cropPng(buf, c) {
    const bmp = await createImageBitmap(new Blob([buf], { type: 'image/png' }));
    const x = Math.min(c[0], bmp.width - 1), y = Math.min(c[1], bmp.height - 1);
    const w = Math.max(1, Math.min(c[2], bmp.width - x)), h = Math.max(1, Math.min(c[3], bmp.height - y));
    const cv = new OffscreenCanvas(w, h);
    cv.getContext('2d').drawImage(bmp, x, y, w, h, 0, 0, w, h);
    return await cv.convertToBlob({ type: 'image/png' });
  }

  async function extract(r) {
    lastOut = []; pendingSave = [];
    const key = r.path;
    const opts = {
      force_ocr: !!r.force_ocr, verify_numbers: !!r.verify_numbers, ocr_images: !!r.ocr_images,
      compare_ocr: !!r.compare_ocr, legal_index: !!r.legal_index,
      alert_patterns: r.alert_patterns || null, timestamp: new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC'),
    };
    const plan = await call('plan', { key, opts });
    const ocr = {};
    if (plan.requests.length) {
      const w = await getOcr();
      let done = 0; const total = plan.requests.length;
      const cache = new Map();
      for (const q of plan.requests) {
        progress(`OCR: ${q.crop ? 'imagem na página ' : 'página '}${q.page} (${q.dpi} dpi) — ${done + 1} de ${total}`);
        const ck = q.page + ':' + q.dpi;
        let buf = cache.get(ck);
        if (!buf) { buf = await call('page_png', { key, page: q.page, dpi: q.dpi }); cache.clear(); cache.set(ck, buf.slice(0)); }
        else buf = buf.slice(0);
        const img = q.crop ? await cropPng(buf, q.crop) : new Blob([buf], { type: 'image/png' });
        const res = await w.recognize(img, {}, { tsv: true });
        ocr[q.key] = res.data.tsv || '';
        done++;
      }
    }
    progress('Concluindo…');
    const fin = await call('finish', { key, opts, ocr, title: stemOf(key) });
    const mimes = { md: 'text/markdown', txt: 'text/plain', json: 'application/json' };
    const out = [];
    for (const f of r.formats) {
      const n = await saveFile(r.out_dir, stemOf(key).replace(/_OldAce$/i, '') + '_OldAce.' + f, new TextEncoder().encode(fin[f]), mimes[f] + ';charset=utf-8');
      out.push({ name: n, path: n, first_page: 1, last_page: fin.pages, bytes: new TextEncoder().encode(fin[f]).length, oversize: false });
    }
    return { files: out, pages: fin.pages, digital: fin.digital, ocr: fin.ocr, empty: fin.empty, divergent_numbers: fin.divergent_numbers, mean_conf: fin.mean_conf, alerts: fin.alerts, alert_items: fin.alert_items, pattern_errors: fin.pattern_errors, images: fin.images, hidden_blocks: fin.hidden_blocks };
  }

  async function processReq(r) {
    lastOut = []; pendingSave = [];
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
    default_patterns: () => call('default_patterns', {}),
  };
  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        if (cmd === 'api') return handlers[args.name](args.payload);
        if (cmd === 'pick_files') return pickFiles(args.multiple);
        if (cmd === 'pick_folder') return pickFolder();
        if (cmd === 'share_outputs') return shareOutputs();
        if (cmd === 'save_outputs_elsewhere') return saveOutputsElsewhere();
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
