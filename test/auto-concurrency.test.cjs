"use strict";
// 自动线程数: the controller in idm-downloader.js that moves the thread count between 8 and
// 32. Runs against a fake clock; nothing is downloaded.
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const SOURCE=fs.existsSync(path.join(__dirname,"../shared/range-core.js"))?path.join(__dirname,"../shared"):path.join(__dirname,"../src");
function load(){
  const context=vm.createContext({URL,AbortController,DOMException,Response,ReadableStream,Headers,Uint8Array,Promise,setTimeout,clearTimeout,performance,console,Map,Set,WeakRef,Object,Number,Math,Array,Error,JSON,String});
  context.globalThis=context;
  for(const file of ["range-core.js","cdn-resolver.js","idm-downloader.js"])vm.runInContext(fs.readFileSync(path.join(SOURCE,file),"utf8"),context,{filename:file});
  return {core:context.__BILI_RANGE_CORE__,idm:context.__BILI_IDM_DOWNLOADER_FACTORY__};
}
function controller(){
  const {idm}=load();
  const clock={at:100000};
  const auto=idm.createAutoConcurrency({now:()=>clock.at});
  const changes=[];
  auto.subscribe(change=>changes.push(change));
  // Steady delivery at a given rate with every slot busy, for a while.
  const flow=(bps,ms)=>{auto.demand(8,8,3);for(let t=0;t<ms;t+=250){clock.at+=250;auto.activity();auto.delivered(bps/4);}};
  return {auto,clock,changes,flow};
}

test("the setting is off unless asked for, and the ladder runs from 8 to 32",()=>{
  const {core,idm}=load();
  assert.equal(core.normalizeSettings({}).autoConcurrency,false);
  assert.equal(core.normalizeSettings({autoConcurrency:true}).autoConcurrency,true);
  assert.deepEqual([...idm.autoConcurrency.ladder],[8,12,16,24,32]);
  assert.equal(idm.autoConcurrency.threads(),8);
});

test("a stall steps the count up at once, never two steps within the cooldown, never past 32",()=>{
  const {auto,clock,changes}=controller();
  clock.at+=5000;
  assert.equal(auto.stall(),true);assert.equal(auto.threads(),12);
  assert.equal(auto.stall(),false,"a second stall right after is the same stall");
  clock.at+=3000;assert.equal(auto.stall(),true);assert.equal(auto.threads(),16);
  clock.at+=3000;auto.stall();clock.at+=3000;auto.stall();
  assert.equal(auto.threads(),32);
  clock.at+=3000;assert.equal(auto.stall(),false);assert.equal(auto.threads(),32);
  assert.deepEqual(changes.map(c=>c.threads),[12,16,24,32]);
  assert.equal(changes[0].previous,8);assert.equal(changes[0].reason,"播放卡了一下");
});

test("a step that brought no more bytes per second goes back to where it started, and that level rests",()=>{
  const {auto,clock,changes,flow}=controller();
  clock.at+=5000;
  flow(1e6,5000);                       // 1 MB/s at 8 threads
  auto.stall();assert.equal(auto.threads(),12);
  flow(0.95e6,11000);                   // no more at 12 threads: nothing gained
  assert.equal(auto.threads(),8);
  assert.match(changes.at(-1).reason,/12 线程没有比 8 线程更快/);
  assert.equal(JSON.stringify(auto.status().resting.map(r=>[r.threads,r.hard])),"[[12,false]]");
  clock.at+=3000;auto.stall();
  assert.equal(auto.threads(),16,"12 rests after a fruitless trial; a stall may skip it");
  flow(0.9e6,11000);                    // 16 brought nothing either
  assert.equal(auto.threads(),8,"back to the level the trial started from, not to the resting 12");
  assert.match(changes.at(-1).reason,/16 线程没有比 8 线程更快/);
  clock.at+=3000;auto.stall();
  assert.equal(auto.threads(),24);
  flow(1.5e6,11000);                    // 24 threads deliver 50 % more: kept
  assert.equal(auto.threads(),24);
});

test("a trial is not judged without steady demand or after another stall",()=>{
  const {auto,clock,flow}=controller();
  clock.at+=5000;flow(1e6,5000);
  auto.stall();assert.equal(auto.threads(),12);
  // The buffer filled up: the connections idle, delivery thins out. No verdict.
  auto.demand(2,12,0);
  for(let t=0;t<11000;t+=250){clock.at+=250;auto.activity();auto.delivered(1e6/8);}
  assert.equal(auto.threads(),12);
  const {auto:second,clock:clock2,flow:flow2}=controller();
  clock2.at+=5000;flow2(1e6,5000);
  second.stall();clock2.at+=3000;second.stall();   // a stall during the 12 trial voids it; 16 starts its own trial from 12
  flow2(0.9e6,11000);
  assert.equal(second.threads(),12,"16 brought nothing over 12; 12 itself was never judged");
  assert.equal(JSON.stringify(second.status().resting.map(r=>r.threads)),"[16]");
});

