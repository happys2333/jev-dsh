import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const repo=resolve(process.argv[2]??process.cwd());
const root=resolve(process.argv[3]??'/tmp/jev-real-dsh-check'),home=join(root,'home'),installed=join(home,'profiles/node_modules/@deepseek-ai');
const entry=pathToFileURL(join(repo,'packages/adapter-dsh/dist/src/jev-plugin.js')).href;
const driver=join(root,'driver.mjs'),audit=join(root,'dispatch-audit.jsonl'),results=join(root,'dispatch-results.json');
const toolsEntry=pathToFileURL(join(installed,'dsh-tools/lib/index.js')).href;
const source=`
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import * as jev from ${JSON.stringify(entry)};
import {defineTool} from ${JSON.stringify(toolsEntry)};
export const name='jev-real-dispatch-validation';export const inject=['tools'];
const audit=${JSON.stringify(audit)},out=${JSON.stringify(results)};
const rows=()=>{try{return readFileSync(audit,'utf8').split('\\n').filter(Boolean).map(JSON.parse)}catch{return[]}};
export function apply(ctx){
 const body={},checks=[];let seq=0;
 const add=(name,fail=false)=>ctx.tools.register(defineTool({name,description:'Synthetic local host validation only',parameters:{},output:{schema:{type:'object',properties:{value:{type:'string',required:true}},additionalProperties:false},render(_a,v){return[{type:'text',text:v.value}]}},async execute(){body[name]=(body[name]??0)+1;if(fail)throw Error('fixed-synthetic-tool-failure');return{value:'synthetic-ok'}}}));
 for(const n of ['ok','hostdeny','hostcancel','hostguard'])add('jev_real_'+n);add('jev_real_failure',true);
 const registerHostPolicy=()=>ctx.on('tools/pre-execute',async(exec,next)=>exec.name==='jev_real_hostdeny'?{kind:'deny',reason:'unrelated-host-policy-denied'}:exec.name==='jev_real_hostcancel'?{kind:'cancel'}:next());
 ctx.tools.guard(exec=>exec.name==='jev_real_hostguard'?'unrelated-host-guard-denied':undefined);
 const call=async suffix=>ctx.tools.execute({callId:'real-'+(++seq),name:'jev_real_'+suffix,arguments:{},signal:new AbortController().signal});
 const base={schemaVersion:'1',mode:'shadow',provider:{kind:'mock'},egress:{mode:'deny'},limits:{maxIdenticalFailures:3},features:{toolAssessment:true},audit:{}};
 const local={kind:'local',local:{endpoint:'http://127.0.0.1:17861',tokenRef:'env:JEV_VALIDATION_ABSENT_TOKEN',ownership:'external',expectedModel:{requested:'unavailable-validation-only',revision:'not-a-live-model'}}};
 const localEgress={mode:'local-only',allowedOrigins:['http://127.0.0.1:17861'],allowedPurposes:['tool-assessment']};
 async function checkCase(label,override,expectedFails,assessed){
  const start=rows().length,before={...body},fiber=await ctx.plugin(jev,{...base,...override}),policyOff=registerHostPolicy();
  let first;
  try{
   first=await call('ok');assert.equal(first.isError,false,label+': successful body');
   const failureResults=[];for(let i=0;i<5;i++)failureResults.push(await call('failure'));
   assert.equal((body.jev_real_failure??0)-(before.jev_real_failure??0),expectedFails,label+': failure body count');
   for(const suffix of ['hostdeny','hostcancel','hostguard']){const r=await call(suffix);assert.equal(r.isError,true,label+': host restriction');assert.equal(body['jev_real_'+suffix]??0,before['jev_real_'+suffix]??0,label+': restricted body');}
   const events=rows().slice(start),decisions=events.filter(r=>r.kind==='decision'),executions=events.filter(r=>r.kind==='execution');
   assert.equal(events.filter(r=>r.reason?.startsWith('mounted:')).length,1,label+': mount');
   assert.equal(decisions.length,assessed?9:0,label+': decisions');assert.equal(executions.length,assessed?9:0,label+': execution rows');
   assert.equal(new Set(decisions.map(r=>r.requestId)).size,decisions.length,label+': no duplicate observer');
   assert.ok(executions.every(e=>decisions.filter(d=>d.requestId===e.requestId).length===1),label+': correlated rows');
   if(assessed){assert.equal(decisions.filter(r=>r.action==='deny'&&r.reasonCodes.some(c=>c.startsWith('hard-rule:'))).length,2,label+': deterministic paused paths');assert.ok(decisions.every(r=>r.synthetic));}
   checks.push({name:label,pass:true,toolBodyCalls:{success:1,repeatedFailures:expectedFails,hostRestricted:0},attempts:9,decisionRows:decisions.length,executionRows:executions.length,refusedRepeatMessages:failureResults.slice(3).flatMap(r=>(r.content??[]).map(c=>c.text??''))});
  }finally{policyOff();await fiber.dispose()}
  const count=rows().length,n=body.jev_real_failure??0;await call('failure');assert.equal(body.jev_real_failure,n+1,label+': no stale Jev guard after unload');assert.equal(rows().length,count,label+': no observer after unload');
  const restricted=await call('hostguard');assert.equal(restricted.isError,true,label+': unrelated guard survives unload');
  checks.push({name:label+' unload',pass:true,auditRowsAdded:0,unrelatedHostGuardPreserved:true});
 }
 async function localCase(mode,withSyntheticToken=false){if(withSyntheticToken)process.env.JEV_VALIDATION_ABSENT_TOKEN='synthetic-validation-only-not-a-user-credential';else delete process.env.JEV_VALIDATION_ABSENT_TOKEN;const start=rows().length,n=body.jev_real_ok??0,fiber=await ctx.plugin(jev,{...base,mode,provider:local,egress:localEgress});try{const r=await call('ok'),expected=mode==='shadow';assert.equal(r.isError,!expected);assert.equal(body.jev_real_ok??0,n+(expected?1:0));const events=rows().slice(start),decision=events.find(r=>r.kind==='decision');assert.ok(decision.reasonCodes.includes(withSyntheticToken?'provider:LOCAL_NOT_READY':'provider:AUTH'));checks.push({name:mode+(withSyntheticToken?' unreachable local provider':' missing local credential'),pass:true,bodyExecuted:expected,decision:decision.action,reasons:decision.reasonCodes});}finally{await fiber.dispose()}}
 ctx.effect(()=>{const timer=setTimeout(async()=>{try{delete process.env.JEV_VALIDATION_ABSENT_TOKEN;await checkCase('off repeated-failure inertness',{mode:'off'},5,false);await checkCase('disabled-assessment repeated-failure inertness',{features:{toolAssessment:false}},5,false);await checkCase('shadow deterministic guard',{},3,true);await checkCase('shadow reload fresh generation',{},3,true);await localCase('shadow');await localCase('enforce');await localCase('shadow',true);await localCase('enforce',true);delete process.env.JEV_VALIDATION_ABSENT_TOKEN;writeFileSync(out,JSON.stringify({passed:true,checks,toolBodies:body,totalDispatches:seq},null,2)+'\\n')}catch(error){writeFileSync(out,JSON.stringify({passed:false,error:String(error),stack:error.stack,checks,toolBodies:body,totalDispatches:seq},null,2)+'\\n')}},500);return()=>clearTimeout(timer)});
}
`;
mkdirSync(root,{recursive:true});rmSync(audit,{force:true});rmSync(results,{force:true});writeFileSync(driver,source);
const patch=join(root,'dispatch.patch.yml');writeFileSync(patch,`- insert:\n    - id: jev-real-dispatch-validation\n      name: ${JSON.stringify(driver)}\n`);
const bin=join(installed,'dsh/lib/bin.js');
const versions=Object.fromEntries(['dsh','dsh-agent-loop','dsh-agent','dsh-tools','dsh-user-approval','dsh-base','cordis'].map(name=>[name,JSON.parse(readFileSync(join(installed,name,'package.json'),'utf8')).version]));
const child=spawn(process.execPath,[bin,'--profile','web','--patch',patch,'--host','127.0.0.1','--port','0','--no-open'],{cwd:home,env:{...process.env,DSH_HOME:home,JEV_AUDIT_PATH:audit},stdio:['ignore','pipe','pipe']});
let logs='';for(const stream of [child.stdout,child.stderr])stream.on('data',d=>logs+=d);
const startedAt=new Date().toISOString();let report;
try{const end=Date.now()+90000;while(Date.now()<end&&!existsSync(results)&&child.exitCode===null)await new Promise(r=>setTimeout(r,200));assert.ok(existsSync(results),'validation driver did not finish');report=JSON.parse(readFileSync(results));assert.equal(report.passed,true,report.error);assert.match(logs,/dsh web: http/);report.listening=true;}catch(e){report={...report,passed:false,outerError:String(e)}}finally{child.kill('SIGTERM');await Promise.race([new Promise(r=>child.on('close',r)),new Promise(r=>setTimeout(r,5000))]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
writeFileSync(join(root,'dispatch-redacted.log'),logs.replace(/([?&]token=)[^\s"'&]+/g,'$1<redacted>').replace(/(token[:=]\s*)[^\s"',}]+/gi,'$1<redacted>'));
report={...report,startedAt,finishedAt:new Date().toISOString(),versions,node:process.version,source:{entry,entrySha256:createHash('sha256').update(readFileSync(join(repo,'packages/adapter-dsh/dist/src/jev-plugin.js'))).digest('hex'),implementation:'packages/adapter-dsh/dist/src/jey-plugin.js',implementationSha256:createHash('sha256').update(readFileSync(join(repo,'packages/adapter-dsh/dist/src/jey-plugin.js'))).digest('hex')},scope:'Actual official installed DSH web launcher, real tools runtime and actual built Jev plugin. Probe tool inputs and model responses are synthetic. No generative planner, live local model, cloud call, or browser approval flow.'};
writeFileSync(join(root,'host-dispatch.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));process.exitCode=report.passed?0:1;
