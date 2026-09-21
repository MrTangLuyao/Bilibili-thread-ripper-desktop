"use strict";
// The download optimizations: resuming a broken piece from its received bytes, spreading
// pieces over nodes by measured speed, and growing sub-chunks with the measured speed.
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const SOURCE=fs.existsSync(path.join(__dirname,"../shared/range-core.js"))?path.join(__dirname,"../shared"):path.join(__dirname,"../src");
function load(){
  const context=vm.createContext({URL,AbortController,DOMException,Response,ReadableStream,Headers,Uint8Array,Promise,setTimeout,clearTimeout,performance,console});
  context.globalThis=context;
  context.__now=1e12;
  vm.runInContext("Date.now=()=>globalThis.__now;",context);
  for(const file of ["range-core.js","cdn-resolver.js","idm-downloader.js"])vm.runInContext(fs.readFileSync(path.join(SOURCE,file),"utf8"),context,{filename:file});
  return {core:context.__BILI_RANGE_CORE__,cdn:context.__BILI_CDN_RESOLVER_FACTORY__,idm:context.__BILI_IDM_DOWNLOADER_FACTORY__,advance:ms=>{context.__now+=ms;}};
}
const mediaUrl=host=>`https://${host}/upgcxcode/00/00/1/1-1-30080.m4s?deadline=1&os=x`;
const pattern=(start,length)=>{const bytes=new Uint8Array(length);for(let i=0;i<length;i+=1)bytes[i]=(start+i)%251;return bytes;};
const rangeOf=init=>{const [,start,end]=/bytes=(\d+)-(\d+)/.exec(init.headers.Range).map(Number);return {start,end,length:end-start+1};};
const ok=(start,end,total)=>new Response(pattern(start,end-start+1),{status:206,headers:{"Content-Range":`bytes ${start}-${end}/${total}`}});

test("a broken transfer is resumed from its received bytes instead of downloaded again",{timeout:30000},async()=>{
  const {idm}=load();
  const BREAKS="upos-sz-mirrorali.bilivideo.com",RESCUES="upos-sz-mirrorhw.bilivideo.com";
  const TOTAL=8388608;
  const requests=[];
  const nativeFetch=async(url,init)=>{
    const host=new URL(url).hostname;
    const {start,end}=rangeOf(init);
    requests.push({host,start,end});
    if(host===BREAKS){
      // Sends the first 96 KiB, then the connection breaks.
      let sent=0;
      const body=new ReadableStream({pull(controller){
        if(sent>=96*1024){controller.error(new Error("连接中断"));return;}
        controller.enqueue(pattern(start+sent,32*1024));
        sent+=32*1024;
      }});
      return new Response(body,{status:206,headers:{"Content-Range":`bytes ${start}-${end}/${TOTAL}`}});
    }
    return ok(start,end,TOTAL);
  };
  const only=[mediaUrl(BREAKS),mediaUrl(RESCUES)];
  const resolver={urls:()=>only,ordered:()=>only,rescueCandidates:()=>only.slice(1),rangeCandidates:()=>only,allows:()=>true,success(){},failure(){},speed:()=>0};
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:4}),nativeFetch});
  // One piece only: the whole range is one 512 KiB sub-chunk.
  const range={start:1000,end:1000+512*1024-1,length:512*1024};
  const result=await downloader.downloadRange(range,resolver,{parallel:true,kind:"video",maxConcurrency:1});
  assert.equal(result.bytes.length,range.length);
  assert.ok(result.bytes.every((value,i)=>value===(range.start+i)%251),"spliced bytes are positioned correctly");
  const rescue=requests.filter(item=>item.host===RESCUES);
  assert.equal(rescue.length,1);
  assert.equal(rescue[0].start,range.start+96*1024,"the rescue request asked only for the missing tail");
  assert.equal(rescue[0].end,range.end);
});

