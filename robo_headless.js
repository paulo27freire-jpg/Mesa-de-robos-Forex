/* Mesa de Robôs - OS ROBÔS DO OURO A TRABALHAR NO SERVIDOR, 24 HORAS POR DIA.

   Como funciona: o servidor abre, dentro de si, uma «página virtual» da Mesa de Robôs (o mesmo código
   que corre no teu telemóvel, sem ecrã) e deixa-a sempre aberta. Essa página fala com o próprio site como
   se fosse mais um telemóvel: lê as velas, faz os robôs aprenderem e o Explorador procurar ideias, regista
   o diário simulado e pede os avisos (que o PC envia para o ntfy). O estado vai para os mesmos ficheiros
   que o telemóvel usa, por isso quando abres a página no telemóvel já lá está tudo o que aprenderam.

   Não tem ligação à corretora nem abre ordens. Só simula. */
'use strict';
const vm = require('vm');

const ESPERA_ARRANQUE_S = 12;        // depois do PC falar pela primeira vez: tempo para ele devolver os ficheiros de estado
const ERROS_MAX = 40;                // erros por minuto até reiniciar a página virtual

function extrairScripts(buf) {
  const t = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf), out = [], re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(t))) out.push(m[1]);
  return out;
}

function dummy() {                    // objeto que aceita tudo (o ecrã que não existe)
  const f = function () {};
  return new Proxy(f, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => '';
      if (k === 'length') return 0;
      if (k === 'then') return undefined;
      if (k === Symbol.iterator) return function* () {};
      return dummy();
    },
    set() { return true; }, apply() { return dummy(); }, construct() { return dummy(); }, has() { return false; }
  });
}

/* Cria uma página virtual. Devolve { ctx, parar, erros, hash }. Lança erro se a página tiver formato inesperado. */
function criarPagina(opt) {
  const scripts = extrairScripts(opt.bytes);
  if (scripts.length !== 2 || scripts[0].indexOf('root.Robo') < 0) throw new Error('a página tem um formato que não reconheço (esperava o motor e a aplicação)');
  const inst = { hash: opt.hash, desde: Date.now(), erros: [], ultimoErro: '', timers: new Set(), parado: false, ctx: null };
  const guarda = (f) => function (...a) {
    try { return f.apply(this, a); } catch (e) { inst.erros.push(Date.now()); inst.ultimoErro = String(e && e.message || e).slice(0, 200); }
    return undefined;
  };
  const setT = (f, ms, ...a) => { const id = setTimeout(guarda(f), ms, ...a); inst.timers.add(id); return id; };
  const setI = (f, ms, ...a) => { const id = setInterval(guarda(f), ms, ...a); inst.timers.add(id); return id; };
  const clr = (id) => { clearTimeout(id); clearInterval(id); inst.timers.delete(id); };
  const memoria = new Map();
  const ls = { getItem: (k) => memoria.has(k) ? memoria.get(k) : null, setItem: (k, v) => { memoria.set(k, String(v)); }, removeItem: (k) => { memoria.delete(k); }, clear: () => memoria.clear(), key: (i) => Array.from(memoria.keys())[i] || null, get length() { return memoria.size; } };
  const doc = new Proxy({}, { get(t, k) {
    if (k === 'hidden') return false;
    if (k === 'readyState') return 'complete';
    if (k === 'title') return '';
    if (k === 'activeElement') return null;
    if (k === 'querySelectorAll' || k === 'getElementsByClassName' || k === 'getElementsByTagName') return () => [];
    return dummy();
  }, set() { return true; } });
  const base = 'http://127.0.0.1:' + opt.porta;
  const fetchInterno = (u, o) => {
    o = Object.assign({}, o);
    o.headers = Object.assign({}, o.headers, { 'X-Mesa-Interno': opt.tokenInterno });
    return fetch(base + u, o);
  };
  const ctx = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout: setT, setInterval: setI, clearTimeout: clr, clearInterval: clr, queueMicrotask,
    AbortController, URL, TextEncoder, TextDecoder, structuredClone, atob, btoa,
    localStorage: ls, sessionStorage: ls, document: doc,
    navigator: { userAgent: 'mesa-servidor', language: 'pt-PT', onLine: true },
    location: { protocol: 'http:', search: '?debug', hash: '', hostname: 'servidor', host: 'servidor', origin: 'http://servidor', href: 'http://servidor/', pathname: '/', reload() {} },
    fetch: fetchInterno, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} }), getComputedStyle: () => dummy(),
    MutationObserver: function () { return { observe() {}, disconnect() {} }; }, ResizeObserver: function () { return { observe() {}, disconnect() {} }; }, IntersectionObserver: function () { return { observe() {}, disconnect() {} }; },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800,
    performance: { now: () => Date.now() }, Image: function () { return dummy(); }, Audio: function () { return dummy(); }, Blob: function () {}, FileReader: function () {},
    CustomEvent: function () {}, Event: function () {}, history: { replaceState() {}, pushState() {} }, scrollTo() {}, open() { return null; }
  };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx; ctx.MESA_SITE = 1; ctx.MESA_ROBOS = 1; ctx.__HEADLESS = true;
  vm.createContext(ctx);
  inst.ctx = ctx;
  vm.runInContext(scripts[0], ctx, { filename: 'motor.js' });
  let app = scripts[1];
  const ancora = 'function boot() {';
  if (app.indexOf(ancora) >= 0) app = app.replace(ancora, 'if (window.__HEADLESS) { render = safeRender = drawChart = drawScene = updateScene = liveFrame = renderFoot = function () {}; }\n' + ancora);
  else inst.ultimoErro = 'aviso: não encontrei o ponto de arranque da página; corre sem as simplificações';
  vm.runInContext(app, ctx, { filename: 'mesa.js' });
  inst.parar = () => {
    if (inst.parado) return;
    inst.parado = true;
    try { if (ctx.__mesa && ctx.__mesa.save) ctx.__mesa.save(); } catch (e) { /* já vai */ }
    for (const id of inst.timers) { clearTimeout(id); clearInterval(id); }
    inst.timers.clear();
    ctx.fetch = () => Promise.reject(new Error('parado'));
  };
  inst.errosPorMinuto = () => { const t = Date.now() - 60000; inst.erros = inst.erros.filter((x) => x > t); return inst.erros.length; };
  return inst;
}

