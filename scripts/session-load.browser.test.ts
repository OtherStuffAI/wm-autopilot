import { afterAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createProjectStaticAssetService } from "../src/server/static-assets";

// Disposable server/browser only; no prompts, production mutation or host restart.
const playwrightModule = process.env.PLAYWRIGHT_MODULE;
const suite = playwrightModule ? describe : describe.skip;
const baseline = process.env.SESSION_LOAD_BASELINE === "1";
const samples = Number(process.env.SESSION_LOAD_SAMPLES ?? 10);
const rows = (count: number, prefix = "saved") => Array.from({ length: count }, (_, i) => ({
  messageId: `${prefix}-${i}`, role: i % 2 ? "assistant" : "user", content: `${prefix} message ${i}`,
  createdAt: new Date(1700000000000 + i * 1000).toISOString(), order: i,
}));

suite("session history loading in a browser", () => {
  let browser: any;
  let server: ReturnType<typeof Bun.serve>;
  const assets = createProjectStaticAssetService(resolve(import.meta.dir, ".."));
  let delayMs = 300;
  let failRefresh = false;
  let count = 100;
  let streamDelayMs = 0;
  const timings: any[] = [];
  afterAll(async () => {
    server?.stop(true);
    await browser?.close();
  });

  test("measures saved, cached, long and switching history with slow upstream", async () => {
    const { chromium } = await import(playwrightModule!);
    browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/") return new Response(`<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><main aria-label="Session history fixture" id="fixture"></main>
        <script type="module">
          import { Alpine, registerChatComponent, getChatTemplate } from '/live/chat-component.js';
          import { MessageStore, db } from '/live/db.js';
          import { sseManager } from '/live/sse-manager.js';
          registerChatComponent(); Alpine.store('sessions', {items:[]});
          document.querySelector('#fixture').innerHTML=getChatTemplate(''); Alpine.start();
          const chat=Alpine.store('chat');
          let lastQueryAt=0;
          const replace=chat.replaceMessages;
          chat.replaceMessages=function(messages){lastQueryAt=performance.now();return replace.call(this,messages);};
          window.fixture={chat, MessageStore, db, sseManager, open: async (id) => {
            const start=performance.now(); window.fixture.openedAt=start; chat.loadSession(id);
            while(chat.sessionId===id && !document.querySelector('.wm-message-body')?.textContent?.includes('message')) {
              await new Promise(r=>requestAnimationFrame(r));
            }
            return {firstMs:performance.now()-start, renderMs:performance.now()-lastQueryAt};
          }};
        </script></body></html>`, { headers: { "content-type": "text/html" } });
      if (url.pathname.endsWith("/messages")) {
        const refreshed = url.searchParams.has("refresh");
        if (refreshed) await Bun.sleep(delayMs);
        if (refreshed && failRefresh) return Response.json({ error: "Controlled upstream failure" }, { status: 503 });
        return Response.json({ messages: rows(count, refreshed ? "fresh" : "saved") });
      }
      if(url.pathname.endsWith('/permissions')) return Response.json({permissions:[]});
      if(url.pathname.endsWith('/queue')) return Response.json({queue:{prompts:[]}});
      // Hold a disconnected stream independent of history; no reconnect polling.
      if(url.pathname.endsWith('/events')) { await Bun.sleep(streamDelayMs); return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(': connected\n\n'));}}),{headers:{'content-type':'text/event-stream'}}); }
      if (url.pathname === "/live/db.js" && process.env.SESSION_STORE_BASELINE_MODULE) return new Response(Bun.file(process.env.SESSION_STORE_BASELINE_MODULE), {headers:{"content-type":"application/javascript"}});
      return assets.resolveUiAsset(url.pathname) ?? await assets.serveVendorModule(url.pathname)
        ?? assets.servePublicAsset(url.pathname) ?? new Response("Not found", { status: 404 });
    }});
    const page = await browser.newPage();
    const errors: string[]=[];
    page.on('pageerror',(e:Error)=>errors.push(e.message));
    await page.goto(server.url.href);
    await page.waitForFunction(()=>Boolean((window as any).fixture));
    if (process.env.SESSION_STORE_BENCHMARK_ONLY === "1") {
      const benchmark=await page.evaluate(async (messages:any[])=>{
        const f=(window as any).fixture;const times=[];
        await f.MessageStore.syncFromServer('benchmark',messages);
        for(let i=0;i<10;i++) {
          const next=messages.map((m,j)=>({...m,content:m.content+(j===0?String(i):'')}));
          const start=performance.now();await f.MessageStore.syncFromServerIfChanged('benchmark',next);times.push(performance.now()-start);
        }
        const streamTimes=[];
        for(let i=0;i<20;i++){
          const start=performance.now();await f.MessageStore.upsertMessage('benchmark',{...messages.at(-1),content:'stream grows '+i});streamTimes.push(performance.now()-start);
        }
        return {snapshot:times.sort((a,b)=>a-b),stream:streamTimes.sort((a,b)=>a-b)};
      },rows(5000));
      for(const [phase,values] of Object.entries(benchmark) as any) console.log('SESSION_STORE_BENCHMARK',JSON.stringify({phase,n:values.length,median:values[Math.floor(values.length/2)],p95:values[Math.ceil(values.length*.95)-1],times:values}));
      expect(errors).toEqual([]);return;
    }
    for(const scenario of ['server','cached','long']) {
      count=scenario==='long'?5000:100;
      for(let i=0;i<samples;i++){
        const id=`${scenario}-${i}`;
        await page.evaluate(async ({id,cached,messages}:any)=>{
          const f=(window as any).fixture;f.chat.cleanup();
          if(cached) await f.MessageStore.syncFromServer(id,messages);
        },{id,cached:scenario==='cached',messages:rows(count)});
        const first=await page.evaluate((id:string)=>(window as any).fixture.open(id),id);
        const freshMs=await page.evaluate(async()=>{
          const f=(window as any).fixture;
          while(!f.chat.messages.at(-1)?.content.startsWith('fresh') || !document.querySelector('.wm-message-body')?.textContent?.startsWith('fresh')) await new Promise(r=>requestAnimationFrame(r));
          return performance.now()-f.openedAt;
        });
        const detail=await page.evaluate(()=>performance.getEntriesByType('resource').filter((r:any)=>r.name.includes('/messages')).slice(-2).map((r:any)=>({duration:r.duration,bytes:r.decodedBodySize})));
        const stages=await page.evaluate((id:string)=>performance.getEntriesByType('measure').filter(r=>r.name.startsWith('session-history:'+id+':')).map(r=>({name:r.name.split(':').slice(-2).join(':'),ms:r.duration})),id);
        timings.push({scenario,...first,freshMs,resources:detail,stages});
      }
    }
    console.log('SESSION_LOAD_TIMINGS',JSON.stringify(timings));
    for(const scenario of ['server','cached','long']) {
      const values=timings.filter(t=>t.scenario===scenario).map(t=>t.firstMs).sort((a,b)=>a-b);
      console.log('SESSION_LOAD_SUMMARY',JSON.stringify({scenario,n:values.length,median:values[Math.floor(values.length/2)],p95:values[Math.ceil(values.length*.95)-1]}));
    }
    if(!baseline) {
      count=100;delayMs=1500;streamDelayMs=2000;
      await page.evaluate(()=>{const f=(window as any).fixture; f.chat.cleanup();f.chat.loadSession('switch-a');});
      await page.waitForFunction(()=> (window as any).fixture.chat.messages.length===100);
      expect(await page.evaluate(()=> (window as any).fixture.chat.connectionState)).toBe('connecting');
      if (process.env.SESSION_LOAD_SCREENSHOT) await page.screenshot({path:process.env.SESSION_LOAD_SCREENSHOT});
      const rapidFirst=await page.evaluate(async()=>{
        const f=(window as any).fixture; const old=f.sseManager.connections.get('switch-a');
        f.rapidStartedAt=performance.now(); f.chat.loadSession('switch-b'); f.chat.loadSession('switch-a'); old.onopen?.(); old.onerror?.({});
        while(f.chat.messages.length!==100 || !document.querySelector('.wm-message-body')) await new Promise(r=>requestAnimationFrame(r));
        return performance.now()-f.rapidStartedAt;
      });
      await page.waitForFunction(()=> !(window as any).fixture.chat.isRefreshing);
      console.log('SESSION_RAPID_SWITCH_TIMINGS',JSON.stringify({n:1,cachedFirstMs:rapidFirst,freshMs:await page.evaluate(()=>performance.now()-(window as any).fixture.rapidStartedAt)}));
      expect(await page.evaluate(()=> (window as any).fixture.chat.sessionId)).toBe('switch-a');
      expect(await page.evaluate(()=> [...(window as any).fixture.sseManager.connections.keys()])).toEqual(['switch-a']);
      expect(await page.evaluate(()=> (window as any).fixture.chat.messages.every((m:any)=>m.sessionId==='switch-a'))).toBe(true);

      streamDelayMs=0;failRefresh=true;
      await page.evaluate(()=> (window as any).fixture.chat.loadSession('error'));
      await page.getByTestId('history-refresh-error').waitFor();
      expect(await page.evaluate(()=> (window as any).fixture.chat.messages.length)).toBe(100);
      failRefresh=false;delayMs=10;
      await page.getByTestId('history-refresh-retry').click();
      await page.waitForFunction(()=> !(window as any).fixture.chat.isRefreshing);
      expect(await page.getByTestId('history-refresh-error').count()).toBe(0);

      count=0;
      await page.evaluate(()=> (window as any).fixture.chat.loadSession('empty'));
      await page.waitForFunction(()=> (window as any).fixture.chat.historyLoaded && !(window as any).fixture.chat.isRefreshing);
      expect(await page.evaluate(()=> (window as any).fixture.chat.isLoading)).toBe(false);
      expect(await page.locator('.chat-empty').count()).toBe(1);

      // Real IndexedDB transaction rejects stale HTTP snapshots after SSE.
      const guarded=await page.evaluate(async()=>{
        const f=(window as any).fixture;const s=f.MessageStore;
        const saved=[{messageId:'guard-user',role:'user',content:'question',createdAt:'2026-01-01T00:00:00Z',order:0},
          {messageId:'guard-agent',role:'assistant',content:'answer',createdAt:'2026-01-01T00:00:01Z',order:1}];
        await s.syncFromServer('guard',saved);const revision=await s.getRevision('guard');
        await s.upsertMessage('guard',{...saved[1],content:'answer grows'});
        const result=await s.syncFromServerIfChanged('guard',saved,{expectedRevision:revision});
        const messages=await s.getSessionMessages('guard');
        const noop=await s.syncFromServerIfChanged('guard',messages);
        return {result,noop,messages};
      });
      expect(guarded.result).toEqual({changed:false,stale:true});
      expect(guarded.messages.map((m:any)=>m.content)).toEqual(['question','answer grows']);
      expect(guarded.noop.changed).toBe(false);
      const staleSaved=await page.evaluate(async()=>{
        const s=(window as any).fixture.MessageStore;
        const rows=await s.getSessionMessages('guard');
        await s.syncFromServerIfChanged('guard',[rows[0]]);
        await s.updateMessageSpeech('guard',rows[1],{publicPath:'/audio.mp3'});
        const withoutSpeech=(await s.getSessionMessages('guard')).map((m:any)=>{const {speech,...plain}=m;return plain;});
        const noop=await s.syncFromServerIfChanged('guard',withoutSpeech);
        return {rows:await s.getSessionMessages('guard'),noop};
      });
      expect(staleSaved.rows.map((m:any)=>m.content)).toEqual(['question','answer grows']);
      expect(staleSaved.rows[1].speech).toEqual({publicPath:'/audio.mp3'});
      expect(staleSaved.noop.changed).toBe(false);
    }
    await page.evaluate(()=> (window as any).fixture.chat.cleanup());
    await page.close();
    server.stop(true);
    await browser.close();
    browser = null;
    expect(errors).toEqual([]);
    if(!baseline) {
      expect(timings.filter(t=>t.scenario==='cached').every(t=>t.firstMs<200)).toBe(true);
      expect(timings.filter(t=>t.scenario==='server').every(t=>t.firstMs<1000)).toBe(true);
    }
  }, 120_000);
});