test("pieces are spread over nodes by measured speed",{timeout:30000},async()=>{
  const {cdn,idm}=load();
  const FAST="upos-sz-mirrorali.bilivideo.com",SLOW="upos-sz-mirrorhw.bilivideo.com";
  const counts=new Map();
  const nativeFetch=async(url,init)=>{
    const host=new URL(url).hostname;
    counts.set(host,(counts.get(host)||0)+1);
    const {start,end}=rangeOf(init);
    return ok(start,end,67108864);
  };
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:32,mode:"custom",customHosts:[FAST,SLOW]}),nativeFetch});
  const resolver=cdn.createResolver({baseUrl:mediaUrl(FAST)},()=> "custom",null,()=>[FAST,SLOW]);
  // Health as if the fast node had been measured nine times faster.
  resolver.success(mediaUrl(FAST),9*1024*1024);
  resolver.success(mediaUrl(SLOW),1*1024*1024);
  const range={start:0,end:2*1024*1024-1,length:2*1024*1024};
  const result=await downloader.downloadRange(range,resolver,{parallel:true,kind:"video"});
  assert.equal(result.bytes.length,range.length);
  assert.ok((counts.get(FAST)||0)>=(counts.get(SLOW)||0)*2,
    `the fast node carries most pieces: fast ${counts.get(FAST)} vs slow ${counts.get(SLOW)}`);
  assert.ok((counts.get(SLOW)||0)>=1,"the slow node keeps a floor share");
});

test("sub-chunks grow with the measured connection speed, but a range keeps at least four pieces",{timeout:30000},async()=>{
  const {idm}=load();
  const HOST="upos-sz-mirrorali.bilivideo.com";
  let requests=[];
  const nativeFetch=async(url,init)=>{
    const {start,end}=rangeOf(init);
    requests.push(end-start+1);
    return ok(start,end,67108864);
  };
  const only=[mediaUrl(HOST)];
  const resolver={urls:()=>only,ordered:()=>only,rescueCandidates:()=>only,rangeCandidates:()=>only,allows:()=>true,success(){},failure(){},speed:()=>0};
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:32}),nativeFetch});
  // The first range is measured with 64 KiB chunks (instant responses look very fast here).
  const first={start:0,end:2*1024*1024-1,length:2*1024*1024};
  await downloader.downloadRange(first,resolver,{parallel:true,kind:"video"});
  const firstCounts=requests.length;
  assert.ok(firstCounts>=16,`the unmeasured range splits small: ${firstCounts} pieces`);
  requests=[];
  const second={start:4*1024*1024,end:6*1024*1024-1,length:2*1024*1024};
  await downloader.downloadRange(second,resolver,{parallel:true,kind:"video"});
  assert.ok(requests.length<firstCounts,`the measured range uses larger pieces: ${requests.length} < ${firstCounts}`);
  assert.ok(requests.length>=4,`the spread over nodes keeps at least four pieces: ${requests.length}`);
  assert.ok(Math.max(...requests)<=1024*1024,"a sub-chunk never exceeds 1 MiB");
});

test("a resolver reports the measured speed of an address",()=>{
  const {cdn}=load();
  const resolver=cdn.createResolver({baseUrl:mediaUrl("upos-sz-mirrorali.bilivideo.com")},()=> "mainland");
  assert.equal(resolver.speed(mediaUrl("upos-sz-mirrorali.bilivideo.com")),0);
  resolver.success(mediaUrl("upos-sz-mirrorali.bilivideo.com"),5000000);
  assert.equal(resolver.speed(mediaUrl("upos-sz-mirrorali.bilivideo.com")),5000000);
});

