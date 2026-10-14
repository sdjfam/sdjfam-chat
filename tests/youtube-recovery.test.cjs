const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),ts=require('typescript');
function harness(chatId=null) {
 const effects=[],refs=[],states=[],timers=[],listeners={},calls=[];let index=0;
 let discoveredId="ended";
 const source=fs.readFileSync('src/platforms/youtube/useYouTube.ts','utf8');
 const module={exports:{}};
 const mock={
  react:{useEffect:fn=>effects.push(fn),useRef:v=>{const r={current:v};refs.push(r);return r},useState:v=>{const i=index++;return [i===2?chatId:v,value=>states.push([i,value])]}},
  '@tauri-apps/api/core':{invoke:async(name)=>{calls.push(name);return name==='youtube_auto_connect'?{live:true,discovery_available:true,live_chat_id:discoveredId,video_id:'video'}:{}}},
  '@tauri-apps/api/event':{listen:async(name,fn)=>{listeners[name]=fn;return ()=>{delete listeners[name]}}},
 };
 new Function('require','module','exports',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(id=>mock[id]||new Proxy({},{get:()=>()=>{}}),module,module.exports);
 global.window={setInterval:fn=>{timers.push(fn);return timers.length},clearInterval:()=>{}};
 module.exports.useYouTube({setMessages:()=>{}});
 return {effects,refs,states,timers,listeners,calls,retryDelay:module.exports.youtubeRetryDelay,setDiscoveryId:id=>{discoveredId=id}};
}
const settle=async()=>{for(let i=0;i<15;i++)await Promise.resolve()};
test('EOF invalidates chat and discovery rejects the same ended chat while polling continues',async()=>{
 const h=harness('ended');const cleanup=h.effects[3]();await settle();
 assert.ok(h.listeners['youtube-chat-status']);
 h.listeners['youtube-chat-status']({payload:{status:'stream_ended',connected:false}});
 assert.ok(h.states.some(([i,v])=>i===2&&v===null));
 assert.ok(h.refs[0].current.has('ended'));
 h.refs[3].current=null;
 const stop=h.effects[1]();await settle();
 assert.equal(h.calls.filter(n=>n==='youtube_auto_connect').length,1);
 assert.ok(!h.states.some(([i,v])=>i===2&&v==='ended'));
 await h.timers.at(-1)();await settle();
 assert.equal(h.calls.filter(n=>n==='youtube_auto_connect').length,2);
 h.refs[0].current.get("ended").retryAt = 0;
 await h.timers.at(-1)();await settle();
 assert.ok(h.states.some(([i,v])=>i===2&&v==="ended"));
 h.setDiscoveryId("new-active-chat");
 await h.timers.at(-1)();await settle();
 assert.ok(h.states.some(([i,v])=>i===2&&v==="new-active-chat"));
 stop();cleanup();
});
test('accepted stream start never claims connected before backend confirmation',async()=>{
 const h=harness('active');const cleanup=h.effects[3]();await settle();
 assert.ok(!h.states.some(([i,v])=>i===0&&v===true));
 h.listeners['youtube-chat-status']({payload:{status:'connected',connected:true}});
 assert.ok(h.states.some(([i,v])=>i===0&&v===true));cleanup();
});

test('EOF retry delay increases and caps at fifteen minutes',()=>{const h=harness();assert.deepEqual([1,2,3,4,5,6].map(h.retryDelay),[60000,120000,240000,480000,900000,900000]);});

test('confirmed offline chat cannot restart, while a different active livestream is discoverable', async()=>{
 const h=harness('ended');const cleanup=h.effects[3]();await settle();
 h.listeners['youtube-chat-status']({payload:{status:'offline',connected:false}});
 assert.equal(h.refs[0].current.get('ended').retryAt,Infinity);
 h.refs[3].current=null;const stop=h.effects[1]();await settle();
 assert.ok(!h.states.some(([i,v])=>i===2&&v==='ended'));
 h.setDiscoveryId('new-live');await h.timers.at(-1)();await settle();
 assert.ok(h.states.some(([i,v])=>i===2&&v==='new-live'));stop();cleanup();
});
