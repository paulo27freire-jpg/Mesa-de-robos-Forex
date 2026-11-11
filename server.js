/* Mesa de Robôs - SITE (corre na internet, no teu alojamento grátis).

   O que é: um site que (1) guarda uma cópia do que o programa do teu PC lhe envia (preço do ouro, velas,
   notícias, estado dos robôs), (2) mostra a Mesa de Robôs no telemóvel, em qualquer lado, protegido por
   palavra-passe, e (3) tem os robôs a trabalhar 24 horas por dia, mesmo com todas as páginas fechadas:
   os do ouro (os mesmos da página) e uma investigação de pares e índices que serve de contexto ao ouro.

   O que NÃO é: não liga ao MT5, não tem corretora, não abre nem fecha ordens e nunca recebe a tua conta,
   o tópico do ntfy nem qualquer palavra-passe do teu corretor. Só guarda dados de mercado e o estado
   SIMULADO dos robôs.

   Variáveis de ambiente (no painel do alojamento):
     RELAY_PASSWORD  palavra-passe para entrares pelo telemóvel (mínimo 12 caracteres)
     RELAY_KEY       chave que só o programa do PC conhece (mínimo 20 caracteres, diferente da anterior)
     PORT            porta (o alojamento define-a sozinho)
     MESA_SEM_ROBOS  (opcional) 1 = só faz de ponte, sem robôs no servidor

   Só usa a biblioteca padrão do Node (versão 18 ou mais). */
'use strict';
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');

const VERSAO = '2.0';
const COOKIE = 'mesa_sessao';
const NOME_RE = /^[a-z0-9_-]{1,40}$/;
const DOC_RE = /^mesa\/([a-z0-9_-]{1,40})$/;
const SIM_RE = /^[A-Z0-9_]{3,16}$/;
const MAX_DOCS = 12;
const MAX_DOC = 6 * 1024 * 1024;
const MAX_PAGINA = 4 * 1024 * 1024;
const MAX_VELAS = 30000;
const MAX_TFS = 6;
const MAX_MERCADOS = 16;
const MAX_TFS_MERCADO = 4;
const MAX_AVISOS = 30;
const MAX_CORPO_PC = 40 * 1024 * 1024;
const STALE_S = 25;                       // sem notícias do PC há mais de isto = «PC parado»
const MARCA_SITE = Buffer.from('<script>window.MESA_SITE=1;window.MESA_ROBOS=1</script>');
const MARCA_SITE_SEM_ROBOS = Buffer.from('<script>window.MESA_SITE=1</script>');

