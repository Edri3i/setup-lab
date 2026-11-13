const E = require('./engine.js');
let fails = 0;
const eq = (name, a, b, tol = 1e-9) => {
  const ok = typeof a === 'number' ? Math.abs(a - b) < tol : a === b;
  if (!ok) { fails++; console.log('FAIL', name, 'got', a, 'expected', b); } else console.log('ok  ', name);
};
const P = E.merge({});
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
