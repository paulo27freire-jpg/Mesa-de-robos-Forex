/* Mesa de Robôs - INVESTIGAÇÃO DOS OUTROS MERCADOS (complemento do ouro).

   O ouro é o ativo principal e tem os seus próprios robôs (robo_headless.js). Aqui, em segundo plano e
   com pouco tempo de cálculo, o Explorador procura ideias de entrada nos pares de forex e nos índices que
   o PC envia, e junta uma leitura de contexto para o ouro (dólar e índices a confirmar ou a contrariar).

   Honestidade, para ninguém se enganar:
   - Tudo é simulado em velas passadas. Nada aqui é uma promessa de lucro.
   - Cada mercado é posto à escala de volatilidade do ouro (o motor foi afinado em stops de 100 a 150 pips
     do ouro), para o stop valer o mesmo número de ATR. Os resultados são em R (múltiplos do risco).
   - Desconta-se o spread atual do teu corretor em cada trade.
   - «Validada a seguir» só conta trades DEPOIS de a ideia ter sido escolhida: é o único teste que o
     passado não consegue viciar. Até lá, uma ideia é só «promissora».
   Só usa a biblioteca padrão do Node. */
'use strict';
const vm = require('vm');
const { extrairScripts } = require('./robo_headless.js');

const TFS = [15, 60];
const K_PADRAO = 5;                         // ATR M15 do ouro (em dólares) se ainda não houver velas dele
const MIN_NOVAS = 4;                        // velas novas até voltar a procurar
const INTERVALO_OURO_S = 20 * 60;
const INTERVALO_OUTROS_S = 40 * 60;
const PAUSA_MIN_S = 15;
const FOLGA = 12;                           // depois de gastar d ms, descansa 12 d (≈ 8% do tempo no máximo)
const GUARDAR_CADA_S = 120;
const ESPERA_ARRANQUE_S = 12;
const MAX_HIST = 6;
const NOMES = { XAUUSD: 'Ouro', EURUSD: 'Euro/Dólar', GBPUSD: 'Libra/Dólar', USDJPY: 'Dólar/Iene', AUDUSD: 'Austrália/Dólar', USDCAD: 'Dólar/Canadá', USDCHF: 'Dólar/Franco', NZDUSD: 'N. Zelândia/Dólar', US30: 'Dow Jones', NAS100: 'Nasdaq 100', SPX500: 'S&P 500', GER40: 'DAX 40' };
const ORDEM = Object.keys(NOMES);
const USD_FRACO_SOBE = ['EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD'];   // par sobe = dólar desce
const USD_FORTE_SOBE = ['USDJPY', 'USDCAD', 'USDCHF'];            // par sobe = dólar sobe
const INDICES = ['US30', 'NAS100', 'SPX500', 'GER40'];

function carregarMotor(bytes) {
  const s = extrairScripts(bytes);
  if (s.length < 1 || s[0].indexOf('root.Robo') < 0) throw new Error('motor não encontrado na página');
  const ctx = {}; ctx.window = ctx; ctx.console = { log() {}, warn() {}, error() {} };
  vm.createContext(ctx);
  vm.runInContext(s[0], ctx, { filename: 'motor.js' });
  if (!ctx.Robo || typeof ctx.Robo.evolve !== 'function') throw new Error('motor incompleto');
  return ctx.Robo;
}

