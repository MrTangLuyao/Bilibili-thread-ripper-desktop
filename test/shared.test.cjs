"use strict";
// Shared download core. The browser project keeps an identical copy as dev/shared-core-test.js.
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const SOURCE=fs.existsSync(path.join(__dirname,"../shared/range-core.js"))?path.join(__dirname,"../shared"):path.join(__dirname,"../src");
function load(){
  const context=vm.createContext({URL,AbortController,DOMException,Response,ReadableStream,Headers,Uint8Array,Promise,setTimeout,clearTimeout,performance,console});
  context.globalThis=context;
  // The resolver's short failure back-off uses Date.now. Tests move this clock forward.
  context.__now=1e12;
  vm.runInContext("Date.now=()=>globalThis.__now;",context);
  for(const file of ["range-core.js","cdn-resolver.js","idm-downloader.js"])vm.runInContext(fs.readFileSync(path.join(SOURCE,file),"utf8"),context,{filename:file});
  return {core:context.__BILI_RANGE_CORE__,cdn:context.__BILI_CDN_RESOLVER_FACTORY__,idm:context.__BILI_IDM_DOWNLOADER_FACTORY__,advance:ms=>{context.__now+=ms;}};
}
const mediaUrl=host=>`https://${host}/upgcxcode/00/00/1/1-1-30080.m4s?deadline=1&os=x`;
const dead=Object.assign(new Error("Range 校验失败：HTTP 503"),{name:"Error"});
const aborted=new DOMException("并发副本已取消","AbortError");

test("new defaults: mainland CDN, 8 threads, error notices off",()=>{
  const {core}=load();
  const defaults=core.normalizeSettings({});
  assert.equal(defaults.mode,"mainland");assert.equal(defaults.concurrency,8);assert.equal(defaults.errorNotices,false);assert.equal(defaults.debugNotices,false);
  const chosen=core.normalizeSettings({mode:"overseas",concurrency:32,errorNotices:true});
  assert.equal(chosen.mode,"overseas");assert.equal(chosen.concurrency,32);assert.equal(chosen.errorNotices,true);
  assert.equal(core.normalizeSettings({concurrency:7}).concurrency,8);
});

test("a node is banned after two failures that delivered 0 bytes, and only for the current video",()=>{
  const {cdn}=load();
  const banned=[];
  const bans=cdn.createBanList({onBan:host=>banned.push(host)});
  const hw=mediaUrl("upos-sz-mirrorhw.bilivideo.com");
  assert.equal(bans.record(hw,0,aborted),false,"a cancelled hedge copy is not a failure");
  assert.equal(bans.record(hw,4096,dead),false,"a transfer that sent data before stalling is not a dead node");
  assert.equal(bans.record(hw,0,dead),false);assert.equal(bans.allows(hw),true);
  // A different signed URL on the same node counts toward the same node.
  assert.equal(bans.record(hw.replace("30080","30280"),0,dead),true);
  assert.equal(bans.allows(hw),false);assert.deepEqual(Array.from(banned),["upos-sz-mirrorhw.bilivideo.com"]);
  assert.equal(bans.record(hw,0,dead),false,"a banned node is reported once");
  assert.deepEqual(Array.from(bans.hosts()),["upos-sz-mirrorhw.bilivideo.com"]);
  bans.reset();
  assert.equal(bans.allows(hw),true);assert.deepEqual(Array.from(bans.hosts()),[]);
  assert.equal(bans.record(hw,0,dead),false,"strikes start again for the next video");
});

