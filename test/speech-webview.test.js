const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),os=require('node:os'),{spawn}=require('node:child_process');
const {Cdp,freePort,waitFor,edgePath,browserEnv}=require('./compile-webview-cdp');
// Off Windows the Chrome or Chromium edgePath() finds drives it; on Windows set ENTOMATICAL_SPEECH_CHROMIUM (Edge leaves processes behind this test's plain kill).
const chromium=process.env.ENTOMATICAL_SPEECH_CHROMIUM||(process.platform!=='win32'&&edgePath());
test('unified speech provider and local-model dropdown preserve the draft and route selections', {skip:!chromium}, async()=>{
 const port=await freePort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'speech-ui-'));
 const child=spawn(chromium,['--headless','--no-sandbox','--disable-gpu',`--remote-debugging-port=${port}`,`--user-data-dir=${dir}`,'file://'+path.join(__dirname,'compile-webview-harness.html')],{env:browserEnv(),stdio:'ignore'});
 let c;
 try{const pages=await waitFor(async()=>{try{return await(await fetch(`http://127.0.0.1:${port}/json`)).json();}catch{return null;}},'browser');c=await Cdp.connect(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await waitFor(()=>c.evaluate('window.__ready'),'page');
 await c.evaluate(`document.documentElement.style.cssText='--vscode-font-family:Arial,sans-serif;--vscode-font-size:13px;--vscode-foreground:#ddd;--vscode-descriptionForeground:#aaa;--vscode-editorWidget-background:#252526;--vscode-input-foreground:#ddd;--vscode-input-background:#313131;--vscode-button-foreground:#fff;--vscode-button-background:#005a9e;--vscode-button-secondaryForeground:#ddd;--vscode-button-secondaryBackground:#333;--vscode-focusBorder:#007fd4';document.body.style.background='#1e1e1e';window.speechState={tasks:[],live:[],own:[],accounts:[],dictation:'Record speech',speech:{provider:'local',providers:[{id:'claude',label:'Claude (existing account)'},{id:'local',label:'Local Whisper'},{id:'parakeet',label:'Local Parakeet'},{id:'openai',label:'OpenAI'},{id:'groq',label:'Groq'},{id:'deepgram',label:'Deepgram'}],folder:'C:/Whisper',modelPath:'C:/Whisper/ggml-base.en.bin',models:[{label:'base.en',path:'C:/Whisper/ggml-base.en.bin'},{label:'large-v3-turbo',path:'C:/Whisper/ggml-large-v3-turbo.bin'}]},codex:{accounts:[],models:[]}};window.__host(window.speechState);`);
 const result=await c.evaluate(`(()=>{const model=document.querySelector('[aria-label="Whisper model"]');model.value='C:/Whisper/ggml-large-v3-turbo.bin';model.dispatchEvent(new Event('change'));[...document.querySelectorAll('button')].find(b=>b.textContent==='Choose Whisper folder').click();const mic=document.querySelector('.dictate button');mic.click();window.__host({dictating:'recording'});window.__host({dictatedLive:'Hello'});window.__host({dictatedLive:'Hello from addiction'});const live=document.querySelector('textarea').value;window.__host({dictated:'Hello from dictation'});window.__host({dictating:false});const provider=document.querySelector('[aria-label="Dictation provider"]');provider.value='claude';provider.dispatchEvent(new Event('change'));return {enabled:!mic.disabled,models:[...model.options].map(o=>o.text),live,text:document.querySelector('textarea').value,messages:window.__posted};})()`);
 assert.equal(result.enabled,true);assert.equal(result.live,'Hello from addiction');assert.equal(result.text,'Hello from dictation');assert.deepEqual(result.models,['base.en','large-v3-turbo']);
 for(const type of ['speechLocal','speechModel','speechProvider','dictate'])assert.ok(result.messages.some(x=>x.type===type),JSON.stringify(result.messages));
 await c.evaluate(`window.__host({...window.speechState,speech:{...window.speechState.speech,provider:'claude'}})`);
 assert.equal(await c.evaluate(`document.querySelector('[aria-label="Whisper model"]').parentElement.hidden`),true);
 await c.evaluate(`window.__host({...window.speechState,speech:{...window.speechState.speech,provider:'local',modelPath:'C:/Whisper/ggml-large-v3-turbo.bin'}})`);
 await c.evaluate(`window.__host({...window.speechState,speech:{...window.speechState.speech,provider:'parakeet',modelPath:'C:/Whisper/ggml-parakeet.bin',models:[{label:'parakeet-tdt',path:'C:/Whisper/ggml-parakeet.bin'}]}})`);
 const parakeet=await c.evaluate(`(()=>{const model=document.querySelector('[aria-label="Parakeet model"]'),folder=[...document.querySelectorAll('button')].find(b=>b.textContent==='Choose Parakeet folder');window.__host({dictating:'recording'});const tools=[...document.querySelectorAll('button')].find(b=>b.textContent==='Parakeet tools');const disabled=model.disabled&&tools.disabled;window.__host({dictating:false});tools.click();return {visible:!model.parentElement.hidden,models:[...model.options].map(o=>o.text),folder:!!folder,disabled,keyHidden:[...document.querySelectorAll('button')].find(b=>b.textContent==='Set speech API key').hidden,note:document.querySelector('.speech-controls').textContent};})()`);
 assert.ok((await c.evaluate('window.__posted')).some(m=>m.type==='parakeetTools'));assert.equal(parakeet.visible,true);assert.equal(parakeet.folder,true);assert.equal(parakeet.disabled,true);assert.equal(parakeet.keyHidden,true);assert.deepEqual(parakeet.models,['parakeet-tdt']);assert.match(parakeet.note,/while you speak/);
 for(const width of [1100,360]){await c.send('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:false});assert.equal(await c.evaluate('document.documentElement.scrollWidth <= window.innerWidth'),true);if(process.env.ENTOMATICAL_SPEECH_SHOTS){const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(process.env.ENTOMATICAL_SPEECH_SHOTS,`unified-${width}.png`),Buffer.from(shot.data,'base64'));}}
 }finally{c?.close();child.kill();if(child.exitCode===null&&child.signalCode===null)await new Promise(r=>child.once('close',r));/* a browser that already ended never closes again */fs.rmSync(dir,{recursive:true,force:true});}
});

test('speech settings collapse with keyboard controls and remember the choice without losing the draft', { timeout: 60_000 }, async (t) => {
 const browser = require('./compile-webview-cdp');
 if (!browser.edgePath()) return t.skip('A browser is required for the speech disclosure check');
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-collapse-'));
 const root = process.env.ENTOMATICAL_SPEECH_UI_ROOT || path.dirname(__dirname);
 const url = require('node:url').pathToFileURL(path.join(root, 'test/compile-webview-harness.html')).href;
 let edge, page;
 try {
  edge = await browser.launchEdge(url, dir);
  const target = await waitFor(async () => (await browser.listTargets(edge.port)).find(p => p.type === 'page' && p.url.toLowerCase() === url.toLowerCase()), 'speech test page');
  page = await Cdp.connect(target.webSocketDebuggerUrl);
  await waitFor(() => page.evaluate('window.__ready === true'), 'speech board ready');
  const theme = () => page.evaluate(`document.documentElement.style.cssText = '--vscode-font-family:Arial,sans-serif;--vscode-font-size:13px;--vscode-foreground:#ddd;--vscode-descriptionForeground:#aaa;--vscode-editorWidget-background:#252526;--vscode-input-foreground:#ddd;--vscode-input-background:#313131;--vscode-button-foreground:#fff;--vscode-button-background:#005a9e;--vscode-button-secondaryForeground:#ddd;--vscode-button-secondaryBackground:#333;--vscode-focusBorder:#007fd4'; document.body.style.background = '#1e1e1e'; true`);
  await theme();
  const speech = { provider: 'local', providers: [{ id: 'local', label: 'Local Whisper' }], folder: 'C:/Whisper', modelPath: 'C:/Whisper/base.bin',
   models: [{ label: 'base', path: 'C:/Whisper/base.bin' }, { label: 'large', path: 'C:/Whisper/large.bin' }] };
  const host = () => page.evaluate(`window.__host(${JSON.stringify({ tasks: [], live: [], own: [], accounts: ['acct'], dictation: 'Record speech', speech })}); true`);
  await host();
  assert.equal(await page.evaluate('document.querySelector(".speech-controls").tagName'), 'DETAILS');
  assert.equal(await page.evaluate('document.querySelector(".speech-controls").open'), false);
  assert.equal(await page.evaluate('document.querySelector(".speech-controls select").checkVisibility()'), false);
  await page.evaluate(`promptBox.value = 'Keep this draft'; promptBox.dispatchEvent(new Event('input')); document.querySelector('.speech-controls > summary').focus(); true`);
  const key = async (value, code, number) => {
   await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code, windowsVirtualKeyCode: number, text: value === 'Enter' ? '\r' : value });
   await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code, windowsVirtualKeyCode: number });
  };
  await key('Enter', 'Enter', 13);
  await waitFor(() => page.evaluate('window.__state.speechOpen === true'), 'expanded speech state saved');
  assert.equal(await page.evaluate('document.querySelector(".speech-controls select").checkVisibility()'), true);
  await page.evaluate(`whisperModel.value = 'C:/Whisper/large.bin'; whisperModel.dispatchEvent(new Event('change')); true`);
  assert.deepEqual(await page.evaluate(`window.__posted.filter(m => m.type === 'speechModel')`), [{ type: 'speechModel', model: 'C:/Whisper/large.bin' }]);
  await host();
  assert.equal(await page.evaluate('document.querySelector(".speech-controls").open'), true, 'host updates keep the disclosure open');
  assert.equal(await page.evaluate('promptBox.value'), 'Keep this draft');
  const reload = async () => {
   const before = await page.evaluate('performance.timeOrigin');
   await page.send('Page.reload');
   await waitFor(() => page.evaluate(`window.__ready === true && performance.timeOrigin > ${before}`), 'speech disclosure restored');
   await theme();
  };
  await reload();
  assert.equal(await page.evaluate('document.querySelector(".speech-controls").open'), true);
  assert.equal(await page.evaluate('promptBox.value'), 'Keep this draft');
  await page.evaluate(`document.querySelector('.speech-controls > summary').focus(); true`);
  await key(' ', 'Space', 32);
  await waitFor(() => page.evaluate('window.__state.speechOpen === false'), 'collapsed speech state saved');
  await reload();
  assert.equal(await page.evaluate('document.querySelector(".speech-controls").open'), false);
  await host();
  assert.equal(await page.evaluate('document.querySelector(".dictate button").checkVisibility()'), true, 'microphones remain available while settings are collapsed');
  for (const width of [1100, 360]) {
   await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
   for (const open of [false, true]) {
    await page.evaluate(`speechControls.open = ${open}; true`);
    assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    if (process.env.ENTOMATICAL_SPEECH_SHOTS) {
     const shot = await page.send('Page.captureScreenshot', { format: 'png' });
     fs.writeFileSync(path.join(process.env.ENTOMATICAL_SPEECH_SHOTS, `speech-${width}-${open ? 'open' : 'closed'}.png`), Buffer.from(shot.data, 'base64'));
    }
   }
  }
 } finally {
  page?.close();
  if (edge) await edge.kill();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
 }
});
