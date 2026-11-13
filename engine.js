/* Spike setup engine. Pure functions, no DOM. Works in browser (window.SetupEngine) and Node (module.exports). */
(function (root) {
  'use strict';

  var DEFAULTS = {
    swing: 5,            // pivot length used for market structure (BOS / CHoCH)
    allowAfterChoch: false, // allow setups after a CHoCH (before a BOS confirms the trend)
    knotBars: 8,         // number of bars that make the "knot" (consolidation) before the spike
    useKnot: true,       // require the knot to be tight
    knotMaxATR: 3,       // max knot height in ATR
    atrLen: 14,
    bodyAvgLen: 10,
    bodyVsAvg: 1.3,      // spike body >= this x average body
    bodyMinATR: 0.8,     // spike body >= this x ATR
    wickRatio: 0.3,      // each wick <= this x body
    firstOnly: true,     // only the first break after a BOS is a candidate
    maxWait: 3,          // candles (after the first candle following the spike) in which price may come back to the entry level
    stopMode: 'swing',   // 'swing' = behind the last swing low before the spike candle (origin of the move), 'spike' = behind lowest low from spike to entry, 'next' = behind low of candle after spike
    stopSwing: 5,        // bars on the left a swing low must be lower than
    stopLookback: 60,    // how far back to look for that swing low
    bufferATR: 0.1,      // stop buffer in ATR
    minRiskATR: 0,
    maxRiskATR: 15,      // 0 = no limit
    rr: 1,               // target = rr x risk (1 = 1:1)
    second: true,        // second entry enabled
    e2Frac: 0.5,         // second entry at this fraction of the stop distance
    cancelPct: 0.9       // second order cancelled once trade 1 reaches this share of the way to target
  };

  function merge(p) {
    var o = {}, k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    if (p) for (k in p) if (p[k] !== undefined) o[k] = p[k];
    return o;
  }

  function calcATR(bars, len) {
    var out = new Array(bars.length), sum = 0, i, tr, pc;
    for (i = 0; i < bars.length; i++) {
      out[i] = NaN;
      pc = i > 0 ? bars[i - 1].c : null;
      tr = i === 0 ? bars[i].h - bars[i].l :
        Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - pc), Math.abs(bars[i].l - pc));
      if (i < len) { sum += tr; if (i === len - 1) out[i] = sum / len; }
      else out[i] = (out[i - 1] * (len - 1) + tr) / len;
    }
    return out;
  }

  function invertBars(bars) {
    return bars.map(function (b) { return { t: b.t, o: -b.o, h: -b.l, l: -b.h, c: -b.c }; });
  }


  // last swing low strictly before the spike candle: lower than every bar after it (up to the spike)
  // and lower than the k bars on its left. Returns {idx, price} or null.
  function swingLowBefore(bars, s, k, maxBack) {
    var runMin = bars[s].l, lim = Math.max(k, s - maxBack), p, j, ok, lp;
    for (p = s - 1; p >= lim; p--) {
      lp = bars[p].l;
      if (lp <= runMin) {
        ok = true;
        for (j = p - k; j < p; j++) if (bars[j].l <= lp) { ok = false; break; }
        if (ok) return { idx: p, price: lp };
        runMin = lp;
      }
    }
    return null;
  }

  /* ---- trade management (buy side; sell side is handled by running on inverted prices) ---- */

  function fillEntry(s, bar, i, bars, P) {
    var L = s.level, E = Math.min(L, bar.o), low = L, k;
    if (P.stopMode === 'swing') low = s.baseLow;
    else if (P.stopMode !== 'next') for (k = s.spikeIdx; k < i; k++) if (bars[k].l < low) low = bars[k].l;
    var S = low - P.bufferATR * s.atr;
    var R = E - S;
    s.entryIdx = i; s.entryTime = bar.t;
    if (!(R > 0)) { s.state = 'skipped'; s.note = 'gap'; return; }
    if (P.maxRiskATR > 0 && R > P.maxRiskATR * s.atr) { s.state = 'skipped'; s.note = 'risk-high'; s.entry = E; s.stop = S; return; }
    if (R < P.minRiskATR * s.atr) { s.state = 'skipped'; s.note = 'risk-low'; s.entry = E; s.stop = S; return; }
    s.entry = E; s.stop = S; s.risk = R;
    s.target = E + P.rr * R;
    s.e2 = E - P.e2Frac * R;
    s.cancelLvl = E + P.cancelPct * (s.target - E);
    s.t2 = { state: P.second ? 'waiting' : 'off', price: null, idx: null };
    s.state = 'open';
    // entry bar: the target is not evaluated (path inside the bar unknown); stop is.
    if (bar.l <= S) {
      if (P.second) { s.t2.state = 'filled'; s.t2.price = s.e2; s.t2.idx = i; }
      closeTrade(s, S, i, bar.t, 'stop');
    } else if (P.second && bar.l <= s.e2) {
      s.t2.state = 'filled'; s.t2.price = s.e2; s.t2.idx = i; s.t2.time = bar.t;
    }
  }

  function closeTrade(s, exit, i, t, how) {
    s.state = 'closed'; s.outcome = how; s.exit = exit; s.exitIdx = i; s.exitTime = t;
    s.r1 = (exit - s.entry) / s.risk;
    s.r2 = s.t2 && s.t2.state === 'filled' ? (exit - s.t2.price) / s.risk : 0;
    s.totalR = s.r1 + s.r2;
  }

  function stepOpen(s, bar, i) {
    var S = s.stop, T = s.target, t2 = s.t2, exit;
    if (bar.o <= S || bar.l <= S) {
      exit = bar.o <= S ? bar.o : S;
      if (t2.state === 'waiting' && bar.o > S) { t2.state = 'filled'; t2.price = s.e2; t2.idx = i; t2.time = bar.t; }
      closeTrade(s, exit, i, bar.t, 'stop');
    } else if (bar.h >= T) {
      exit = bar.o >= T ? bar.o : T;
      closeTrade(s, exit, i, bar.t, 'target');
    } else if (t2.state === 'waiting') {
      if (bar.h >= s.cancelLvl) t2.state = 'canceled';
      else if (bar.l <= s.e2) { t2.state = 'filled'; t2.price = Math.min(s.e2, bar.o); t2.idx = i; t2.time = bar.t; }
    }
  }

  function manage(s, bar, i, isClosed, bars, P) {
    if (s.state === 'waitC1') {
      if (i === s.spikeIdx + 1 && isClosed) { s.c1Idx = i; s.level = bar.l; s.state = 'pending'; s.wait = 0; }
    } else if (s.state === 'pending') {
      s.wait++;
      if (bar.l <= s.level) fillEntry(s, bar, i, bars, P);
      else if (s.wait >= P.maxWait) { s.state = 'expired'; s.note = 'timeout'; }
    } else if (s.state === 'open') {
      stepOpen(s, bar, i);
    }
  }

  /* ---- one pass: market structure + spike detection, long side only ---- */

  function runPass(bars, P, forming) {
    var n = bars.length, atr = calcATR(bars, P.atrLen), setups = [], events = [];
    var lastH = null, lastL = null, trend = 0, confirmed = false, armed = false, armBar = -1;
    var active = null, closedN = forming ? n - 1 : n;
    var warm = Math.max(P.knotBars, P.atrLen, P.bodyAvgLen, 2 * P.swing) + 1;
    var i, j, p, bar, isClosed, ok, win;

    for (i = 0; i < n; i++) {
      bar = bars[i]; isClosed = i < closedN;
      if (active) {
        manage(active, bar, i, isClosed, bars, P);
        if (active.state === 'closed' || active.state === 'expired' || active.state === 'skipped') active = null;
      }
      if (!isClosed) continue;

      // pivots (confirmed P.swing bars late)
      p = i - P.swing;
      if (p >= P.swing) {
        var isH = true, isL = true;
        for (j = p - P.swing; j <= p + P.swing; j++) {
          if (j === p) continue;
          if (j < p) { if (bars[j].h >= bars[p].h) isH = false; if (bars[j].l <= bars[p].l) isL = false; }
          else { if (bars[j].h > bars[p].h) isH = false; if (bars[j].l < bars[p].l) isL = false; }
        }
        if (isH) lastH = { price: bars[p].h, idx: p, crossed: false };
        if (isL) lastL = { price: bars[p].l, idx: p, crossed: false };
      }

      // structure breaks by close
      if (lastH && !lastH.crossed && bar.c > lastH.price) {
        lastH.crossed = true;
        if (trend === 1) { events.push({ idx: i, t: bar.t, type: 'BOS', dir: 1, level: lastH.price, from: lastH.idx }); confirmed = true; }
        else { events.push({ idx: i, t: bar.t, type: 'CHoCH', dir: 1, level: lastH.price, from: lastH.idx }); trend = 1; confirmed = false; }
        armed = true; armBar = i;
      } else if (lastL && !lastL.crossed && bar.c < lastL.price) {
        lastL.crossed = true;
        if (trend === -1) { events.push({ idx: i, t: bar.t, type: 'BOS', dir: -1, level: lastL.price, from: lastL.idx }); confirmed = true; }
        else { events.push({ idx: i, t: bar.t, type: 'CHoCH', dir: -1, level: lastL.price, from: lastL.idx }); trend = -1; confirmed = false; }
        armed = false; armBar = i;
      }
      if (active && (active.state === 'waitC1' || active.state === 'pending') && trend !== 1) {
        active.state = 'expired'; active.note = 'trend-flip'; active = null;
      }

      // spike detection
      if (active || trend !== 1 || !(confirmed || P.allowAfterChoch)) continue;
      if (i < warm || !(armed || !P.firstOnly)) continue;   // the BOS candle itself may be the spike
      var K = -Infinity, kLow = Infinity;
      for (j = i - P.knotBars; j < i; j++) { if (bars[j].h > K) K = bars[j].h; if (bars[j].l < kLow) kLow = bars[j].l; }
      if (!(bar.c > K)) continue;
      var a = atr[i - 1], body = bar.c - bar.o, sumB = 0;
      if (P.useKnot && !((K - kLow) <= P.knotMaxATR * a)) continue; // not a break of a tight knot: ignore, do not consume
      if (P.firstOnly) armed = false;
      for (j = i - P.bodyAvgLen; j < i; j++) sumB += Math.abs(bars[j].c - bars[j].o);
      ok = body > 0 && a > 0 &&
        body >= P.bodyVsAvg * (sumB / P.bodyAvgLen) &&
        body >= P.bodyMinATR * a &&
        (bar.h - bar.c) <= P.wickRatio * body &&
        (bar.o - bar.l) <= P.wickRatio * body;
      if (ok) {
        var base = P.stopMode === 'swing' ? swingLowBefore(bars, i, P.stopSwing, P.stopLookback) : null;
        active = { dir: 1, spikeIdx: i, spikeTime: bar.t, knotHigh: K, knotLow: kLow, atr: a, bosIdx: armBar, state: 'waitC1',
          baseIdx: base ? base.idx : null, baseLow: base ? base.price : kLow };
        setups.push(active);
      }
    }
    var last = n - 1;
    setups.forEach(function (s) {
      if (s.state === 'open') {
        var c = bars[last].c;
        s.unrealR1 = (c - s.entry) / s.risk;
        s.unrealR2 = s.t2 && s.t2.state === 'filled' ? (c - s.t2.price) / s.risk : 0;
        s.unrealR = s.unrealR1 + s.unrealR2;
      }
    });
    return { setups: setups, events: events, trend: trend, confirmed: confirmed, atr: atr };
  }

  var PRICE_FIELDS = ['knotHigh', 'knotLow', 'baseLow', 'level', 'entry', 'stop', 'target', 'e2', 'cancelLvl', 'exit'];
  function flipSetup(s) {
    PRICE_FIELDS.forEach(function (f) { if (typeof s[f] === 'number') s[f] = -s[f]; });
    if (s.t2 && typeof s.t2.price === 'number') s.t2.price = -s.t2.price;
    // knotHigh/knotLow swap meaning after inversion
    var kh = s.knotHigh; s.knotHigh = s.knotLow; s.knotLow = kh;
    s.dir = -1;
    return s;
  }

  function run(bars, params, opts) {
    var P = merge(params), forming = !!(opts && opts.forming);
    var A = runPass(bars, P, forming);
    var B = runPass(invertBars(bars), P, forming);
    var sells = B.setups.map(flipSetup);
    var all = A.setups.concat(sells).sort(function (x, y) { return x.spikeIdx - y.spikeIdx || x.dir - y.dir; });
    all.forEach(function (s, k) { s.id = k + 1; });
    return { setups: all, events: A.events, trend: A.trend, confirmed: A.confirmed, params: P, stats: stats(all) };
  }

  function stats(setups) {
    var closed = setups.filter(function (s) { return s.state === 'closed'; })
      .sort(function (a, b) { return a.exitTime - b.exitTime; });
    var wins = 0, loss = 0, sumPos = 0, sumNeg = 0, eq = 0, peak = 0, dd = 0, secondUsed = 0;
    closed.forEach(function (s) {
      if (s.totalR > 0) { wins++; sumPos += s.totalR; } else { loss++; sumNeg += s.totalR; }
      eq += s.totalR; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq;
      if (s.t2 && s.t2.state === 'filled') secondUsed++;
    });
    var cnt = function (st) { return setups.filter(function (s) { return s.state === st; }).length; };
    return {
      total: setups.length, closed: closed.length, wins: wins, losses: loss,
      winRate: closed.length ? wins / closed.length : 0,
      totalR: eq, avgR: closed.length ? eq / closed.length : 0,
      profitFactor: sumNeg < 0 ? sumPos / -sumNeg : (sumPos > 0 ? Infinity : 0),
      maxDD: dd, secondUsed: secondUsed,
      open: cnt('open'), pending: cnt('pending') + cnt('waitC1'), expired: cnt('expired'), skipped: cnt('skipped')
    };
  }

  var api = { DEFAULTS: DEFAULTS, run: run, stats: stats, calcATR: calcATR, invertBars: invertBars, merge: merge,
    _t: { fillEntry: fillEntry, stepOpen: stepOpen, manage: manage, swingLowBefore: swingLowBefore } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SetupEngine = api;
})(typeof window !== 'undefined' ? window : this);