const agoraS = () => Date.now() / 1000;
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isInt = (x) => Number.isInteger(x);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const hmacHex = (chave, texto) => crypto.createHmac('sha256', chave).update(texto).digest('hex');
function iguaisSeguro(a, b) {                 // compara sem revelar o tamanho nem onde diferem
  const ha = crypto.createHash('sha256').update(a).digest(), hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* ---------------------------------------------------------------- palavra-passe e sessões */
class Acesso {
  /* Devagar de propósito: 5 erros seguidos bloqueiam esse endereço 15 minutos e 20 erros no total
     (de quem for) bloqueiam tudo 15 minutos. A sessão é um bilhete assinado: sobrevive a reinícios. */
  constructor(palavra, relogio, segredo) {
    this.palavra = Buffer.from(String(palavra).trim(), 'utf8');
    this.relogio = relogio || agoraS;
    this.segredo = segredo || crypto.randomBytes(32);
    this.revogadas = new Map();
    this.falhas = new Map();
    this.falhasTotal = [];
    this.bloqIp = new Map();
    this.bloqGlobal = 0;
  }
  entrar(ip, palavra) {                        // -> [código http, bilhete ou null, mensagem]
    const t = this.relogio();
    if (t < this.bloqGlobal || t < (this.bloqIp.get(ip) || 0)) return [429, null, 'Demasiadas tentativas. Espera uns minutos e tenta outra vez.'];
    const cand = typeof palavra === 'string' ? Buffer.from(palavra.trim().slice(0, 200), 'utf8') : Buffer.alloc(0);
    if (iguaisSeguro(cand, this.palavra)) {
      this.falhas.delete(ip);
      return [200, this._bilhete(t + Acesso.SESSAO_S), ''];
    }
    const fl = (this.falhas.get(ip) || []).filter((x) => t - x < Acesso.JANELA_S).concat([t]);
    this.falhas.set(ip, fl);
    if (this.falhas.size > 500) for (const [k, v] of this.falhas) if (!v.length || t - v[v.length - 1] >= Acesso.JANELA_S) this.falhas.delete(k);
    this.falhasTotal = this.falhasTotal.filter((x) => t - x < Acesso.JANELA_S).concat([t]);
    if (fl.length >= Acesso.MAX_IP) { this.bloqIp.set(ip, t + Acesso.BLOQUEIO_S); this.falhas.set(ip, []); }
    if (this.falhasTotal.length >= Acesso.MAX_TOTAL) { this.bloqGlobal = t + Acesso.BLOQUEIO_S; this.falhasTotal = []; }
    return [401, null, 'Palavra-passe errada.'];
  }
  _bilhete(expira) {
    const corpo = Math.floor(expira) + '.' + crypto.randomBytes(8).toString('hex');
    return corpo + '.' + hmacHex(this.segredo, corpo);
  }
  valido(tok) {
    if (!tok || typeof tok !== 'string' || tok.length > 120) return false;
    const p = tok.split('.');
    if (p.length !== 3 || !/^\d+$/.test(p[0])) return false;
    if (!iguaisSeguro(Buffer.from(hmacHex(this.segredo, p[0] + '.' + p[1])), Buffer.from(p[2]))) return false;
    return Number(p[0]) > this.relogio() && !this.revogadas.has(tok);
  }
  sair(tok) {
    if (!this.valido(tok)) return;
    if (this.revogadas.size > 500) { const t = this.relogio(); for (const [k, v] of this.revogadas) if (v <= t) this.revogadas.delete(k); }
    this.revogadas.set(tok, Number(tok.split('.')[0]));
  }
}
Acesso.SESSAO_S = 30 * 86400; Acesso.JANELA_S = 600; Acesso.MAX_IP = 5; Acesso.MAX_TOTAL = 20; Acesso.BLOQUEIO_S = 900;

/* ---------------------------------------------------------------- o que o PC enviou */
const velaOk = (v) => Array.isArray(v) && v.length === 5 && v.every(isNum);

class Serie {
  constructor() { this.velas = []; this.rev = 0; this.max = 20000; this.gz = null; }
  fundir(novas) {
    const v = this.velas, ini = Math.max(0, v.length - (novas.length + 60)), idx = new Map();
    for (let i = ini; i < v.length; i++) idx.set(v[i][0], i);
    for (const x of novas) {
      const i = idx.get(x[0]);
      if (i !== undefined) v[i] = x;
      else if (!v.length || x[0] > v[v.length - 1][0]) { v.push(x); idx.set(x[0], v.length - 1); }
    }
    if (v.length > this.max + 300) v.splice(0, v.length - this.max);
  }
}

class Estado {
  /* Tudo o que o site sabe. Vive só na memória: se o site reiniciar, o PC volta a enviar tudo. */
  constructor(relogio) {
    this.relogio = relogio || agoraS;
    this.boot = crypto.randomBytes(6).toString('hex');
    this.sessao = null;
    this.live = null; this.liveT = 0;
    this.series = new Map();        // minutos -> Serie (ouro)
    this.mercados = new Map();      // símbolo lógico -> { info, series: Map }
    this.noticias = null;
    this.docs = new Map();          // nome -> { dados, v }
    this.avisosEst = null;
    this.fila = []; this.filaId = 0;
    this.pagina = null;             // { bytes, hash }
    this.primeiroPush = 0;          // quando o PC falou pela primeira vez desde este arranque
    this.ouvintes = { pagina: [], docs: [] };
  }
  on(ev, f) { this.ouvintes[ev].push(f); }
  _emit(ev, ...a) { for (const f of this.ouvintes[ev]) { try { f(...a); } catch (e) { console.log('Erro num ouvinte (' + ev + '): ' + e.message); } } }

  _novaSessao(sid) {
    if (sid !== this.sessao) { this.sessao = sid; this.series = new Map(); this.mercados = new Map(); this.noticias = null; this.live = null; }
  }
  _ack() {
    const velas = {}, mercados = {}, docs = {};
    for (const [k, s] of this.series) velas[String(k)] = { rev: s.rev, ult: s.velas.length ? s.velas[s.velas.length - 1][0] : 0, n: s.velas.length };
    for (const [sim, m] of this.mercados) {
      mercados[sim] = {};
      for (const [k, s] of m.series) mercados[sim][String(k)] = { rev: s.rev, ult: s.velas.length ? s.velas[s.velas.length - 1][0] : 0, n: s.velas.length };
    }
    for (const [k, d] of this.docs) docs[k] = d.v;
    return { boot: this.boot, sessao: this.sessao, pagina: this.pagina ? this.pagina.hash : null, velas, mercados, nrev: this.noticias ? (this.noticias.rev === undefined ? null : this.noticias.rev) : null, docs };
  }

  push(d) {                         // pedido principal do PC, de poucos em poucos segundos -> [código, resposta]
    if (!isObj(d) || !isObj(d.live) || typeof d.sessao !== 'string' || d.sessao.length < 4 || d.sessao.length > 64) return [400, { erro: 'pedido inválido' }];
    this._novaSessao(d.sessao);
    if (!this.primeiroPush) this.primeiroPush = this.relogio();
    this.live = d.live; this.liveT = this.relogio();
    const n = d.noticias;
    if (isObj(n) && (n.items === undefined || Array.isArray(n.items))) this.noticias = n;
    const av = d.avisos;
    if (isObj(av)) { this.avisosEst = {}; for (const k of ['ativo', 'enviados', 'ultimo', 'fixo']) if (k in av) this.avisosEst[k] = av[k]; }
    if (isObj(d.extra)) {            // dados dos outros mercados (nome no corretor, spread, preço)
      for (const [sim, info] of Object.entries(d.extra)) {
        if (!SIM_RE.test(sim) || !isObj(info)) continue;
        if (!this.mercados.has(sim) && this.mercados.size >= MAX_MERCADOS) continue;
        const m = this.mercados.get(sim) || { info: {}, series: new Map() };
        m.info = {};
        for (const k of ['mt5', 'spread', 'preco', 'digits', 'ponto', 'tick_utc', 'tipo']) if (k in info && (isNum(info[k]) || typeof info[k] === 'string' || info[k] === null)) m.info[k] = typeof info[k] === 'string' ? info[k].slice(0, 40) : info[k];
        this.mercados.set(sim, m);
      }
    }
    const enviados = new Set();
    if (isObj(d.docs)) {
      for (const [nome, dados] of Object.entries(d.docs)) {
        if (!NOME_RE.test(nome) || !(Array.isArray(dados) || isObj(dados))) continue;
        if (!this.docs.has(nome) && this.docs.size >= MAX_DOCS) continue;
        this._guardarDoc(nome, dados, false);
        enviados.add(nome);
      }
    }
    const visto = isObj(d.visto) ? d.visto : {}, paraPc = {};
    for (const [nome, doc] of this.docs) {
      const v = visto[nome];
      if (!enviados.has(nome) && doc.v > (isInt(v) ? v : 0)) paraPc[nome] = { v: doc.v, dados: doc.dados };
    }
    if (isInt(d.avisos_ok)) this.fila = this.fila.filter((a) => a.id > d.avisos_ok);
    return [200, { ok: true, ack: this._ack(), docs: paraPc, avisos: this.fila.slice() }];
  }
  _guardarDoc(nome, dados, avisar) {
    const v = (this.docs.has(nome) ? this.docs.get(nome).v : 0) + 1;
    this.docs.set(nome, { dados, v });
    if (avisar !== false) this._emit('docs', nome, v);
    return v;
  }
  docInterno(nome, dados) {          // um módulo do próprio site grava um ficheiro de estado (o PC guarda a cópia)
    if (!NOME_RE.test(nome) || (!this.docs.has(nome) && this.docs.size >= MAX_DOCS)) return 0;
    return this._guardarDoc(nome, dados, false);
  }
  paginaNova(corpo) {
    if (!corpo || corpo.length > MAX_PAGINA || corpo.slice(0, 2000).indexOf('<') < 0) return [400, { erro: 'página inválida' }];
    const h = sha1(corpo), mudou = !this.pagina || this.pagina.hash !== h;
    this.pagina = { bytes: corpo, hash: h };
    if (mudou) this._emit('pagina', h);
    return [200, { ok: true, ack: this._ack() }];
  }
  velasNovas(d) {
    if (!isObj(d) || !isInt(d.tf) || d.tf < 1 || d.tf > 1440 || !Array.isArray(d.velas)) return [400, { erro: 'pedido inválido' }];
    const modo = d.modo, rev = d.rev;
    if ((modo !== 'full' && modo !== 'delta') || !isInt(rev) || d.velas.length > MAX_VELAS) return [400, { erro: 'pedido inválido' }];
    const velas = d.velas;
    if (!velas.every(velaOk)) return [400, { erro: 'velas inválidas' }];
    for (let i = 1; i < velas.length; i++) if (!(velas[i][0] > velas[i - 1][0])) return [400, { erro: 'velas fora de ordem' }];
    if (d.sessao !== this.sessao) return [409, { erro: 'sessao' }];
    let mapa = this.series, limite = MAX_TFS;
    if (d.sim !== undefined) {         // velas de outro mercado
      if (typeof d.sim !== 'string' || !SIM_RE.test(d.sim)) return [400, { erro: 'mercado inválido' }];
      let m = this.mercados.get(d.sim);
      if (!m) {
        if (this.mercados.size >= MAX_MERCADOS) return [400, { erro: 'demasiados mercados' }];
        m = { info: {}, series: new Map() }; this.mercados.set(d.sim, m);
      }
      mapa = m.series; limite = MAX_TFS_MERCADO;
    }
    let s = mapa.get(d.tf);
    if (!s) {
      if (modo === 'delta') return [409, { erro: 'sem_base' }];
      if (mapa.size >= limite) return [400, { erro: 'demasiados tempos gráficos' }];
      s = new Serie(); mapa.set(d.tf, s);
    }
    if (isInt(d.max) && d.max >= 100 && d.max <= MAX_VELAS) s.max = d.max;
    if (modo === 'full') s.velas = velas.slice(-s.max); else s.fundir(velas);
    s.rev = rev; s.gz = null;
    return [200, { ok: true, ack: this._ack() }];
  }

  /* --- o que o telemóvel vê */
  liveVisivel() {
    const t = this.relogio();
    if (!this.live) {
      return { app: 'mesa-mt5', versao: VERSAO, modo: 'site', ligado: false, erro: 'À espera do programa do PC.', simbolo: '', tf_min: 15, preco: null,
        mercado_aberto: false, agora_utc: t, tfs: {}, nrev: 0, noticias_ativas: false, ponte: { pc_ligado: false } };
    }
    const d = Object.assign({}, this.live), idade = Math.max(0, t - this.liveT), parado = idade > STALE_S, pcAgora = d.agora_utc;
    d.agora_utc = isNum(pcAgora) ? pcAgora + idade : t;
    if (parado) { d.ligado = false; d.erro = 'O PC deixou de enviar dados (desligado ou programa fechado).'; d.mercado_aberto = false; }
    else if (isNum(d.tick_utc)) d.mercado_aberto = !!d.ligado && (d.agora_utc - d.tick_utc) < 180;
    const tfs = {};                    // só aparecem os tempos gráficos que o site já tem completos, com os números do site
    for (const [k, s] of this.series) {
      const r0 = (d.tfs || {})[String(k)], r = isObj(r0) ? Object.assign({}, r0) : { tf_min: k };
      Object.assign(r, { n: s.velas.length, rev: s.rev, ultima_fechada: s.velas.length ? s.velas[s.velas.length - 1][0] : null });
      tfs[String(k)] = r;
    }
    d.tfs = tfs;
    const ms = this.series.get(d.tf_min);
    if (ms) Object.assign(d, { n: ms.velas.length, rev: ms.rev, ultima_fechada: ms.velas.length ? ms.velas[ms.velas.length - 1][0] : null });
    else Object.assign(d, { n: 0, rev: 0, ultima_fechada: null });
    d.nrev = this.noticias ? (this.noticias.rev || 0) : 0;
    d.noticias_ativas = !!(this.noticias && this.noticias.ativas);
    d.modo = d.modo || 'mt5';
    d.ponte = { pc_ligado: !parado, idade_s: Math.round(idade * 10) / 10 };
    return d;
  }
  candles(q) {                         // mesma resposta do programa do PC: tf, desde, n -> { corpo } ou { completo: [rev, raw, gz] }
    const main = (this.live || {}).tf_min;
    let tfm = main;
    if (q.has('tf')) { const x = Number(q.get('tf')); tfm = Number.isFinite(x) ? Math.trunc(x) : null; }
    let s = this.series.get(tfm);
    if (!s) s = this.series.get(main);
    const simbolo = (this.live || {}).simbolo || '';
    if (!s) return { corpo: { simbolo, tf_min: tfm || 0, rev: 0, c: [] } };
    let v = s.velas, completo = false;
    if (q.has('desde')) {
      const d = Number(q.get('desde')) || 0;
      let ini = v.length;
      while (ini > 0 && v[ini - 1][0] >= d) ini--;
      v = v.slice(ini);
    } else if (q.has('n')) {
      const n = Math.max(1, parseInt(q.get('n'), 10) || 1);
      v = v.slice(-n);
    } else completo = true;
    let tfReal = main;
    for (const [k, x] of this.series) if (x === s) tfReal = k;
    const corpo = { simbolo, tf_min: tfReal, rev: s.rev, c: v };
    if (completo) {
      if (!s.gz || s.gz[0] !== s.rev) { const raw = Buffer.from(JSON.stringify(corpo)); s.gz = [s.rev, raw, zlib.gzipSync(raw, { level: 6 })]; }
      return { completo: s.gz };
    }
    return { corpo };
  }
  noticiasVisivel() {
    if (!this.noticias) return { rev: 0, items: [], fontes: [], ativas: false };
    return Object.assign({}, this.noticias, { ativas: this.noticias.ativas === undefined ? true : !!this.noticias.ativas });
  }
  avisosVisivel() {
    return Object.assign({ ativo: false, enviados: 0, ultimo: null, fixo: false }, this.avisosEst || {}, { servidor: '', topico: '', remoto: true });
  }
  doc(nome, v) {                       // se o telemóvel já tem a versão `v`, responde só «igual» (poupa dados móveis)
    const d = this.docs.get(nome);
    if (!d) return { existe: false };
    if (v !== null && v === d.v) return { existe: true, igual: true, v: d.v };
    return { existe: true, dados: d.dados, v: d.v };
  }
  docDoTelemovel(nome, dados) {
    if (!this.docs.has(nome) && this.docs.size >= MAX_DOCS) return 0;
    return this._guardarDoc(nome, dados, true);
  }
  avisoDoTelemovel(d) {
    this.filaId += 1;
    this.fila.push({ id: this.filaId, titulo: String(d.titulo || '').slice(0, 120), corpo: String(d.corpo || '').slice(0, 1000),
      tipo: String(d.tipo || 'enter').slice(0, 12), chave: String(d.chave || '').slice(0, 120) || null });
    if (this.fila.length > MAX_AVISOS) this.fila.splice(0, this.fila.length - MAX_AVISOS);
  }
  pcLigado() { return !!this.live && this.relogio() - this.liveT <= STALE_S; }
}

/* ---------------------------------------------------------------- páginas */
const PAGINA_ENTRAR = `<!doctype html><html lang="pt"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Mesa de Robôs</title><style>
:root{color-scheme:light dark;--bg:#E7EAEC;--card:#fff;--ink:#12171C;--mute:#566370;--gold:#D6A32B;--neg:#B53425}
@media (prefers-color-scheme:dark){:root{--bg:#0E1216;--card:#1C222A;--ink:#E6E9ED;--mute:#8E9AA6;--neg:#F0705F}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px system-ui,-apple-system,'Segoe UI',sans-serif;padding:16px;box-sizing:border-box}
form{background:var(--card);border-radius:14px;padding:22px;width:100%;max-width:340px;box-shadow:0 2px 14px rgba(0,0,0,.15)}
h1{font-size:19px;margin:0 0 4px}p{margin:0 0 14px;color:var(--mute);font-size:14px}
input{width:100%;box-sizing:border-box;font:inherit;padding:11px;border-radius:9px;border:1px solid var(--mute);background:transparent;color:var(--ink)}
button{margin-top:12px;width:100%;font:inherit;font-weight:600;padding:11px;border:0;border-radius:9px;background:var(--gold);color:#1A1300}
#e{color:var(--neg);min-height:1.3em;margin-top:8px;font-size:14px}</style></head><body>
<form id="f"><h1>Mesa de Robôs</h1><p>Escreve a palavra-passe do teu site (a que puseste no Render como RELAY_PASSWORD).</p>
<input id="p" type="password" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="palavra-passe" autofocus>
<button type="submit">Entrar</button><div id="e"></div></form>
<script>document.getElementById('f').addEventListener('submit',function(ev){ev.preventDefault();var e=document.getElementById('e');e.textContent='';
fetch('/api/entrar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({palavra:document.getElementById('p').value})})
.then(function(r){return r.json().then(function(j){return[r.status,j]})}).then(function(a){if(a[0]===200)location.reload();else e.textContent=a[1].erro||'Não deu.'})
.catch(function(){e.textContent='Sem ligação ao site. Se ele estava parado, espera um minuto e tenta outra vez.'})});</script></body></html>`;

const PAGINA_ESPERA = `<!doctype html><html lang="pt"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5"><meta name="robots" content="noindex,nofollow"><title>Mesa de Robôs</title><style>
:root{color-scheme:light dark;--bg:#E7EAEC;--ink:#12171C;--mute:#566370}
@media (prefers-color-scheme:dark){:root{--bg:#0E1216;--ink:#E6E9ED;--mute:#8E9AA6}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px system-ui,-apple-system,'Segoe UI',sans-serif;padding:16px;box-sizing:border-box}
div{max-width:340px}h1{font-size:19px}p{color:var(--mute);font-size:14px}</style></head><body><div><h1>À espera do programa do PC…</h1>
<p>O site está no ar, mas o programa do teu PC ainda não lhe enviou nada. Confirma que o PC está ligado e que a janela do programa (iniciar_site.bat) está aberta. Esta página volta a tentar sozinha.</p></div></body></html>`;

/* ---------------------------------------------------------------- servidor HTTP */
function lerCookie(h, nome) {
  for (const p of String(h || '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0 && p.slice(0, i).trim() === nome) return p.slice(i + 1).trim();
  }
  return '';
}
const eLoopback = (a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';

function criar(opts) {
  opts = opts || {};
  const relogio = opts.relogio || agoraS;
  const est = opts.est || new Estado(relogio);
  const palavra = opts.palavra, chave = opts.chave, chaveB = Buffer.from(chave, 'utf8');
  const segredo = crypto.createHmac('sha256', chave).update('sessao|' + palavra).digest();
  const acesso = new Acesso(palavra, relogio, segredo);
  const tokenInterno = crypto.randomBytes(24).toString('hex');
  const ctrl = { est, acesso, tokenInterno, robos: null, pesquisa: null, marca: MARCA_SITE, srv: null, parar: null };

  function seguro(req) { return !!req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https'; }
  function ipDe(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim().slice(0, 64); }
  function interno(req) {            // pedido do «separador virtual» dos robôs, só pelo próprio computador do site
    const t = req.headers['x-mesa-interno'];
    return typeof t === 'string' && t.length === tokenInterno.length && iguaisSeguro(Buffer.from(t), Buffer.from(tokenInterno)) && eLoopback(req.socket.remoteAddress) && !req.headers['x-forwarded-for'];
  }
  function sessaoOk(req) { return interno(req) || acesso.valido(lerCookie(req.headers.cookie, COOKIE)); }
  function chaveOk(req) { const c = req.headers['x-mesa-chave']; return typeof c === 'string' && iguaisSeguro(Buffer.from(c, 'utf8'), chaveB); }

  function enviar(req, res, corpo, tipo, codigo, extra, gz) {
    const aceita = String(req.headers['accept-encoding'] || '').includes('gzip');
    let dados = corpo, comp = false;
    if (aceita && gz) { dados = gz; comp = true; }
    else if (aceita && corpo.length > 1400) { dados = zlib.gzipSync(corpo, { level: 6 }); comp = true; }
    const h = { 'Content-Type': tipo, 'Content-Length': dados.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' };
    if (comp) { h['Content-Encoding'] = 'gzip'; h['Vary'] = 'Accept-Encoding'; }
    if (seguro(req)) h['Strict-Transport-Security'] = 'max-age=31536000';
    Object.assign(h, extra || {});
    res.writeHead(codigo || 200, h);
    res.end(req.method === 'HEAD' ? undefined : dados);
  }
  const json = (req, res, obj, codigo, extra) => enviar(req, res, Buffer.from(JSON.stringify(obj)), 'application/json; charset=utf-8', codigo, extra);
  const html = (req, res, txt, codigo) => enviar(req, res, Buffer.isBuffer(txt) ? txt : Buffer.from(txt), 'text/html; charset=utf-8', codigo);

  function lerCorpo(req, res, maximo) {   // -> Promise<Buffer|null> (null = já respondeu com o erro)
    return new Promise((resolve) => {
      const n = parseInt(req.headers['content-length'] || '0', 10) || 0;
      if (n <= 0 || n > maximo) { json(req, res, { erro: 'tamanho' }, 413); req.resume(); return resolve(null); }
      const partes = []; let tot = 0, fim = false;
      req.on('data', (c) => { tot += c.length; if (tot > n) { if (!fim) { fim = true; json(req, res, { erro: 'corpo maior que o anunciado' }, 400); resolve(null); } req.destroy(); return; } partes.push(c); });
      req.on('end', () => {
        if (fim) return;
        fim = true;
        const b = Buffer.concat(partes);
        if (b.length !== n) { json(req, res, { erro: 'corpo incompleto' }, 400); return resolve(null); }
        const enc = String(req.headers['content-encoding'] || '').toLowerCase();
        if (enc === 'gzip') {
          zlib.gunzip(b, { maxOutputLength: MAX_CORPO_PC }, (e, out) => {
            if (e) { json(req, res, { erro: e.code === 'ERR_BUFFER_TOO_LARGE' ? 'tamanho' : 'gzip' }, e.code === 'ERR_BUFFER_TOO_LARGE' ? 413 : 400); return resolve(null); }
            resolve(out);
          });
        } else if (enc === '' || enc === 'identity') resolve(b);
        else { json(req, res, { erro: 'codificação' }, 415); resolve(null); }
      });
      req.on('error', () => { if (!fim) { fim = true; resolve(null); } });
    });
  }
  async function lerJson(req, res, maximo, exigir) {
    if (exigir !== false && !String(req.headers['content-type'] || '').includes('application/json')) { json(req, res, { erro: 'tipo' }, 415); return undefined; }
    const b = await lerCorpo(req, res, maximo);
    if (b === null) return undefined;
    try { return JSON.parse(b.toString('utf8')); } catch (e) { json(req, res, { erro: 'json' }, 400); return undefined; }
  }

  async function pcPost(req, res, p) {
    if (!chaveOk(req)) { await new Promise((r) => setTimeout(r, 300)); req.resume(); return json(req, res, { erro: 'chave' }, 401); }
    if (p === '/api/pc/ping') { req.resume(); return json(req, res, { ok: true, versao: VERSAO, boot: est.boot, robos: !!ctrl.robos }); }
    if (p === '/api/pc/pagina') {
      const b = await lerCorpo(req, res, MAX_PAGINA);
      if (b === null) return;
      const [c, r] = est.paginaNova(b);
      return json(req, res, r, c);
    }
    const d = await lerJson(req, res, MAX_CORPO_PC);
    if (d === undefined) return;
    const [c, r] = p === '/api/pc/push' ? est.push(d) : est.velasNovas(d);
    json(req, res, r, c);
  }

  async function rota(req, res) {
    const u = new URL(req.url, 'http://x'), p = u.pathname, q = u.searchParams;
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (p === '/saude') return enviar(req, res, Buffer.from('ok'), 'text/plain; charset=utf-8');
      if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (p === '/' || p === '/index.html' || p === '/mesa-de-robos.html') {
        if (!sessaoOk(req)) return html(req, res, PAGINA_ENTRAR);
        if (!est.pagina) return html(req, res, PAGINA_ESPERA);
        return enviar(req, res, Buffer.concat([ctrl.marca, est.pagina.bytes]), 'text/html; charset=utf-8');
      }
      if (!sessaoOk(req)) return json(req, res, { erro: 'login' }, 401);
      if (p === '/api/live' || p === '/api/status') return json(req, res, est.liveVisivel());
      if (p === '/api/candles') { const r = est.candles(q); return r.completo ? enviar(req, res, r.completo[1], 'application/json; charset=utf-8', 200, null, r.completo[2]) : json(req, res, r.corpo); }
      if (p === '/api/noticias') return json(req, res, est.noticiasVisivel());
      if (p === '/api/avisos') return json(req, res, est.avisosVisivel());
      if (p === '/api/ordens') return json(req, res, { ligado: false });
      if (p === '/api/robos') return json(req, res, ctrl.robos ? ctrl.robos.estado() : { ativo: false, motivo: 'desligado' });
      if (p === '/api/mercados') return json(req, res, ctrl.pesquisa ? ctrl.pesquisa.estado() : { ativo: false, mercados: [] });
      if (p === '/api/doc') {
        const m = DOC_RE.exec(q.get('p') || '');
        if (!m) return json(req, res, { erro: 'nome inválido' }, 400);
        const vv = q.get('v'), v = vv !== null && /^-?\d+$/.test(vv) ? parseInt(vv, 10) : null;
        return json(req, res, est.doc(m[1], v));
      }
      return json(req, res, { erro: 'não existe' }, 404);
    }
    if (req.method !== 'POST') return json(req, res, { erro: 'método' }, 405);
    if (p === '/api/entrar') {
      const d = await lerJson(req, res, 1024);
      if (d === undefined) return;
      const [codigo, tok, msg] = acesso.entrar(ipDe(req), isObj(d) ? d.palavra : null);
      if (codigo !== 200) return json(req, res, { erro: msg }, codigo);
      return json(req, res, { ok: true }, 200, { 'Set-Cookie': COOKIE + '=' + tok + '; Path=/; Max-Age=' + Acesso.SESSAO_S + '; HttpOnly; SameSite=Lax' + (seguro(req) ? '; Secure' : '') });
    }
    if (p.startsWith('/api/pc/')) {
      if (!['/api/pc/ping', '/api/pc/push', '/api/pc/pagina', '/api/pc/velas'].includes(p)) { req.resume(); return json(req, res, { erro: 'não existe' }, 404); }
      return pcPost(req, res, p);
    }
    if (!sessaoOk(req)) { req.resume(); return json(req, res, { erro: 'login' }, 401); }
    if (p === '/api/sair') { req.resume(); acesso.sair(lerCookie(req.headers.cookie, COOKIE)); return json(req, res, { ok: true }, 200, { 'Set-Cookie': COOKIE + '=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' + (seguro(req) ? '; Secure' : '') }); }
    if (p === '/api/doc') {
      const m = DOC_RE.exec(q.get('p') || '');
      if (!m) { req.resume(); return json(req, res, { erro: 'nome inválido' }, 400); }
      const dados = await lerJson(req, res, MAX_DOC);
      if (dados === undefined) return;
      const nv = (Array.isArray(dados) || isObj(dados)) ? est.docDoTelemovel(m[1], dados) : 0;
      if (!nv) return json(req, res, { erro: 'não guardei' }, 400);
      return json(req, res, { ok: true, v: nv });
    }
    if (p === '/api/aviso') {
      if (req.headers['x-mesa'] !== '1') { req.resume(); return json(req, res, { erro: 'pedido não reconhecido' }, 403); }
      const d = await lerJson(req, res, 8192);
      if (d === undefined) return;
      if (!isObj(d)) return json(req, res, { erro: 'json' }, 400);
      est.avisoDoTelemovel(d);
      return json(req, res, { ok: true, na_fila: true });
    }
    req.resume();
    if (p.startsWith('/api/ordens') || p.startsWith('/api/avisos')) return json(req, res, { erro: 'Isto só se pode fazer no próprio PC.' }, 403);
    return json(req, res, { erro: 'não existe' }, 404);
  }

  const srv = http.createServer((req, res) => {
    rota(req, res).catch((e) => {
      console.log('Erro no pedido ' + req.method + ' ' + String(req.url).slice(0, 60) + ': ' + (e && e.message));
      try { if (!res.headersSent) json(req, res, { erro: 'interno' }, 500); else res.end(); } catch (e2) { /* já foi */ }
    });
  });
  srv.requestTimeout = 120000; srv.headersTimeout = 30000; srv.keepAliveTimeout = 5000;
  ctrl.srv = srv;
  ctrl.parar = () => new Promise((ok) => {
    if (ctrl.pesquisa) ctrl.pesquisa.parar();
    if (ctrl.robos) ctrl.robos.parar();
    srv.close(() => ok()); if (srv.closeAllConnections) srv.closeAllConnections();
  });
  return ctrl;
}

function validarConfig(palavra, chave) {   // -> texto de erro ou null
  if (palavra.length < 12) return 'RELAY_PASSWORD tem de ter pelo menos 12 caracteres.';
  if (chave.length < 20) return 'RELAY_KEY tem de ter pelo menos 20 caracteres.';
  if (palavra === chave) return 'RELAY_PASSWORD e RELAY_KEY têm de ser diferentes.';
  return null;
}

function principal(env) {
  env = env || process.env;
  const palavra = (env.RELAY_PASSWORD || '').trim(), chave = (env.RELAY_KEY || '').trim();
  const erro = validarConfig(palavra, chave);
  if (erro) {
    console.log('ERRO DE CONFIGURAÇÃO: ' + erro);
    console.log('Define as duas variáveis no painel do alojamento (ver PASSO-A-PASSO-SITE.txt).');
    return 2;
  }
  const porta = parseInt(env.PORT, 10) || 10000;
  const site = criar({ palavra, chave });
  if (env.MESA_SEM_ROBOS === '1') site.marca = MARCA_SITE_SEM_ROBOS;
  else {
    try {
      const { RoboSite } = require('./robo_headless.js'), { Pesquisa } = require('./pesquisa.js');
      site.robos = new RoboSite({ est: site.est, porta, tokenInterno: site.tokenInterno, log: console.log });
      site.pesquisa = new Pesquisa({ est: site.est, log: console.log, guardarCadaS: Number(env.MESA_GUARDAR_S) || 0, pausaMinS: env.MESA_PAUSA_S ? Number(env.MESA_PAUSA_S) : undefined });
      site.robos.iniciar(); site.pesquisa.iniciar();
    } catch (e) {
      console.log('Aviso: os robôs do servidor não arrancaram (' + e.message + '). O site funciona só como ponte.');
      site.robos = null; site.pesquisa = null; site.marca = MARCA_SITE_SEM_ROBOS;
    }
  }
  site.srv.on('error', (e) => { console.log('ERRO: não consegui abrir a porta ' + porta + ' (' + e.message + ').'); process.exit(1); });
  site.srv.listen(porta, '0.0.0.0', () => console.log('Mesa de Robôs - site ' + VERSAO + ' a ouvir na porta ' + porta + (site.robos ? ' (robôs no servidor ligados)' : ' (só ponte)')));
  let antes = null;
  setInterval(() => {
    const on = site.est.pcLigado();
    if (on !== antes) { console.log('Programa do PC: ' + (on ? 'ligado.' : 'sem enviar dados.')); antes = on; }
  }, 5000).unref();
  const sair = () => { site.parar().then(() => process.exit(0)); setTimeout(() => process.exit(0), 4000).unref(); };
  process.on('SIGTERM', sair); process.on('SIGINT', sair);
  process.on('unhandledRejection', (e) => console.log('Erro não tratado: ' + (e && e.message)));
  process.on('uncaughtException', (e) => console.log('Erro inesperado: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)));
  return 0;
}

module.exports = { criar, principal, Acesso, Estado, Serie, validarConfig, VERSAO, STALE_S, MARCA_SITE };
if (require.main === module) { const c = principal(); if (c) process.exit(c); }
