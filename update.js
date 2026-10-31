/* Verificação de atualização (só no app de Windows). Funções puras, testáveis fora do navegador.
   O app consulta um arquivo de versão publicado no site e, se houver versão nova, oferece baixar o instalador. */
const UPDATE_MANIFEST_URL = 'https://felippealvarez.github.io/pdf-app-web/download/versao.json';
/* só estes endereços são aceitos para o download (o app não abre outros links vindos do arquivo de versão) */
const UPDATE_ALLOWED_PREFIXES = [
  'https://github.com/FelippeAlvarez/pdf-app-web/releases/download/',
  'https://felippealvarez.github.io/pdf-app-web/download/',
];

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  return m ? [+m[1], +m[2], +m[3]] : null;
}
function isNewer(remote, local) {
  const a = parseVersion(remote), b = parseVersion(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
/* Valida o arquivo de versão; devolve {version, url, notes, sizeMb, sha256, published} ou null (se inválido). */
function validateManifest(j) {
  if (!j || typeof j !== 'object') return null;
  if (!parseVersion(j.version)) return null;
  if (typeof j.url !== 'string' || !UPDATE_ALLOWED_PREFIXES.some(p => j.url.startsWith(p))) return null;
  if (/[\s"'<>\\]/.test(j.url)) return null;
  return {
    version: String(j.version).replace(/^v/, ''),
    url: j.url,
    notes: Array.isArray(j.notes) ? j.notes.filter(x => typeof x === 'string').slice(0, 12).map(x => x.slice(0, 300)) : [],
    sizeMb: typeof j.size_mb === 'number' ? j.size_mb : null,
    sha256: typeof j.sha256 === 'string' && /^[0-9a-fA-F]{64}$/.test(j.sha256) ? j.sha256.toLowerCase() : null,
    published: typeof j.published === 'string' ? j.published.slice(0, 10) : null,
  };
}
async function fetchManifest(timeoutMs = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(UPDATE_MANIFEST_URL + '?v=' + Date.now(), { cache: 'no-store', signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const m = validateManifest(await r.json());
    if (!m) throw new Error('arquivo de versão inválido');
    return m;
  } finally { clearTimeout(t); }
}
if (typeof module !== 'undefined') module.exports = { parseVersion, isNewer, validateManifest, UPDATE_ALLOWED_PREFIXES };
