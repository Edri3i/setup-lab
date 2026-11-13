const E = require('./engine.js');
let fails = 0;
const eq = (name, a, b, tol = 1e-9) => {
  const ok = typeof a === 'number' ? Math.abs(a - b) < tol : a === b;
  if (!ok) { fails++; console.log('FAIL', name, 'got', a, 'expected', b); } else console.log('ok  ', name);
};
const P = E.merge({stopMode:'spike'});
function mk(){ // pending setup, spike bar0 low 98.5, C1 low 100
  const bars=[{t:0,o:99,h:101,l:98.5,c:100.8},{t:1,o:100.8,h:101.5,l:100,c:101}];
  const s={level:100,spikeIdx:0,atr:1,state:'pending',dir:1};
  return {bars,s};
}
function enter(entryBar){ const {bars,s}=mk(); bars.push(entryBar); E._t.fillEntry(s,entryBar,2,bars,P); return s; }
let s;
// levels: S=98.4 R=1.6 T=101.6 e2=99.2 cancel=101.44
s=enter({t:2,o:101,h:101.2,l:99.9,c:100.5});
eq('entry E',s.entry,100); eq('stop',s.stop,98.4,1e-9); eq('target',s.target,101.6,1e-9); eq('e2',s.e2,99.2,1e-9); eq('risk',s.risk,1.6,1e-9);
eq('state open',s.state,'open');
E._t.stepOpen(s,{t:3,o:100.5,h:101.7,l:100.2,c:101.6},3);
eq('case1 outcome',s.outcome,'target'); eq('case1 total',s.totalR,1,1e-9);

s=enter({t:2,o:101,h:101.2,l:99.9,c:100.5});
E._t.stepOpen(s,{t:3,o:100,h:100.5,l:99.1,c:99.9},3); eq('case2 t2 filled',s.t2.state,'filled');
E._t.stepOpen(s,{t:4,o:99.9,h:101.7,l:99.5,c:101.6},4); eq('case2 total',s.totalR,2.5,1e-9);

s=enter({t:2,o:101,h:101.2,l:99.9,c:100.5});
E._t.stepOpen(s,{t:3,o:100,h:100.1,l:98.3,c:98.5},3); eq('case3 outcome',s.outcome,'stop'); eq('case3 total',s.totalR,-1.5,1e-9);

s=enter({t:2,o:101,h:101.2,l:99.9,c:100.5});
E._t.stepOpen(s,{t:3,o:100.2,h:101.5,l:100.1,c:101},3); eq('case4 canceled',s.t2.state,'canceled');
E._t.stepOpen(s,{t:4,o:100.5,h:100.6,l:98,c:98.1},4); eq('case4 total',s.totalR,-1,1e-9);

s=enter({t:2,o:101,h:101.2,l:99.9,c:100.5});
E._t.stepOpen(s,{t:3,o:100,h:102,l:98,c:101},3); eq('case5 same bar -> stop',s.outcome,'stop'); eq('case5 total',s.totalR,-1.5,1e-9);

s=enter({t:2,o:100.3,h:100.5,l:98.2,c:98.9});
eq('case6 entry bar stop',s.outcome,'stop'); eq('case6 total',s.totalR,-1.5,1e-9);

s=enter({t:2,o:101,h:101.2,l:99.9,c:100.5});
E._t.stepOpen(s,{t:3,o:98,h:98.5,l:97.5,c:98},3); eq('case7 gap exit',s.exit,98); eq('case7 r1',s.r1,-1.25,1e-9); eq('case7 r2',s.r2,0);

s=enter({t:2,o:99.8,h:100.5,l:99.5,c:100});  // gap open below level -> filled at open 99.8
eq('case8 fill at open',s.entry,99.8); eq('case8 stop kept',s.stop,98.4,1e-9);


// ---------- stop behind the last swing low before the spike ----------
const lowsToBars = (lows)=>lows.map((l,i)=>({t:i,o:l+1,h:l+2,l,c:l+1}));
let r = E._t.swingLowBefore(lowsToBars([10,9,8,7,6,5,6,7,6.5,7.5]), 9, 3, 60);
eq('swing low: base of the leg idx', r && r.idx, 5); eq('swing low: base price', r && r.price, 5);
r = E._t.swingLowBefore(lowsToBars([10,10,10,10,10,9,8,7,9]), 8, 3, 60);
eq('swing low: trough right before spike idx', r && r.idx, 7);
// full flow on a hand-made series, buy side
{
  const B=[]; let t=0; const add=(o,h,l,c)=>B.push({t:t++,o,h,l,c});
  const ramp=(from,to,n)=>{ for(let i=0;i<n;i++){ const o=from+(to-from)*i/n, c=from+(to-from)*(i+1)/n; add(o,Math.max(o,c)+0.15,Math.min(o,c)-0.15,c);} };
  for(let i=0;i<30;i++) add(100,100.6,99.4,100.2-(i%2)*0.4);   // quiet noise
  ramp(100,95,5); ramp(95,101.5,7);                            // dip, then first break up (CHoCH)
  ramp(101.5,99.5,4); ramp(99.5,103,6);                        // pullback, new high 103
  ramp(103,101.5,4); ramp(101.5,104.5,5);                      // pullback, break of 103 (BOS)
  for(let i=0;i<8;i++) add(104.3,104.7,104.0,104.4+(i%2)*0.1); // knot
  add(104.4,108.6,104.3,108.5);                                // spike: big body, tiny wicks
  add(108.5,109.5,107.4,109);                                  // C1, low 107.4
  add(109,109.2,107.3,108);                                    // back to C1 low -> entry
  add(108,108.5,107.5,108.2); add(108.2,111,108,110.9);
  const res=E.run(B,{swing:3,knotBars:6,atrLen:5,bodyAvgLen:5,maxRiskATR:0});
  const b=res.setups.filter(x=>x.dir===1);
  console.log('hand-made flow:', b.map(x=>({spike:x.spikeIdx,base:x.baseIdx,baseLow:+x.baseLow.toFixed(2),entry:x.entry,stop:+(x.stop||0).toFixed(3),target:+(x.target||0).toFixed(3),state:x.state,total:x.totalR})));
  eq('hand-made: a buy setup is found', b.length>=1, true);
  if(b.length){ const x=b[0];
    eq('hand-made: base found and before spike', x.baseIdx!==null && x.baseIdx<x.spikeIdx, true);
    eq('hand-made: stop = base low - 0.1 ATR', x.stop, x.baseLow-0.1*x.atr, 1e-9);
    eq('hand-made: entry = low of candle after spike', x.entry, 107.4, 1e-9);
    eq('hand-made: 1:1 target', x.target-x.entry, x.entry-x.stop, 1e-9); }
}


