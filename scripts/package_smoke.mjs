#!/usr/bin/env node
// Build first. Installs local tarballs in a fresh directory outside the checkout.
// No registry publishing, credentials, model calls or host startup.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'jev-package-smoke-'))
const archives = join(work, 'archives')
const consumer = join(work, 'consumer')
mkdirSync(archives); mkdirSync(consumer)
const report = { version: 1, scope: 'fresh tarball install and real ToolRuntime dispatch with synthetic provider; no live model or launcher', archives: [], checks: [], passed: false }
const output = resolve(process.argv[2] ?? join(root, 'artifacts/reconstruction_20260930_linux/packaging/smoke.json'))
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 180000,
    env: { ...process.env, npm_config_cache: join(work, 'npm-cache') }, maxBuffer: 8 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${(result.stderr ?? '').slice(-3000)}`)
  return result.stdout
}
try {
  for (const directory of readdirSync(join(root, 'packages'))) {
    const packageRoot=join(root,'packages',directory)
    const sentinels=['src/.jev-pack-sentinel.env','dist/.jev-pack-sentinel.env','dist/jev-pack-sentinel.gguf',...(directory==='adapter-dsh'?['dist/src/.jev-pack-sentinel.env','dist/src/jev-pack-sentinel.gguf']:[])]
      .map(p=>join(packageRoot,p))
    for(const path of sentinels) { if(existsSync(path)) throw new Error('Refusing to overwrite sentinel path'); writeFileSync(path,'SYNTHETIC_NON_SECRET_PACKAGING_SENTINEL') }
    try { run('pnpm', ['pack', '--pack-destination', archives], packageRoot) }
    finally { for(const path of sentinels) unlinkSync(path) }
  }
  const paths = readdirSync(archives).filter(p => p.endsWith('.tgz')).map(p => join(archives, p))
  for (const path of paths) {
    const files = run('tar', ['-tzf', path], work).trim().split('\n')
    if(files.some(p=>p.includes('jev-pack-sentinel'))) throw new Error('Excluded file sentinel leaked into tarball')
    const manifest = JSON.parse(run('tar', ['-xOf', path, 'package/package.json'], work))
    if (Object.values(manifest.dependencies ?? {}).some(v => v.startsWith('workspace:'))) throw new Error(`Unresolved workspace dependency: ${manifest.name}`)
    if (manifest.name === 'jev-adapter-dsh' && files.some(p => /\/(src|test)\//.test(p.replace('package/dist/src/', 'package/runtime/')))) throw new Error('DSH package contains source/tests outside runtime allowlist')
    if (manifest.name === 'jev-core' && !files.includes('package/config/config.schema.json')) throw new Error('Core schema missing from tarball')
    report.archives.push({ name: manifest.name, fileCount: files.length, excludedSentinels: true, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })
  }
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'jev-clean-consumer', private: true, type: 'module' }))
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...paths], consumer)
  const probe = `
    import assert from 'node:assert/strict';
    import {realpathSync,readFileSync} from 'node:fs';
    const root=process.cwd();
    for(const name of ${JSON.stringify(report.archives.map(a => a.name))}) {
      const location=realpathSync(new URL(import.meta.resolve(name)));
      assert.ok(location.startsWith(root+'/node_modules/'), name+' escaped clean consumer');
      await import(name);
    }
    const {loadConfig,SCHEMA_PATH}=await import('jev-core');
    assert.ok(SCHEMA_PATH.startsWith(root+'/node_modules/jev-core/'));
    const config=loadConfig({schemaVersion:'1',mode:'off',provider:{kind:'unconfigured'},egress:{mode:'deny'},limits:{},features:{},audit:{}},{approvalChannel:false,scopedRestrict:true,postExecuteWaterfall:true});
    assert.equal(config.mode,'off');
    const plugin=await import('jev-adapter-dsh');
    assert.equal(typeof plugin.apply,'function');
    assert.equal(plugin.jevPlugin,plugin.jeyPlugin);
    assert.equal((await import('jev-adapter-dsh/jey-plugin')).apply,plugin.apply);
    const {Context}=await import('@deepseek-ai/cordis');
    const {mountAgentLoopTestDependencies}=await import('@deepseek-ai/dsh-agent-loop-testkit');
    const {defineTool}=await import('@deepseek-ai/dsh-tools');
    const {ToolCallId}=await import('@deepseek-ai/dsh-llm');
    const ctx=new Context();
    let bodyCalls=0;
    process.env.JEV_AUDIT_PATH=root+'/package-audit.jsonl';
    try {
      await mountAgentLoopTestDependencies(ctx);
      await ctx.plugin(plugin.jevPlugin,{schemaVersion:'1',mode:'shadow',provider:{kind:'mock'},egress:{mode:'deny'},limits:{deadlineMs:20000},features:{toolAssessment:true},audit:{}});
      ctx.tools.register(defineTool({name:'package_probe',description:'Synthetic package smoke',parameters:{note:{type:'string',description:'note',required:true}},output:{schema:{type:'object',properties:{note:{type:'string',required:true}},additionalProperties:false},render(_args,value){return[{type:'text',text:value.note}]}},async execute(args){bodyCalls++;return{note:args.note}}}));
      await ctx.tools.execute({callId:ToolCallId('package-call'),name:'package_probe',arguments:{note:'package-check'},signal:new AbortController().signal});
      assert.equal(bodyCalls,1);
      const rows=readFileSync(process.env.JEV_AUDIT_PATH,'utf8').trim().split('\\n').map(JSON.parse);
      assert.ok(rows.some(r=>r.kind==='decision'));
      assert.ok(rows.some(r=>r.kind==='execution' && r.status==='succeeded'));
      assert.ok(rows.some(r=>r.reasonCode==='mounted' || r.code==='mounted' || JSON.stringify(r).includes('mounted')));
    } finally { await ctx.fiber.dispose(); }
    console.log(JSON.stringify({rootImports:${report.archives.length},packageLocalSchema:true,configLoaded:true,canonicalAndLegacyPlugin:true,installedPluginToolCall:true,syntheticProvider:true}));
  `
  report.checks.push(JSON.parse(run('node', ['--input-type=module', '-e', probe], consumer)))
  report.passed = true
} catch (error) {
  report.error = String(error)
  process.exitCode = 1
} finally {
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ output, passed: report.passed, error: report.error }))
}