/* ---------- pequenas contas ---------- */
const mediana = (a) => { if (!a.length) return 0; const b = a.slice().sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
function atrMediano(velas, n) {            // ATR simples de n velas, mediana ao longo de toda a série
  n = n || 14; if (!velas || velas.length < n + 50) return 0;
  const tr = [], out = [];
  for (let i = 0; i < velas.length; i++) { const v = velas[i], pc = i ? velas[i - 1][4] : v[4]; tr.push(Math.max(v[2] - v[3], Math.abs(v[2] - pc), Math.abs(v[3] - pc))); }
  let s = 0;
  for (let i = 0; i < tr.length; i++) { s += tr[i]; if (i >= n) s -= tr[i - n]; if (i >= n - 1 && (i % 7 === 0)) out.push(s / n); }
  return mediana(out);
}
function ema(a, n) { const k = 2 / (n + 1), out = []; let e = a[0]; for (let i = 0; i < a.length; i++) { e = i ? a[i] * k + e * (1 - k) : a[0]; out.push(e); } return out; }
function tendencia(velas) {                 // +1 alta, -1 baixa, 0 lateral (EMA 20 contra EMA 50 em H1, com inclinação)
  if (!velas || velas.length < 80) return null;
  const c = velas.slice(-200).map((v) => v[4]), e20 = ema(c, 20), e50 = ema(c, 50), n = c.length - 1;
  const atr = atrMediano(velas.slice(-300), 14) || 1e-9, gap = (e20[n] - e50[n]) / atr, incl = (e20[n] - e20[n - 6]) / atr;
  if (gap > 0.15 && incl > 0) return 1;
  if (gap < -0.15 && incl < 0) return -1;
  return 0;
}
function retornos(velas, desde) {           // {t: log-retorno} das últimas velas
  const m = new Map();
  for (let i = Math.max(1, velas.length - desde); i < velas.length; i++) if (velas[i][4] > 0 && velas[i - 1][4] > 0) m.set(velas[i][0], Math.log(velas[i][4] / velas[i - 1][4]));
  return m;
}
function correlacao(ma, mb) {
  const xs = [], ys = [];
  for (const [t, x] of ma) { const y = mb.get(t); if (y !== undefined) { xs.push(x); ys.push(y); } }
  if (xs.length < 40) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length, my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;

class Pesquisa {
  constructor(o) {
    this.est = o.est; this.log = o.log || (() => {});
    this.relogio = o.relogio || (() => Date.now() / 1000);
    this.espera = o.esperaS === undefined ? ESPERA_ARRANQUE_S : o.esperaS;
    this.pausaMin = o.pausaMinS === undefined ? PAUSA_MIN_S : o.pausaMinS;
    this.guardarCada = o.guardarCadaS > 0 ? o.guardarCadaS : GUARDAR_CADA_S;
    this.R = null; this.motorHash = null;
    this.dados = { v: 1, K: 0, mercados: {} };      // o que se guarda (ficheiro «mercados»)
    this.carregado = false; this.sujo = false; this.ultGuardar = 0;
    this.proxCiclo = 0; this.ultCiclo = null; this.tmr = null; this.erro = ''; this.contexto = null; this.ultContexto = 0;
    this.inicio = Date.now();
  }
  iniciar() { if (this.tmr) return; this.tmr = setInterval(() => this.ciclo(), 5000); if (this.tmr.unref) this.tmr.unref(); }
  parar() { if (this.tmr) { clearInterval(this.tmr); this.tmr = null; } this._guardar(true); }

  /* --- dados que o site tem */
  _velas(sim, tf) {
    const est = this.est;
    if (sim === 'XAUUSD') { const s = est.series.get(tf); return s ? s.velas : null; }
    const m = est.mercados.get(sim), s = m && m.series.get(tf);
    return s ? s.velas : null;
  }
  _info(sim) {
    const est = this.est;
    if (sim === 'XAUUSD') { const l = est.live || {}, sp = (typeof l.ask === 'number' && typeof l.bid === 'number' && l.ask > l.bid) ? l.ask - l.bid : null; return { mt5: l.simbolo || 'XAUUSD', spread: sp, preco: l.preco === undefined ? null : l.preco, tipo: 'ouro' }; }
    const m = est.mercados.get(sim); return m ? m.info : {};
  }
  _simbolos() {
    const t = new Set(['XAUUSD']); for (const s of this.est.mercados.keys()) t.add(s);
    return Array.from(t).sort((a, b) => { const x = ORDEM.indexOf(a), y = ORDEM.indexOf(b); return (x < 0 ? 99 : x) - (y < 0 ? 99 : y) || (a < b ? -1 : 1); });
  }
  _m(sim) { return this.dados.mercados[sim] || (this.dados.mercados[sim] = { escala: 0, tfs: {} }); }
  _e(sim, tf) {
    const m = this._m(sim);
    return m.tfs[tf] || (m.tfs[tf] = { w: null, runs: 0, tried: 0, ts: 0, lastT: 0, camp: null, hist: [], det: null });
  }

  /* --- motor (vem na página que o PC envia) e ficheiro de estado */
  _motor() {
    const pg = this.est.pagina;
    if (!pg) return false;
    if (this.R && this.motorHash === pg.hash) return true;
    try { this.R = carregarMotor(pg.bytes); this.motorHash = pg.hash; this.erro = ''; return true; }
    catch (e) { this.R = null; this.erro = e.message; return false; }
  }
  _carregar() {
    if (this.carregado) return;
    this.carregado = true;
    const d = this.est.docs.get('mercados');
    if (d && d.dados && typeof d.dados === 'object' && d.dados.mercados && typeof d.dados.mercados === 'object') {
      this.dados = Object.assign({ v: 1, K: 0 }, d.dados);
      this.log('Investigação dos mercados: estado anterior recuperado (' + Object.keys(this.dados.mercados).length + ' mercados).');
    }
  }
  _guardar(forcar) {
    if (!this.sujo) return;
    const t = this.relogio();
    if (!forcar && t - this.ultGuardar < this.guardarCada) return;
    this.est.docInterno('mercados', this.dados);
    this.sujo = false; this.ultGuardar = t;
  }

  /* --- escala de volatilidade */
  _K() {
    if (this.dados.K > 0) return this.dados.K;
    const v = this._velas('XAUUSD', 15), a = v ? atrMediano(v) : 0;
    if (a > 0) { this.dados.K = r4(a); this.sujo = true; return this.dados.K; }
    return 0;
  }
  _escala(sim) {
    if (sim === 'XAUUSD') return 1;
    const m = this._m(sim);
    if (m.escala > 0) return m.escala;
    const K = this._K() || K_PADRAO;
    let a = atrMediano(this._velas(sim, 15) || []);
    if (!(a > 0)) { const h = atrMediano(this._velas(sim, 60) || []); a = h / 2; }
    if (!(a > 0)) return 0;
    m.escala = K / a; this.sujo = true;
    return m.escala;
  }

  /* --- um trabalho: uma geração do Explorador num mercado e tempo gráfico */
  _proximo(agora) {
    const R = this.R; let melhor = null;
    for (const sim of this._simbolos()) {
      for (const tf of TFS) {
        const v = this._velas(sim, tf);
        if (!v || v.length < R.LAB_MIN_BARS + 50) continue;
        const e = this._e(sim, tf), lastT = v[v.length - 1][0], interv = sim === 'XAUUSD' ? INTERVALO_OURO_S : INTERVALO_OUTROS_S;
        if (e.runs && (lastT - e.lastT < MIN_NOVAS * tf * 60 || agora - e.ts / 1000 < interv)) continue;
        const pri = (sim === 'XAUUSD' ? 0 : 1e12) + e.ts;
        if (!melhor || pri < melhor.pri) melhor = { sim, tf, pri };
      }
    }
    return melhor;
  }
  _trabalho(sim, tf) {
    const R = this.R, v = this._velas(sim, tf), esc = this._escala(sim);
    if (!v || !(esc > 0)) return null;
    const velas = v.slice(-6000), cand = velas.map((x) => ({ t: x[0], o: x[1] * esc, h: x[2] * esc, l: x[3] * esc, c: x[4] * esc }));
    const ctx = R.makeCtx(cand), e = this._e(sim, tf);
    if (!e.w) {
      e.w = R.labWorker(); e.w.id = 'lab-' + sim + '-' + tf; e.w.tf = tf; e.w.name = 'Explorador ' + sim + ' ' + (tf === 60 ? 'H1' : 'M' + tf);
      e.w.params.maxBars = tf === 60 ? 72 : 192;
    }
    const t0 = Date.now(), res = R.evolve(ctx, e.w, {}), dt = Date.now() - t0;
    e.w = res.worker; e.runs += 1; e.tried = (e.w.mem && e.w.mem.tried) || e.tried; e.ts = Date.now(); e.lastT = velas[velas.length - 1][0];
    e.ult = { ok: !!res.ok, txt: String(res.entry && res.entry.txt || '').slice(0, 120), ms: dt };
    this._campeao(sim, tf, e, ctx, velas, esc);
    this.sujo = true;
    return dt;
  }
  _custo(sim, esc) { const i = this._info(sim), s = i && typeof i.spread === 'number' && i.spread > 0 ? i.spread : 0; return s * esc; }
  _stats(arr) { const s = this.R.stats(arr.map((R_) => ({ R: R_ }))); return { n: s.n, win: r2(s.winRate), avgR: r2(s.avgR), pf: r2(Math.min(s.pf, 9.99)) }; }
  _detalhe(sim, e, ctx, velas, esc, g) {
    const R = this.R, ev = R.labEval(ctx, e.w, g, true), cs = this._custo(sim, esc), t0 = e.camp ? e.camp.t0 : 0;
    const liq = (t) => { const dist = t.f && t.f.slPips ? t.f.slPips * R.PIP : 0; return t.R - (dist > 0 ? cs / dist : 0); };
    const T = ev.trades, te = [], todas = [], fwd = [], fwdBruto = [], sl = [];
    for (const t of T) {
      const x = liq(t); todas.push(x);
      if (t.i >= ev.s2) te.push(x);
      if (t0 && velas[t.i] && velas[t.i][0] > t0) { fwd.push(x); fwdBruto.push(t.R); }
      if (t.f && t.f.slPips) sl.push(t.f.slPips * R.PIP);
    }
    const dias = velas.length > 1 ? (velas[velas.length - 1][0] - velas[0][0]) / 86400 : 0, K = this._K() || K_PADRAO;
    return { bt: this._stats(T.map((t) => t.R)), liq: this._stats(todas), te: this._stats(te), fwd: this._stats(fwd), fwdBruto: fwdBruto.length ? r2(fwdBruto.reduce((s, x) => s + x, 0) / fwdBruto.length) : 0,
      sl_atr: sl.length ? r2(mediana(sl) / K) : null, por_dia: dias > 0 ? r2(T.length / dias) : null, custo_R: T.length ? r2(1 - (todas.reduce((s, x) => s + x, 0) / Math.max(1e-9, T.reduce((s, t) => s + t.R, 0))) || 0) : 0, ts: Date.now() };
  }
  _campeao(sim, tf, e, ctx, velas, esc) {
    const R = this.R, mem = R.labMem(e.w), conf = (mem.hall || []).filter((h) => h.st === 'confirmada').sort((a, b) => b.sel - a.sel);
    const topo = conf[0], atual = e.camp, ultT = velas[velas.length - 1][0];
    if (topo && (!atual || (topo.k !== atual.k && topo.sel > (atual.sel || 0) * 1.1 + 0.05))) {
      if (atual) { e.hist.unshift({ k: atual.k, txt: atual.txt, t0: atual.t0, ate: ultT, fwd: e.det ? e.det.fwd : null }); e.hist = e.hist.slice(0, MAX_HIST); }
      e.camp = { k: topo.k, g: topo.g, txt: topo.txt, sel: topo.sel, t0: ultT, desde: Date.now(), st: topo.st };
    } else if (topo && atual && topo.k === atual.k) atual.sel = topo.sel;
    if (!e.camp) { e.det = null; return; }
    try { e.det = this._detalhe(sim, e, ctx, velas, esc, e.camp.g); } catch (err) { this.erro = 'detalhe: ' + err.message; }
  }

  /* --- contexto para o ouro */
  _contexto() {
    const ouro = this._velas('XAUUSD', 60);
    if (!ouro || ouro.length < 120) { this.contexto = null; return; }
    const ro = retornos(ouro, 160), t0 = tendencia(ouro), out = { ouro: { tend: t0, mov24: ouro.length > 24 ? r2((ouro[ouro.length - 1][4] / ouro[ouro.length - 25][4] - 1) * 100) : null }, mercados: {}, ts: Date.now() };
    const tf = (arr) => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null;
    const dol = [], ind = [], cor = [];
    for (const sim of this._simbolos()) {
      if (sim === 'XAUUSD') continue;
      const v = this._velas(sim, 60); if (!v || v.length < 120) continue;
      const t = tendencia(v), c = correlacao(ro, retornos(v, 160)), mov = r2((v[v.length - 1][4] / v[v.length - 25][4] - 1) * 100);
      out.mercados[sim] = { tend: t, mov24: mov, corr: c === null ? null : r2(c) };
      if (USD_FRACO_SOBE.includes(sim) && t !== null) { dol.push(-t); if (c !== null) cor.push(-c); }
      if (USD_FORTE_SOBE.includes(sim) && t !== null) { dol.push(t); if (c !== null) cor.push(c); }
      if (INDICES.includes(sim) && t !== null) ind.push(t);
    }
    const dolar = tf(dol), indices = tf(ind), corr = tf(cor);
    out.dolar = dolar === null ? null : { score: r2(dolar), n: dol.length, corr_ouro: corr === null ? null : r2(corr) };
    out.indices = indices === null ? null : { score: r2(indices), n: ind.length };
    const sg = (x) => x === null || x === undefined ? 0 : (x > 0.34 ? 1 : (x < -0.34 ? -1 : 0));
    let leitura = 'sem dados suficientes';
    if (out.dolar && t0 !== null) {
      const d = sg(out.dolar.score), c = out.dolar.corr_ouro;
      if (c === null || Math.abs(c) < 0.15) leitura = 'o ouro anda hoje sem relação clara com o dólar';
      else if (!d || !t0) leitura = 'dólar ou ouro sem direção clara: sem confirmação';
      else { const esperado = c < 0 ? -d : d; leitura = esperado === t0 ? 'o dólar confirma o ouro' : 'o dólar contraria o ouro'; }
    }
    out.leitura = leitura;
    this.contexto = out;
  }

  ciclo() {
    const agora = this.relogio(), est = this.est;
    try {
      if (!this._motor()) return;
      if (!est.primeiroPush || agora - est.primeiroPush < this.espera || !est.pcLigado()) { this._guardar(false); return; }
      this._carregar();
      if (agora - this.ultContexto >= 60) { this.ultContexto = agora; this._contexto(); }
      if (agora >= this.proxCiclo) {
        const j = this._proximo(agora);
        if (j) {
          const dt = this._trabalho(j.sim, j.tf);
          this.ultCiclo = { sim: j.sim, tf: j.tf, ts: Date.now(), ms: dt };
          this.proxCiclo = agora + Math.max(this.pausaMin, ((dt || 0) * FOLGA) / 1000);
        }
      }
      this._guardar(false);
    } catch (e) { this.erro = String(e && e.message || e).slice(0, 160); this.log('Investigação dos mercados: erro (' + this.erro + ')'); this.proxCiclo = agora + 60; }
  }

  /* --- o que a página mostra */
  estado() {
    const R = this.R, linhas = [], mercados = [];
    for (const sim of this._simbolos()) {
      const inf = this._info(sim), m = this.dados.mercados[sim] || { tfs: {} }, tfs = {};
      for (const tf of TFS) {
        const v = this._velas(sim, tf), e = m.tfs && m.tfs[tf];
        const t = { velas: v ? v.length : 0 };
        if (e) {
          const mem = R && e.w ? R.labMem(e.w) : null;
          Object.assign(t, { procuras: e.runs, testadas: e.tried, ultima: e.ts, ultima_ok: e.ult || null, ideia: e.camp ? { k: e.camp.k, txt: e.camp.txt, desde: e.camp.desde } : null, det: e.det || null, hist: e.hist || [],
            confirmadas: mem ? (mem.hall || []).filter((h) => h.st === 'confirmada').length : 0, promissoras: mem ? (mem.hall || []).filter((h) => h.st === 'promissora').length : 0 });
          const d = e.det;
          if (e.camp && d) {
            const validada = d.fwd.n >= 12 && d.fwd.avgR > 0.03 && d.fwd.pf >= 1.1 && d.te.avgR > 0;
            const nivel = validada ? 3 : (d.te.avgR > 0 && d.te.n >= 8 ? 2 : 1);
            t.nivel = nivel;
            linhas.push({ sim, nome: NOMES[sim] || sim, tf, txt: e.camp.txt, nivel, validada, te: d.te, fwd: d.fwd, liq: d.liq, sl_atr: d.sl_atr, por_dia: d.por_dia, score: d.te.avgR * Math.sqrt(Math.max(1, d.te.n)), desde: e.camp.desde });
          }
        }
        tfs[tf] = t;
      }
      mercados.push({ sim, nome: NOMES[sim] || sim, mt5: inf.mt5 || '', preco: inf.preco === undefined ? null : inf.preco, spread: inf.spread === undefined ? null : inf.spread, escala: (m.escala && r4(m.escala)) || (sim === 'XAUUSD' ? 1 : 0), tfs });
    }
    linhas.sort((a, b) => b.nivel - a.nivel || b.score - a.score);
    return { ativo: !!this.tmr, motor: !!R, erro: this.erro || undefined, K: this.dados.K || null, ultimo: this.ultCiclo, mercados, ranking: linhas, contexto: this.contexto, ts: Date.now() };
  }
}

module.exports = { Pesquisa, carregarMotor, atrMediano, tendencia, correlacao, retornos, NOMES, TFS };