test("saturation is measured by time, and holds while a full queue sits still",()=>{
  const {auto,clock}=controller();
  auto.demand(8,8,4);clock.at+=6000;
  assert.equal(auto.status().saturation,1,"no new requests came, the slots are still all busy");
  auto.demand(3,8,0);clock.at+=2500;
  assert.equal(auto.status().saturation,0.5);
});

test("a low buffer that has not grown over a second while bytes arrive is pressure; a growing or full one is not",()=>{
  const {auto,clock}=controller();
  clock.at+=5000;
  const run=(aheads,playing=true)=>{let stepped=false;for(const ahead of aheads){clock.at+=250;auto.activity();if(auto.buffer(ahead,playing))stepped=true;}return stepped;};
  assert.equal(run([4,4.2,4.4,4.6,4.8,5,5.2,5.4,5.6,5.8]),false,"growing 0.2 s per tick is the download outpacing playback");
  assert.equal(auto.threads(),8);
  assert.equal(run([4,3.9,3.8,3.7,3.6,3.5,3.4,3.3,3.2,3.1]),true,"a second of no growth under 6 s, then a second more");
  assert.equal(auto.threads(),12);
  clock.at+=3000;
  assert.equal(run([20,19,18,17,16,15,14,13,12,11]),false,"20 seconds ahead is comfortable");
  assert.equal(run([4,4,4,4,4,4,4,4,4,4],false),false,"paused counts for nothing");
  auto.newSession();
  assert.equal(run([4,4,4,4]),false,"a new session starts the watch afresh: under a second of samples, no verdict");
  assert.equal(run([4,4,4,4,4]),true,"a second of no growth on top of a second of samples");
  assert.equal(auto.threads(),16);
});

test("a server refusing the load steps the count back, and nothing climbs past that level for three minutes",()=>{
  const {auto,clock,changes}=controller();
  clock.at+=5000;auto.stall();clock.at+=3000;auto.stall();
  assert.equal(auto.threads(),16);
  assert.equal(auto.pushback(412),true);assert.equal(auto.threads(),12);
  assert.equal(changes.at(-1).reason,"服务器返回 412");
  clock.at+=3000;
  assert.equal(auto.stall(),false,"16 was refused: a stall does not jump over it to 24");
  assert.equal(auto.threads(),12);
  clock.at+=180001;
  assert.equal(auto.stall(),true);assert.equal(auto.threads(),16,"after the rest the climb resumes");
  auto.pushback(429);auto.pushback(429);
  assert.equal(auto.threads(),8);
  assert.equal(auto.pushback(412),false,"8 is the floor");
  clock.at+=3000;
  assert.equal(auto.stall(),false,"refused at the floor: no climb for the rest either");
  clock.at+=180001;
  assert.equal(auto.stall(),true);
});

test("a new session drops the old trial and its measurements, keeps the level and the rests",()=>{
  const {auto,clock,flow}=controller();
  clock.at+=5000;flow(1e6,5000);
  auto.stall();assert.equal(auto.threads(),12);
  auto.newSession();                    // the viewer switched videos: 0.5 MB/s is the new video's rate, not a lost trial
  flow(0.5e6,11000);
  assert.equal(auto.threads(),12);
  assert.equal(auto.status().trial,null);
  auto.pushback(412);auto.newSession();
  assert.equal(JSON.stringify(auto.status().resting.map(r=>[r.threads,r.hard])),"[[12,true]]","rests survive a new session");
});

test("delivery samples are bounded to the window",()=>{
  const {auto,clock}=controller();
  for(let t=0;t<3600000;t+=250){clock.at+=250;auto.delivered(1000);}
  assert.ok(auto.status().buckets<=22,`buckets kept: ${auto.status().buckets}`);
});

test("every downloader on the page follows the controller's count at once, in the automatic mode only",()=>{
  const {idm}=load();
  const manual=idm.createDownloader({getSettings:()=>({concurrency:32}),nativeFetch:()=>Promise.reject(new Error("no network"))});
  const auto=idm.createDownloader({getSettings:()=>({concurrency:32,autoConcurrency:true}),nativeFetch:()=>Promise.reject(new Error("no network"))});
  assert.equal(manual.getConcurrency(),32);
  assert.equal(auto.getConcurrency(),8);
  // The page-level controller runs on the real clock and keeps 2.5 s between steps: stall
  // until it takes one, however long this process has been running.
  const ctl=idm.autoConcurrency;
  let stepped=false;
  const waitUntil=Date.now()+3000;
  while(!stepped&&Date.now()<waitUntil)stepped=ctl.stall();
  assert.equal(stepped,true);
  assert.equal(ctl.threads(),12);
  assert.equal(auto.getConcurrency(),12,"the semaphore limit follows without a new download");
  assert.equal(manual.getConcurrency(),32);
});
