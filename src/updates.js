(function(root) {
  "use strict";
  const api=root.__BTR_DESKTOP__, channel="__BTR_DESKTOP_UPDATE__", listeners=new Set();
  let state={state:"idle",message:"从 GitHub 检查 BTR 更新"}, pending=null, timer=null;
  const emit = next => {state=next;for(const fn of listeners)fn({...state});};
  api.getUpdate=()=>({...state});
  api.onUpdate=fn=>{listeners.add(fn);fn({...state});return()=>listeners.delete(fn);};
  api.checkUpdate=()=>{
    if(["confirming","installing","uninstalling"].includes(state.state))return Promise.resolve({...state});
    if(pending)return pending;
    emit({state:"checking",message:"正在检查 BTR 更新"});
    pending=new Promise(resolve=>{
      api._resolveUpdate=resolve;
      timer=setTimeout(()=>finish({state:"error",message:"更新检查超时，请稍后再试"}),12000);
      root.postMessage({channel,type:"check"},location.origin);
    });
    return pending;
  };
  function finish(result){clearTimeout(timer);const resolve=api._resolveUpdate;api._resolveUpdate=null;pending=null;emit(result);resolve?.(result);}
  root.addEventListener("message",event=>{
    if(event.source!==root || event.data?.channel!==channel)return;
    if(event.data.type==="auto-config") {
      if(typeof event.data.enabled==="boolean" && api.getSettings().autoCheckUpdates!==event.data.enabled)api.setSettings({autoCheckUpdates:event.data.enabled});
      return;
    }
    if(event.data.type!=="result")return;
    const value=event.data.result;
    if(!value || !["current","available","checking","confirming","installing","uninstalling","idle","error","not-configured"].includes(value.state))return;
    finish(value);
  });
  // The main process owns one timer for all windows, not a timer in every renderer.
  let configured=false, previousAuto;
  const unsubscribe=api.onSettings(settings=>{
    const enabled=settings.autoCheckUpdates!==false;
    if(configured && previousAuto===enabled)return;
    const changed=configured; configured=true; previousAuto=enabled;
    root.postMessage({channel,type:"configure-auto",enabled,changed},location.origin);
  });
  root.addEventListener("pagehide",()=>{unsubscribe();clearTimeout(timer);},{once:true});
})(globalThis);