test("the short tail of a resumed piece is not taken for the speed of the node that fetched it",{timeout:30000},async()=>{
  const {cdn,idm}=load();
  const BREAKS="upos-sz-mirrorali.bilivideo.com",RESCUES="upos-sz-mirrorhw.bilivideo.com";
  const TOTAL=8388608;
  const nativeFetch=async(url,init)=>{
    const host=new URL(url).hostname;
    const {start,end}=rangeOf(init);
    if(host!==BREAKS)return ok(start,end,TOTAL);
    // Sends all but the last 8 KiB, then the connection breaks.
    const stop=end-start+1-8*1024;
    let sent=0;
    const body=new ReadableStream({pull(controller){
      if(sent>=stop){controller.error(new Error("连接中断"));return;}
      const size=Math.min(32*1024,stop-sent);
      controller.enqueue(pattern(start+sent,size));
      sent+=size;
    }});
    return new Response(body,{status:206,headers:{"Content-Range":`bytes ${start}-${end}/${TOTAL}`}});
  };
  const only=[mediaUrl(BREAKS),mediaUrl(RESCUES)];
  const reported=[];
  const resolver={urls:()=>only,ordered:()=>only,rescueCandidates:()=>only.slice(1),rangeCandidates:()=>only,allows:()=>true,success(url,bps){reported.push({host:new URL(url).hostname,bps});},failure(){},speed:()=>0};
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:4}),nativeFetch});
  const range={start:1000,end:1000+256*1024-1,length:256*1024};
  const result=await downloader.downloadRange(range,resolver,{parallel:true,kind:"video",maxConcurrency:1});
  assert.ok(result.bytes.every((value,i)=>value===(range.start+i)%251),"spliced bytes are positioned correctly");
  assert.deepEqual(reported,[{host:RESCUES,bps:0}],"the node that fetched the 8 KiB tail is reported as working, without a speed");
});

test("pieces go to the nodes in turns, and ranges in flight together open on different nodes",{timeout:30000},async()=>{
  const {cdn,idm}=load();
  const HOSTS=["upos-sz-mirrorali.bilivideo.com","upos-sz-mirrorhw.bilivideo.com","upos-sz-mirrorbos.bilivideo.com","upos-sz-mirror08c.bilivideo.com"];
  const order=[];
  const nativeFetch=async(url,init)=>{
    const {start,end}=rangeOf(init);
    order.push({host:new URL(url).hostname,start});
    return ok(start,end,67108864);
  };
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:64}),nativeFetch});
  // Four nodes measured equally fast, and staying so.
  const all=HOSTS.map(mediaUrl);
  const resolver={urls:()=>all,ordered:()=>all,rescueCandidates:()=>all,rangeCandidates:()=>all,allows:()=>true,success(){},failure(){},speed:()=>4*1024*1024};
  const first=[];
  for(let index=0;index<3;index+=1){
    order.length=0;
    const start=index*1024*1024;
    await downloader.downloadRange({start,end:start+512*1024-1,length:512*1024},resolver,{parallel:true,kind:"video"});
    const pieces=order.slice().sort((a,b)=>a.start-b.start).map(item=>item.host);
    // Equal nodes: no node gets two pieces in a row, and each gets its share.
    assert.ok(pieces.every((host,i)=>i===0||host!==pieces[i-1]),`neighbouring pieces use different nodes: ${pieces.join(" ")}`);
    assert.equal(new Set(pieces.slice(0,HOSTS.length)).size,HOSTS.length,"the first pieces cover every node");
    first.push(pieces[0]);
  }
  assert.equal(new Set(first).size,3,`each range opens on another node: ${first.join(" ")}`);
});

test("a measurement goes stale, and the slow node gets another try through the exploration slot",()=>{
  const {cdn,advance}=load();
  const HOSTS=["upos-sz-mirrorali.bilivideo.com","upos-sz-mirrorhw.bilivideo.com","upos-sz-mirrorbos.bilivideo.com","upos-sz-mirror08c.bilivideo.com","upos-sz-mirrorbd.bilivideo.com","upos-sz-mirror14b.bilivideo.com","upos-sz-estgoss.bilivideo.com","upos-sz-mirrorcos.bilivideo.com"];
  const resolver=cdn.createResolver({baseUrl:mediaUrl(HOSTS[0])},()=> "mainland");
  const SLOW=mediaUrl(HOSTS[7]);
  HOSTS.forEach((host,index)=>resolver.success(mediaUrl(host),(8-index)*1024*1024));
  resolver.rangeCandidates(); // the warm-up range uses every node
  // The six fastest keep being used and measured; the slowest is outside them.
  const triedAt=[];
  for(let seconds=20;seconds<=160;seconds+=20){
    advance(20000);
    const picked=resolver.rangeCandidates();
    assert.equal(picked.length,6);
    if(picked.includes(SLOW))triedAt.push(seconds);
    for(const url of picked)resolver.success(url,resolver.speed(url)||1024*1024);
  }
  assert.ok(triedAt.length>=1,"the slow node is tried again");
  assert.ok(triedAt[0]>=90,`but not while its measurement is fresh: first tried after ${triedAt[0]} s`);
  assert.ok(triedAt.length<=2,`and one try measures it for another 90 seconds: tried at ${triedAt.join(", ")} s`);
  assert.ok(resolver.speed(SLOW)>0,"it has a fresh measurement again");
});

