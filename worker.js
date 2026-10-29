// Worker: carrega o motor (WebAssembly) e atende pedidos da página sem travar a interface.
import init, { Doc, process, default_patterns } from './pkg/pdfweb.js';

const docs = new Map();   // chave -> { doc, bytes }
let ready = null;

function parseErr(e) {
  const s = typeof e === 'string' ? e : (e && e.message) || String(e);
  try { const o = JSON.parse(s); if (o && o.code) return o; } catch (_) { /* não era JSON */ }
  return { code: 'other', message: s };
}

self.onmessage = async (ev) => {
  const { id, cmd, a } = ev.data;
  try {
    ready = ready || init();
    await ready;
    let out, transfer = [];
    switch (cmd) {
      case 'open': {
        const bytes = new Uint8Array(a.bytes);
        const doc = Doc.open(bytes, a.password || undefined);
        docs.set(a.key, { doc, bytes });
        out = JSON.parse(doc.info());
        break;
      }
      case 'default_patterns': out = default_patterns(); break;
      case 'thumbs': out = JSON.parse(docs.get(a.key).doc.thumbnails(a.from, a.count, a.dpi)); break;
      case 'page_png': { const u = docs.get(a.key).doc.page_png(a.page, a.dpi); out = u.buffer; transfer = [u.buffer]; break; }
      case 'plan': out = JSON.parse(docs.get(a.key).doc.extract_plan(JSON.stringify(a.opts))); break;
      case 'finish': out = JSON.parse(docs.get(a.key).doc.extract_finish(JSON.stringify(a.opts), JSON.stringify(a.ocr), a.title)); break;
      case 'process': {
        const srcs = a.keys.map(k => docs.get(k).bytes);
        const r = process(srcs, JSON.stringify(a.passwords), JSON.stringify(a.req));
        const parts = [];
        for (let i = 0; i < r.part_count(); i++) { const u = r.part(i); parts.push(u.buffer); }
        transfer = parts;
        out = { json: JSON.parse(r.json()), parts };
        r.free();
        break;
      }
      case 'close': { const d = docs.get(a.key); if (d) { d.doc.free(); docs.delete(a.key); } out = true; break; }
      default: throw new Error('comando desconhecido: ' + cmd);
    }
    self.postMessage({ id, ok: out }, transfer);
  } catch (e) {
    self.postMessage({ id, err: parseErr(e) });
  }
};
