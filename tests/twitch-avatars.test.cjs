const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function harness() {
  const effects=[], pending=[], handlers={}; let messages=[];
  const profiles={current:new Map()}; let disconnected=0;
  class Client {
    on(event,fn) { handlers[event]=fn; }
    connect() { return Promise.resolve(); }
    disconnect() { disconnected++; return Promise.resolve(); }
  }
  const mocks={
    react:{useRef:x=>({current:x}),useState:x=>[x,()=>{}],useEffect:fn=>effects.push(fn)},
    '@tauri-apps/api/core':{invoke:(name,args)=>{
      assert.equal(name,'twitch_user_profile');
      return new Promise((resolve,reject)=>pending.push({args,resolve,reject}));
    }},
    '@tauri-apps/api/event':{listen:()=>{throw Error('EventSub is outside this isolated chat test');}},
    'tmi.js':{default:{Client}},
    '../../diagnostics':new Proxy({},{get:()=>()=>{}}),
    '../../utils/normalizeViewerCount':{},
    './config':{TWITCH_CLIENT_ID:'fake-client',TWITCH_CHANNEL:'test'},
  };
  const source=fs.readFileSync(path.resolve(__dirname,'../src/platforms/twitch/useTwitch.ts'),'utf8');
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  const module={exports:{}};
  new Function('require','module','exports',js)(id=>{if(id in mocks)return mocks[id];throw Error(id);},module,module.exports);
  module.exports.useTwitch({chatUserProfilesRef:profiles,setMessages:update=>{messages=typeof update==='function'?update(messages):update;}});
  const cleanup=effects[2]();
  return {pending,profiles,cleanup,disconnected:()=>disconnected,messages:()=>messages,
    message:(id,userId,text)=>handlers.message('#test',{'id':id,'user-id':userId,'display-name':'Viewer'},text,false)};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('avatar fetch is shared while pending, updates matching messages and is reused',async()=>{
  const h=harness();h.message('one','123','first');h.message('two','123','second');
  assert.equal(h.pending.length,1);assert.equal(h.messages().length,2);
  h.pending[0].resolve({id:'123',display_name:'Viewer',profile_image_url:'https://example.invalid/avatar.png'});
  await flush();assert.ok(h.messages().every(m=>m.avatarUrl==='https://example.invalid/avatar.png'));
  h.message('three','123','third');assert.equal(h.pending.length,1);
  assert.equal(h.messages()[2].avatarUrl,'https://example.invalid/avatar.png');
  h.cleanup();await flush();assert.equal(h.disconnected(),1);
});
test('messages without a Twitch user ID remain visible without an API request',async()=>{
  const h=harness();h.message('one',undefined,'hello');
  assert.equal(h.pending.length,0);assert.equal(h.messages()[0].message,'hello');
  h.cleanup();await flush();
});
test('a failed profile request does not remove or block chat messages',async()=>{
  const h=harness();h.message('one','123','hello');
  const original=console.error;console.error=()=>{};
  try{h.pending[0].reject(new Error('simulated failure'));await flush();}finally{console.error=original;}
  assert.equal(h.messages()[0].message,'hello');assert.equal(h.messages()[0].avatarUrl,null);
  h.cleanup();await flush();
});
