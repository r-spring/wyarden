const test = require("node:test");
const assert = require("node:assert/strict");
const { parseClaudeResponse } = require("../out/worker");

const primary = "claude-opus-5-5";
const auxiliary = "claude-haiku-5-5";
const value = { low: 100, likely: 200, high: 400, assumptions: [], risks: [], rationale: "Synthetic estimate" };
const mainUsage = { input_tokens: 7, output_tokens: 900, cache_read_input_tokens: 500, cache_creation_input_tokens: 250 };
const modelUsage = { inputTokens: 7, outputTokens: 900, cacheReadInputTokens: 500, cacheCreationInputTokens: 250 };
const helperUsage = { inputTokens: 2000, outputTokens: 25, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

function result(extra = {}) {
  return { type: "result", subtype: "success", is_error: false, session_id: "synthetic-session",
    structured_output: value, result: JSON.stringify(value), usage: { ...mainUsage },
    modelUsage: { [primary]: { ...modelUsage } }, total_cost_usd: 0.01,
    subagent_stats: { spawned: 0 }, terminal_reason: "completed", stop_reason: "tool_use", ...extra };
}
function assistant(model = primary, extra = {}) {
  return { type: "assistant", session_id: "synthetic-session", parent_tool_use_id: null,
    message: { id: "synthetic-message", role: "assistant", model, content: [{ type: "text", text: JSON.stringify(value) }] }, ...extra };
}
function mixedResult(extra = {}) {
  return result({ modelUsage: { [auxiliary]: { ...helperUsage }, [primary]: { ...modelUsage } }, ...extra });
}
const parse = (output, requested = "opus") => parseClaudeResponse(output, "opus", requested);

test("Claude parser accepts a legacy result object and a verbose event array", () => {
  for (const output of [result(), [{ type: "system", subtype: "init", session_id: "synthetic-session", model: primary }, assistant(), result()]]) {
    const answer = parse(output);
    assert.deepEqual(answer.value, value);
    assert.equal(answer.model, primary);
    assert.deepEqual(answer.usage.modelUsage, result().modelUsage);
  }
});

test("verbose assistant identity accepts an ancillary Haiku ledger and retains its usage", () => {
  const raw = mixedResult();
  const answer = parse([assistant(), raw]);
  assert.equal(answer.model, primary);
  assert.deepEqual(answer.usage.modelUsage, raw.modelUsage);
  assert.deepEqual(answer.usage.usage, mainUsage);
  assert.equal(answer.usage.attribution.primaryModel, primary);
  assert.deepEqual(answer.usage.attribution.auxiliaryModels, [auxiliary]);
});

test("single-result recovery requires a unique exact four-counter main-loop match", () => {
  const raw = mixedResult();
  const answer = parse(raw);
  assert.equal(answer.model, primary);
  assert.deepEqual(answer.value, value);
  assert.deepEqual(answer.usage.modelUsage, raw.modelUsage);
  assert.equal(answer.usage.attribution.primaryModel, primary);
  assert.deepEqual(answer.usage.attribution.auxiliaryModels, [auxiliary]);
  assert.throws(() => parse(mixedResult({ usage: { ...mainUsage, output_tokens: 901 } })));
  assert.throws(() => parse(mixedResult({ modelUsage: { [primary]: { ...modelUsage }, [auxiliary]: { ...modelUsage } } })));
});

test("single-result recovery rejects missing, negative, and nonfinite usage evidence", () => {
  const missingCounter = { ...mainUsage };
  delete missingCounter.cache_creation_input_tokens;
  for (const usage of [undefined, missingCounter, { ...mainUsage, input_tokens: -1 }, { ...mainUsage, output_tokens: NaN }]) {
    assert.throws(() => parse(mixedResult({ usage })));
  }
  assert.throws(() => parse(mixedResult({ subagent_stats: undefined })));
});

test("a target ledger entry cannot override a wrong or mixed assistant identity", () => {
  assert.throws(() => parse([assistant("claude-sonnet-5-5"), mixedResult()]));
  assert.throws(() => parse([assistant(), assistant(auxiliary), mixedResult()]));
  assert.throws(() => parse([assistant(primary), assistant("claude-opus-5-6"), result()]));
});

test("missing model evidence and an unrelated ledger cannot authenticate the answer", () => {
  assert.throws(() => parse(result({ modelUsage: {} })));
  assert.throws(() => parse(result({ modelUsage: undefined })));
  assert.throws(() => parse(result({ modelUsage: { "claude-sonnet-5-5": modelUsage } })));
  assert.throws(() => parse(mixedResult({ modelUsage: { [primary]: modelUsage, "claude-sonnet-5-5": helperUsage } })));
});

test("an incomplete or mismatched verbose assistant record cannot use legacy attribution", () => {
  assert.throws(() => parse([assistant(primary, { message: { role: "assistant", content: [] } }), result()]));
  assert.throws(() => parse([assistant(primary, { session_id: "other-session" }), result()]));
});

test("observed or reported subagent activity cannot count as an independent member", () => {
  assert.throws(() => parse(mixedResult({ subagent_stats: { spawned: 1 } })));
  assert.throws(() => parse([assistant(), result({ subagent_stats: { spawned: 1 } })]));
  assert.throws(() => parse([assistant(primary, { parent_tool_use_id: "synthetic-tool" }), result()]));
});

test("review attribution preserves the pinned concrete model", () => {
  assert.equal(parse([assistant(), mixedResult()], primary).model, primary);
  assert.throws(() => parse([assistant(), mixedResult()], "claude-opus-5-4"));
  assert.throws(() => parse(mixedResult(), "claude-opus-5-4"));
});

test("provider errors and absent structured results fail even with matching model usage", () => {
  assert.throws(() => parse(result({ is_error: true, result: "Synthetic provider failure" })));
  assert.throws(() => parse(result({ subtype: "error_max_structured_output_retries", result: "Synthetic schema failure" })));
  assert.throws(() => parse(result({ structured_output: undefined, result: "Not JSON" })));
  assert.throws(() => parse([assistant()]));
  assert.throws(() => parse([]));
});

test("legacy JSON text fallback remains supported", () => {
  assert.deepEqual(parse(result({ structured_output: undefined })).value, value);
});

test("the shared Claude parser supports Fable, Sonnet refinement and Haiku naming", () => {
  for (const member of ["fable", "sonnet", "haiku"]) {
    const model=`claude-${member}-5-5`, raw=result({modelUsage:{[model]:modelUsage}});
    assert.equal(parseClaudeResponse([assistant(model),raw],member).model,model);
  }
});

test("saved successful text calls recover without starting provider processes", () => {
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const {execFileSync}=require('node:child_process');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ab-claude-replay-'));
  const worker=JSON.stringify(require.resolve('../out/worker'));
  try {
    const folders=[];
    for(const member of ['fable','opus']) {
      const folder=path.join(dir,member);fs.mkdirSync(folder,{recursive:true});folders.push([folder,member]);
      const model=`claude-${member}-5-5`, raw=mixedResult({modelUsage:{[auxiliary]:helperUsage,[model]:modelUsage}});
      fs.writeFileSync(path.join(folder,'text.provider-output.jsonl'),JSON.stringify(raw));
      // Saved output is reused only for the input it answered (4 November 2026): the input record is written before any process starts.
      const {helperInputKey}=require('../out/worker');
      fs.writeFileSync(path.join(folder,'text.input.json'),JSON.stringify({inputKey:helperInputKey({provider:'claude',model:member,effort:'medium',prompt:'p',schema:{}})}));
    }
    const script=path.join(dir,'replay.cjs');
    fs.writeFileSync(script,`require('node:child_process').spawn=()=>{throw new Error('Provider process forbidden in replay test')};\nconst {textCall}=require(${worker});\nPromise.all(${JSON.stringify(folders)}.map(([d,m])=>textCall(d,m,'','p',{},new AbortController().signal))).catch(e=>{console.error(e);process.exitCode=1});`);
    execFileSync(process.execPath,[script],{encoding:'utf8'});
    for(const [folder] of folders) {
      const cached=JSON.parse(fs.readFileSync(path.join(folder,'text.result.json'),'utf8'));
      assert.equal(cached.recoveredSavedOutput,true);
      assert.equal(cached.usage.attribution.method,'main-usage-match');
      assert.ok(cached.usage.modelUsage[auxiliary]);
    }
    // A valid replay whose cache cannot be saved must not be misclassified as a provider retry.
    const [folder,member]=folders[0];
    fs.rmSync(path.join(folder,'text.result.json'));
    fs.writeFileSync(script,`const fs=require('node:fs'),rename=fs.renameSync;
fs.renameSync=(from,to)=>{if(to.endsWith('text.result.json'))throw new Error('Synthetic cache write failure');return rename(from,to)};
require('node:child_process').spawn=()=>{throw new Error('Provider process forbidden in replay test')};
const {textCall}=require(${worker});
textCall(${JSON.stringify(folder)},${JSON.stringify(member)},'','p',{},new AbortController().signal).then(()=>{process.exitCode=1},e=>{console.log(e.message)});`);
    assert.match(execFileSync(process.execPath,[script],{encoding:'utf8'}),/Synthetic cache write failure/);
    // The same saved output asked for with a different prompt is not reused: a real call would be needed, and spawn is forbidden here.
    const other=folders[1][0];
    fs.writeFileSync(script,`require('node:child_process').spawn=()=>{throw new Error('Provider process forbidden in replay test')};
const {textCall}=require(${worker});
textCall(${JSON.stringify(other)},'opus','','a different prompt',{},new AbortController().signal).then(()=>{process.exitCode=1},e=>{console.log(e.message)});`);
    assert.match(execFileSync(process.execPath,[script],{encoding:'utf8'}),/Provider process forbidden/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