test("a fresh signature keeps the measured speed of a node, but not the failures of the old address",()=>{
  const {cdn}=load();
  const HOST="upos-sz-mirrorali.bilivideo.com";
  const representation={baseUrl:`https://${HOST}/upgcxcode/00/00/1/1-1-30080.m4s?deadline=1&upsig=old`};
  const resolver=cdn.createResolver(representation,()=> "mainland");
  const old=resolver.urls().find(url=>new URL(url).hostname===HOST);
  resolver.success(old,5000000);
  resolver.failure(old,new Error("HTTP 403"),0);
  representation.baseUrl=`https://${HOST}/upgcxcode/00/00/1/1-1-30080.m4s?deadline=2&upsig=new`;
  const fresh=resolver.urls().find(url=>new URL(url).hostname===HOST);
  assert.notEqual(fresh,old);
  assert.equal(resolver.speed(fresh),5000000,"the node's speed is known at once");
  assert.ok(resolver.rangeCandidates().includes(fresh),"the new address is not backing off for the old one's failure");
});

test("short transfers do not keep an old speed measurement alive",()=>{
  const {cdn,advance}=load();
  const URL_A=mediaUrl("upos-sz-mirrorali.bilivideo.com");
  const resolver=cdn.createResolver({baseUrl:URL_A},()=> "mainland");
  resolver.success(URL_A,5000000);
  for(let seconds=0;seconds<100;seconds+=20){advance(20000);resolver.success(URL_A,0);}
  assert.equal(resolver.speed(URL_A),0,"after 90 seconds without a real measurement the speed counts as unknown");
  assert.equal(resolver.status().find(item=>item.host==="upos-sz-mirrorali.bilivideo.com").state,"healthy","the node itself is known to work");
  resolver.success(URL_A,3000000);
  assert.ok(resolver.speed(URL_A)>0,"a real measurement brings it back");
});

test("small segments still give an unmeasured node a piece now and then",{timeout:30000},async()=>{
  const {idm}=load();
  const KNOWN="upos-sz-mirrorali.bilivideo.com",STALE="upos-sz-mirrorhw.bilivideo.com";
  const counts=new Map();
  const nativeFetch=async(url,init)=>{
    const host=new URL(url).hostname;
    counts.set(host,(counts.get(host)||0)+1);
    const {start,end}=rangeOf(init);
    return ok(start,end,67108864);
  };
  const all=[mediaUrl(KNOWN),mediaUrl(STALE)];
  // One node is measured, the other's measurement has gone stale; 128 KiB ranges are two pieces.
  const resolver={urls:()=>all,ordered:()=>all,rescueCandidates:()=>all,rangeCandidates:()=>all,allows:()=>true,success(){},failure(){},speed:url=>url===all[0]?4*1024*1024:0};
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:8}),nativeFetch});
  for(let index=0;index<12;index+=1){
    const start=index*1024*1024;
    await downloader.downloadRange({start,end:start+128*1024-1,length:128*1024},resolver,{parallel:true,kind:"audio"});
  }
  assert.ok((counts.get(STALE)||0)>=2,`the unmeasured node was tried: ${counts.get(STALE)||0} requests`);
  assert.ok((counts.get(STALE)||0)<=4,`but only now and then: ${counts.get(STALE)||0} of ${(counts.get(KNOWN)||0)+(counts.get(STALE)||0)} requests`);
});