// ---------- waiting window: 3 candles after the first candle ----------
{
  const PP=E.merge({stopMode:'spike'});
  const miss={o:102,h:103,l:101,c:102.5}, hit={o:102,h:102.2,l:99.9,c:100.5};
  const mkS=()=>({level:100,spikeIdx:0,atr:1,state:'pending',dir:1,wait:0,baseLow:98});
  const run=(seq)=>{ const bars=[{t:0,o:99,h:101,l:98.5,c:100.8},{t:1,o:100.8,h:101.5,l:100,c:101}]; const s=mkS();
    seq.forEach((b,k)=>{ if(s.state!=='pending')return; const bar=Object.assign({t:2+k},b); bars.push(bar); E._t.manage(s,bar,2+k,true,bars,PP); }); return s.state; };
  eq('wait: hit on 3rd waiting candle -> entry', run([miss,miss,hit]), 'open');
  eq('wait: no hit in 3 candles -> expired', run([miss,miss,miss]), 'expired');
  eq('wait: hit only on 4th candle is too late', run([miss,miss,miss,hit]), 'expired');
}


// ---------- integration ----------
function rng(seed){ return () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296; }
function gen(n, seed, start=2000){
  const r=rng(seed), bars=[]; let p=start, drift=0, t=0;
  for(let i=0;i<n;i++){
    if(i%120===0) drift=(r()-0.5)*0.9;
    const vol = 0.5 + r()*0.5; const spike = r()<0.04;
    let o=p, mv=(drift+(r()-0.5)*2)*vol*(spike?3.5:1);
    let c=o+mv; let h=Math.max(o,c)+r()*vol*(spike?0.1:0.6); let l=Math.min(o,c)-r()*vol*(spike?0.1:0.6);
    bars.push({t:t,o,h,l,c}); p=c; t+=60000;
  }
  return bars;
}
let tot=0, bad=0;
for (const seed of [1,2,3,4,5,6,7,8]) {
  const bars=gen(6000,seed);
  const res=E.run(bars,{});
  tot+=res.setups.length;
  for(const s of res.setups){
    const sign=s.dir;
    if(s.state==='open'||s.state==='closed'){
      const okOrder = sign===1 ? (s.stop<s.entry && s.entry<s.target && s.e2<s.entry && s.e2>s.stop) : (s.stop>s.entry && s.entry>s.target && s.e2>s.entry && s.e2<s.stop);
      if(!okOrder){bad++; console.log('bad order',seed,s);}
      if(Math.abs(Math.abs(s.target-s.entry)-Math.abs(s.entry-s.stop))>1e-9){bad++; console.log('rr mismatch',seed,s.id);}
      if(s.state==='closed' && !(s.exitIdx>=s.entryIdx)){bad++; console.log('exit before entry',s.id);}
    }
  }
  // mirror symmetry
  const inv=E.run(E.invertBars(bars),{});
  const a=res.setups.filter(s=>s.dir===1), b=inv.setups.filter(s=>s.dir===-1);
  if(a.length!==b.length){bad++; console.log('mirror count mismatch',seed,a.length,b.length);}
  else a.forEach((x,k)=>{ const y=b[k]; if(x.spikeIdx!==y.spikeIdx||x.state!==y.state||Math.abs((x.totalR||0)-(y.totalR||0))>1e-9||(x.entry!==undefined&&Math.abs(x.entry+y.entry)>1e-9)){bad++;console.log('mirror diff',seed,k);} });
  const st=res.stats;
  console.log('seed',seed,'setups',res.setups.length,'closed',st.closed,'win%',(st.winRate*100).toFixed(0),'R',st.totalR.toFixed(2),'2nd',st.secondUsed,'exp',st.expired,'skip',st.skipped,'events',res.events.length);
}
eq('invariants violations',bad,0); 
console.log('total setups',tot); if(tot===0){fails++;console.log('FAIL no setups generated');}
// forming bar must never create setup on last bar
const b2=gen(800,3); const r1=E.run(b2,{},{forming:true}); const lastIdx=b2.length-1;
eq('no spike on forming bar', r1.setups.some(s=>s.spikeIdx===lastIdx), false);
console.log(fails? 'FAILED '+fails : 'ALL PASSED'); process.exit(fails?1:0);