test("resolvers skip banned nodes but never end up with no address",()=>{
  const {cdn}=load();
  const bans=cdn.createBanList();
  const resolver=cdn.createResolver({baseUrl:mediaUrl("upos-sz-mirrorali.bilivideo.com")},()=> "mainland",bans);
  const hostsOf=list=>Array.from(list,url=>new URL(url).hostname);
  assert.equal(resolver.urls().length,8);
  resolver.failure(mediaUrl("upos-sz-mirrorhw.bilivideo.com"),dead,0);
  assert.equal(resolver.urls().length,8,"one strike does not ban");
  resolver.failure(mediaUrl("upos-sz-mirrorhw.bilivideo.com"),dead,0);
  for(const list of [resolver.urls(),resolver.ordered(0),resolver.rangeCandidates(),resolver.rescueCandidates(),resolver.startupCandidates()]){
    assert.ok(!hostsOf(list).includes("upos-sz-mirrorhw.bilivideo.com"));assert.ok(list.length>0);
  }
  assert.equal(resolver.allows(mediaUrl("upos-sz-mirrorhw.bilivideo.com")),false);
  assert.equal(Array.from(resolver.status()).find(item=>item.host==="upos-sz-mirrorhw.bilivideo.com").state,"banned");
  // Another resolver of the same video (audio track, other quality) shares the list.
  const audio=cdn.createResolver({baseUrl:mediaUrl("upos-sz-mirrorbos.bilivideo.com")},()=> "mainland",bans);
  assert.ok(!hostsOf(audio.urls()).includes("upos-sz-mirrorhw.bilivideo.com"));
  for(const host of cdn.MAINLAND_HOSTS){bans.record(mediaUrl(host),0,dead);bans.record(mediaUrl(host),0,dead);}
  assert.equal(resolver.urls().length,8,"with every node banned the original list is used again");
  assert.ok(resolver.startupCandidates().length>0);
  // Without a ban list the resolver keeps its old behaviour.
  const plain=cdn.createResolver({baseUrl:mediaUrl("upos-sz-mirrorali.bilivideo.com")},()=> "mainland");
  plain.failure(mediaUrl("upos-sz-mirrorhw.bilivideo.com"),dead,0);plain.failure(mediaUrl("upos-sz-mirrorhw.bilivideo.com"),dead,0);
  assert.equal(plain.allows(mediaUrl("upos-sz-mirrorhw.bilivideo.com")),true);
});

test("the downloader reports received bytes, bans a silent node and stops using it",{timeout:60000},async()=>{
  const {cdn,idm,advance}=load();
  const DEAD="upos-sz-mirrorhw.bilivideo.com",PARTIAL="upos-sz-mirrorbos.bilivideo.com";
  const requests=new Map(),banned=[];
  const count=host=>requests.get(host)||0;
  const nativeFetch=async(url,init)=>{
    const host=new URL(url).hostname;requests.set(host,count(host)+1);
    const [,start,end]=/bytes=(\d+)-(\d+)/.exec(init.headers.Range).map(Number);
    const headers={"Content-Range":`bytes ${start}-${end}/8388608`};
    if(host===DEAD)return new Response("",{status:503});
    if(host===PARTIAL){
      // Sends a little data, then the connection breaks: slow, not dead.
      let sent=false;
      const body=new ReadableStream({pull(controller){if(sent)controller.error(new Error("连接中断"));else{sent=true;controller.enqueue(new Uint8Array(1024));}}});
      return new Response(body,{status:206,headers});
    }
    const bytes=new Uint8Array(end-start+1);for(let i=0;i<bytes.length;i++)bytes[i]=(start+i)%251;
    return new Response(bytes,{status:206,headers});
  };
  const transfers=[];
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:8}),nativeFetch,onTransfer:event=>{transfers.push(event);return transfers.length;}});
  const bans=cdn.createBanList({onBan:host=>banned.push(host)});
  const resolver=cdn.createResolver({baseUrl:mediaUrl("upos-sz-mirrorali.bilivideo.com")},()=> "mainland",bans);
  const range={start:0,end:1024*1024-1,length:1024*1024};
  const download=async()=>{const result=await downloader.downloadRange(range,resolver,{parallel:true,kind:"video"});assert.equal(result.bytes.length,range.length);assert.ok(result.bytes.every((value,i)=>value===i%251));};
  // Each round starts after the short back-off, as when a user keeps watching.
  for(let round=0;round<6&&!banned.length;round++){await download();advance(61000);}
  assert.deepEqual(Array.from(banned),[DEAD]);
  // Parallel pieces may already be waiting on the node when the second empty reply arrives.
  assert.ok(count(DEAD)>=2,"banned only after two empty replies");
  assert.ok(count(PARTIAL)>=2,"the partial node was tried");
  assert.equal(bans.allows(mediaUrl(PARTIAL)),true,"a node that sent data is not banned");
  const before=count(DEAD);
  for(let round=0;round<3;round++){await download();advance(61000);}
  assert.equal(count(DEAD),before,"a banned node gets no new requests in this video");
  assert.ok(transfers.some(event=>event.phase==="error"));
  bans.reset();
  assert.equal(resolver.allows(mediaUrl(DEAD)),true);
});
