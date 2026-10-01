#!/usr/bin/env node
// One bounded real-launcher module reload probe; no planner or external model.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root=resolve(process.argv[2]??process.cwd());const validationRoot=resolve(process.argv[3]??'/tmp/jev-real-dsh-check')
const home=join(validationRoot,'home')
const dir=join(validationRoot,'hmr-'+Date.now())
mkdirSync(dir,{recursive:true})
const wrapper=join(dir,'probe.mjs'), lifecycle=join(dir,'lifecycle.jsonl'), audit=join(dir,'audit.jsonl')
const entry=pathToFileURL(join(root,'packages/adapter-dsh/dist/src/jev-plugin.js')).href
const toolsEntry=pathToFileURL(join(home,'profiles/node_modules/@deepseek-ai/dsh-tools/lib/index.js')).href
function source(version) { return `
import{appendFileSync}from'node:fs';
import*as plugin from ${JSON.stringify(entry)};
import{defineTool}from ${JSON.stringify(toolsEntry)};
export const name='jev-hmr-probe';export const inject=['tools'];
const record=event=>appendFileSync(${JSON.stringify(lifecycle)},JSON.stringify({...event,version:${version}})+'\\n');
export function apply(ctx,config){
 ctx.effect(()=>{record({event:'apply'});return()=>record({event:'dispose'})});
 plugin.apply(ctx,config);
 ctx.tools.register(defineTool({name:'jev_hmr_probe_v${version}',description:'Local HMR probe',parameters:{},output:{schema:{type:'object',properties:{value:{type:'string',required:true}},additionalProperties:false},render(_a,v){return[{type:'text',text:v.value}]}},async execute(){record({event:'tool-body'});return{value:'ok'}}}));
 ctx.effect(()=>{const timer=setTimeout(async()=>{try{await ctx.tools.execute({callId:'hmr-call-${version}',name:'jev_hmr_probe_v${version}',arguments:{},signal:new AbortController().signal});record({event:'tool-complete'})}catch(e){record({event:'tool-error',error:String(e)})}},100);return()=>clearTimeout(timer)});
}` }

writeFileSync(wrapper,source(1))
const patch=join(dir,'probe.patch.yml')
writeFileSync(patch,`- id: hmr
  disabled: false
  config:
    root: [${JSON.stringify(dir)}]
    ignored: []
    debounce: 100
- insert:
    - id: jev-hmr-probe
      name: ${JSON.stringify(wrapper)}
      config:
        schemaVersion: '1'
        mode: shadow
        provider: {kind: mock}
        egress: {mode: deny}
        limits: {}
        features: {toolAssessment: true}
        audit: {}
`)
const bin=join(home,'profiles/node_modules/@deepseek-ai/dsh/lib/bin.js')
const child=spawn(process.execPath,[bin,'--profile','web','--patch',patch,'--host','127.0.0.1','--port','0','--no-open'],{cwd:home,env:{...process.env,DSH_HOME:home,JEV_AUDIT_PATH:audit},stdio:['ignore','pipe','pipe']})
let logs='';for(const stream of [child.stdout,child.stderr])stream.on('data',d=>{logs+=d.toString()})
const rows=path=>existsSync(path)?readFileSync(path,'utf8').split('\n').filter(Boolean).map(JSON.parse):[]
async function until(predicate,ms){const end=Date.now()+ms;while(Date.now()<end){if(predicate())return true;if(child.exitCode!==null)return false;await new Promise(r=>setTimeout(r,200))}return false}
const report={scope:'actual launcher module HMR and synthetic tool dispatch before/after reload; no live planner',startedAt:new Date().toISOString(),passed:false}
try {
  if(!await until(()=>rows(lifecycle).some(r=>r.event==='tool-complete'&&r.version===1)&&/dsh web: http/i.test(logs),60000))throw Error('initial plugin did not reach ready')
  writeFileSync(wrapper,source(2))
  if(!await until(()=>rows(lifecycle).some(r=>r.event==='tool-complete'&&r.version===2),30000))throw Error('module version 2 did not reload within 30 seconds')
  const life=rows(lifecycle)
  if(!life.some(r=>r.event==='dispose'&&r.version===1))throw Error('old plugin was not disposed')
  const mounts=rows(audit).filter(r=>typeof r.reason==='string'&&r.reason.startsWith('mounted:'))
  if(mounts.length!==2)throw Error('Jev plugin did not record a second mount')
  const events=rows(audit),decisions=events.filter(r=>r.kind==='decision'),executions=events.filter(r=>r.kind==='execution'&&r.status==='succeeded')
  if(decisions.length!==2||executions.length!==2||!executions.every(e=>decisions.some(d=>d.requestId===e.requestId)))throw Error('Expected exactly one decision/execution pair per tool call after HMR')
  report.passed=true;report.lifecycle=life;report.mountCount=mounts.length;report.correlatedToolCalls=executions.length
}catch(e){report.error=String(e);report.lifecycle=rows(lifecycle);process.exitCode=1}
finally{
 child.kill('SIGTERM')
 await Promise.race([once(child,'close'),new Promise(r=>setTimeout(r,5000))])
 if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')
 const output=join(validationRoot,'hmr-smoke.json')
 mkdirSync(dirname(output),{recursive:true});report.finishedAt=new Date().toISOString()
 writeFileSync(output,JSON.stringify(report,null,2)+'\n')
 if(!report.passed)writeFileSync(join(dir,'redacted.log'),logs.replace(/([?&]token=)[^\s"'&]+/g,'$1<redacted>').replace(/(token[:=]\s*)[^\s"',}]+/gi,'$1<redacted>'))
 console.log(JSON.stringify(report))
}
