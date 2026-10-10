(() => {
  const counts={requests:0,inflight:0,peakInflight:0,failed:0,canvasAssignments:0,redundantCanvasAssignments:0,paints:0};
  const nativeFetch=window.fetch.bind(window);
  window.fetch=async(...args)=>{counts.requests++;counts.inflight++;counts.peakInflight=Math.max(counts.peakInflight,counts.inflight);try{return await nativeFetch(...args);}catch(error){if(error.name!=='AbortError')counts.failed++;throw error;}finally{counts.inflight--;}};
  for(const key of ['width','height']){const original=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,key);Object.defineProperty(HTMLCanvasElement.prototype,key,{...original,set(value){counts.canvasAssignments++;if(Number(value)===original.get.call(this))counts.redundantCanvasAssignments++;original.set.call(this,value);}});}
  const clear=CanvasRenderingContext2D.prototype.clearRect;CanvasRenderingContext2D.prototype.clearRect=function(...args){counts.paints++;return clear.apply(this,args);};
  const samples=[],wait=async(test,label,limit=15000)=>{const start=Date.now();while(!test()){if(Date.now()-start>limit)throw Error('等待超时：'+label);await new Promise(resolve=>setTimeout(resolve,25));}};
  let running=false,stopped=false,visited=0,failures=[],initialNodes=0,serverMetrics=null;
  const measure=phase=>{const heap=performance.memory?.usedJSHeapSize;const sample={phase,visited,requests:counts.requests,inflight:counts.inflight,domNodes:document.querySelectorAll('*').length,rows:document.querySelectorAll('.script-row').length,canvases:document.querySelectorAll('canvas').length,paints:counts.paints,canvasAssignments:counts.canvasAssignments,redundantCanvasAssignments:counts.redundantCanvasAssignments,heapBytes:typeof heap==='number'?heap:null};samples.push(sample);return sample;};
  const report=()=>({running,visited,failures,counts,samples,serverMetrics,heapMeasured:samples.some(sample=>sample.heapBytes!==null),heapNote:'Chrome performance.memory有值时仅记录观察值；未强制GC，不作为商用长期上限证明。'});
  const show=()=>{const output=document.getElementById('fixture-pressure-result');if(output)output.textContent=JSON.stringify(report());};
  window.addEventListener('error',event=>{failures.push(String(event.message));show();});
  window.addEventListener('unhandledrejection',event=>{failures.push(String(event.reason?.message||event.reason));show();});
  async function exercise(chapter){
    const item=[...document.querySelectorAll('.chapter-list .chapter-item')].find(button=>button.querySelector('.chapter-nav-label > span')?.textContent===chapter.title);if(!item)throw Error('缺少章节导航：'+chapter.title);item.click();
    await wait(()=>document.getElementById('segment-'+chapter.firstSegmentId),'章节实际行');
    await wait(()=>document.querySelector('.play-button')&&!document.querySelector('.play-button').disabled,'可播放');
    const button=()=>document.querySelector('.play-button'),audio=()=>document.querySelector('audio');button().click();
    await wait(()=>audio()&&!audio().paused&&audio().currentTime>.05,'第一次播放');button().click();
    await wait(()=>audio().paused&&!button().disabled,'暂停');const pausedAt=audio().currentTime;
    button().click();await wait(()=>!audio().paused&&audio().currentTime>=pausedAt-.08,'同源断点续播');
    button().click();await wait(()=>audio().paused,'第二次暂停');
    if(audio().currentTime<pausedAt-.08)throw Error('续播从头开始：'+chapter.title);
  }
  async function run(){
    if(running)return;running=true;stopped=false;visited=0;failures=[];samples.length=0;show();
    try{
      const fixture=await(await nativeFetch('/__fixture/status')).json();
      await wait(()=>document.querySelectorAll('.chapter-list .chapter-item').length>=fixture.chapters.length,'200章目录');
      initialNodes=document.querySelectorAll('*').length;measure('start');
      for(const chapter of fixture.chapters){if(stopped)break;await exercise(chapter);visited++;if(visited%20===0){const sample=measure('navigation-'+visited);if(sample.rows>20||sample.canvases>25||sample.domNodes>initialNodes+1500)throw Error('已离开章节的DOM仍累积');show();}}
      if(!stopped){await exercise(fixture.chapters[0]);measure('return-to-first');await new Promise(resolve=>setTimeout(resolve,5000));measure('settled');}
    }catch(error){failures.push(error.message);}finally{
      running=false;
      try{const status=await(await nativeFetch('/__fixture/status')).json();serverMetrics={providerCalls:status.providerCalls,counters:status.counters,rss:status.rss,rawChapterBytes:status.rawChapterBytes,rawJobsBytes:status.rawJobsBytes,snapshotBytes:status.snapshotBytes};if(status.providerCalls!==0)failures.push('出现模型请求');}catch(error){failures.push('无法读取最终夹具指标：'+error.message);}
      show();try{await nativeFetch('/__fixture/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report())});}catch(error){failures.push('无法导出指标：'+error.message);show();}
    }
  }
  window.addEventListener('DOMContentLoaded',()=>{
    const panel=document.createElement('aside');panel.id='fixture-pressure-controls';panel.style.cssText='position:fixed;right:6px;top:6px;z-index:99999;background:#fff;border:1px solid #63856a;border-radius:6px;padding:6px;max-width:480px;font:11px monospace';
    const start=document.createElement('button');start.textContent='开始200章导航与播放压力验证';start.id='fixture-pressure-start';start.onclick=run;panel.append(start);
    const stop=document.createElement('button');stop.textContent='停止夹具循环';stop.onclick=()=>{stopped=true;};panel.append(stop);
    const output=document.createElement('pre');output.id='fixture-pressure-result';output.style.cssText='max-height:80px;overflow:auto;white-space:pre-wrap';panel.append(output);document.body.append(panel);show();
  });
})();