class RoboSite {
  constructor(o) {
    this.est = o.est; this.porta = o.porta; this.tokenInterno = o.tokenInterno;
    this.log = o.log || (() => {});
    this.relogio = o.relogio || (() => Date.now() / 1000);
    this.espera = o.esperaS === undefined ? ESPERA_ARRANQUE_S : o.esperaS;
    this.inst = null; this.tmr = null; this.motivo = 'a aguardar o PC'; this.reinicios = 0; this.proxTentativa = 0; this.falhasSeguidas = 0;
  }
  iniciar() {
    if (this.tmr) return;
    this.tmr = setInterval(() => this._vigia(), 2000);
    if (this.tmr.unref) this.tmr.unref();
  }
  parar() {
    if (this.tmr) { clearInterval(this.tmr); this.tmr = null; }
    this._derrubar('servidor a parar');
  }
  _derrubar(motivo) {
    if (this.inst) { try { this.inst.parar(); } catch (e) { /* ok */ } this.inst = null; this.log('Robôs do servidor: página virtual parada (' + motivo + ').'); }
  }
  _vigia() {
    const est = this.est, agora = this.relogio();
    if (this.inst) {
      if (est.pagina && est.pagina.hash !== this.inst.hash) { this._derrubar('o PC enviou uma versão nova da página'); this.proxTentativa = agora + 3; return; }
      if (this.inst.errosPorMinuto() > ERROS_MAX) { this.reinicios++; this._derrubar('demasiados erros: ' + this.inst.ultimoErro); this.proxTentativa = agora + 30; }
      return;
    }
    if (agora < this.proxTentativa) return;
    if (!est.pagina) { this.motivo = 'à espera da página enviada pelo PC'; return; }
    if (!est.pcLigado()) { this.motivo = 'à espera do PC'; return; }
    if (!est.series.size) { this.motivo = 'à espera das velas do ouro'; return; }
    if (!est.primeiroPush || agora - est.primeiroPush < this.espera) { this.motivo = 'a deixar o PC devolver os ficheiros de estado'; return; }
    this._arrancar();
  }
  _arrancar() {
    try {
      this.inst = criarPagina({ bytes: this.est.pagina.bytes, hash: this.est.pagina.hash, porta: this.porta, tokenInterno: this.tokenInterno });
      this.motivo = ''; this.falhasSeguidas = 0;
      this.log('Robôs do servidor: a trabalhar (página virtual aberta).');
    } catch (e) {
      this.inst = null; this.falhasSeguidas++;
      this.motivo = 'não consegui abrir a página virtual: ' + e.message;
      this.proxTentativa = this.relogio() + Math.min(300, 20 * this.falhasSeguidas);
      this.log('Robôs do servidor: ' + this.motivo);
    }
  }
  estado() {
    const r = { ativo: !!this.inst, motivo: this.motivo, reinicios: this.reinicios };
    const i = this.inst;
    if (!i) return r;
    r.desde = Math.floor(i.desde / 1000);
    r.erros_ultimo_minuto = i.errosPorMinuto();
    if (i.ultimoErro) r.ultimo_erro = i.ultimoErro;
    try {
      const m = i.ctx.__mesa;
      if (!m || !m.state) { r.motivo = 'a arrancar'; return r; }
      const st = m.state, A = st.auto || {}, R = i.ctx.Robo;
      r.ligado_ao_pc = !!m.live.on;
      r.fonte = m.baseDS && m.baseDS.source;
      r.velas = m.baseDS && m.baseDS.ctx ? m.baseDS.ctx.n : 0;
      r.estado_rev = st.rev || 0;
      r.robos = (st.workers || []).map((w) => ({ id: w.id, nome: w.name, tf: w.tf, gen: w.gen || 0 }));
      r.auto = { ligado: A.on !== false, n: A.n || {}, ok: A.ok || {}, at: A.at || {}, ultimo: A.last || null };
      const lw = (st.workers || []).filter((w) => w.id === 'lab')[0];
      if (lw && R) { const mm = R.labMem(lw); r.explorador = { procuras: mm.runs, testadas: mm.tried, ultima: mm.ts, confirmadas: (mm.hall || []).filter((h) => h.st === 'confirmada').length }; }
      r.diario = (st.journal || []).length;
    } catch (e) { r.erro_estado = String(e.message).slice(0, 120); }
    return r;
  }
}

module.exports = { RoboSite, criarPagina, extrairScripts, ESPERA_ARRANQUE_S };