test("a copy that lost the race still measures its node",{timeout:30000},async()=>{
  const {idm}=load();
  const SLOW="upos-sz-mirrorali.bilivideo.com",FAST="upos-sz-mirrorhw.bilivideo.com";
  const TOTAL=8388608;
  const nativeFetch=async(url,init)=>{
    const host=new URL(url).hostname;
    const {start,end}=rangeOf(init);
    if(host!==SLOW)return ok(start,end,TOTAL);
    // 32 KiB every 40 ms: far too slow to finish before the second copy does.
    let sent=0;
    const body=new ReadableStream({async pull(controller){
      await new Promise(resolve=>setTimeout(resolve,40));
      if(init.signal.aborted){controller.error(new DOMException("aborted","AbortError"));return;}
      controller.enqueue(pattern(start+sent,32*1024));
      sent+=32*1024;
    }});
    return new Response(body,{status:206,headers:{"Content-Range":`bytes ${start}-${end}/${TOTAL}`}});
  };
  const only=[mediaUrl(SLOW),mediaUrl(FAST)];
  const reported=[];
  const succeeded=[];
  const resolver={urls:()=>only,ordered:()=>only,rescueCandidates:()=>only.slice(1),rangeCandidates:()=>only,allows:()=>true,success(url){succeeded.push(new URL(url).hostname);},sample(url,bps){reported.push({host:new URL(url).hostname,bps});},failure(){},speed:()=>0};
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:4}),nativeFetch});
  const range={start:0,end:2*1024*1024-1,length:2*1024*1024};
  const result=await downloader.downloadRange(range,resolver,{parallel:true,kind:"video",maxConcurrency:1});
  assert.ok(result.bytes.every((value,i)=>value===i%251),"the bytes are right whichever copy delivered them");
  const slow=reported.filter(item=>item.host===SLOW);
  assert.equal(slow.length,1,"the slow node is measured although its copy was cut off");
  assert.ok(slow[0].bps>0&&slow[0].bps<2*1024*1024,`with the speed it really had: ${Math.round(slow[0].bps/1024)} KiB/s`);
  assert.ok(!succeeded.includes(SLOW),"a cut-off transfer is a speed sample, not a success");
});

test("a speed sample measures a node without forgiving its failures",()=>{
  const {cdn}=load();
  const URL_A=mediaUrl("upos-sz-mirrorali.bilivideo.com");
  const resolver=cdn.createResolver({baseUrl:URL_A},()=> "mainland");
  resolver.failure(URL_A,new Error("CDN 子块停止传输"),4096);
  assert.ok(!resolver.rangeCandidates().includes(URL_A),"the address backs off after the failure");
  resolver.sample(URL_A,300000);
  assert.equal(resolver.speed(URL_A),300000,"the sample is its measured speed");
  assert.ok(!resolver.rangeCandidates().includes(URL_A),"and it is still backing off");
  assert.equal(resolver.status().find(item=>item.host==="upos-sz-mirrorali.bilivideo.com").state,"blocked");
});

test("the video and the audio track each get their trials, however they take turns",{timeout:30000},async()=>{
  const {idm}=load();
  const KNOWN="upos-sz-mirrorali.bilivideo.com",STALE="upos-sz-mirrorhw.bilivideo.com";
  const counts={video:0,audio:0};
  const nativeFetch=async(url,init)=>{
    const {start,end}=rangeOf(init);
    if(new URL(url).hostname===STALE)counts[url.includes("30280")?"audio":"video"]+=1;
    return ok(start,end,67108864);
  };
  const track=file=>{
    const all=[KNOWN,STALE].map(host=>`https://${host}/upgcxcode/00/00/1/${file}.m4s?deadline=1&os=x`);
    return {urls:()=>all,ordered:()=>all,rescueCandidates:()=>all,rangeCandidates:()=>all,allows:()=>true,success(){},failure(){},speed:url=>url===all[0]?4*1024*1024:0};
  };
  const video=track("1-1-30080"),audio=track("1-1-30280");
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:8}),nativeFetch});
  for(let index=0;index<12;index+=1){
    const start=index*1024*1024;
    await downloader.downloadRange({start,end:start+128*1024-1,length:128*1024},video,{parallel:true,kind:"video"});
    await downloader.downloadRange({start,end:start+128*1024-1,length:128*1024},audio,{parallel:true,kind:"audio"});
  }
  assert.ok(counts.video>=2&&counts.audio>=2,`both tracks tried their unmeasured node: video ${counts.video}, audio ${counts.audio}`);
});
