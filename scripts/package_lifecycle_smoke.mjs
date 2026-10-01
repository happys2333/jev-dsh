// Isolated npm reinstall/remove/restore probe. Not a real A→B release migration.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const root=process.cwd(), receipt=JSON.parse(readFileSync('artifacts/reconstruction_20260930_linux/packaging/smoke.json'));
const work=mkdtempSync(join(tmpdir(),'jev-lifecycle-')), consumer=join(work,'consumer'); mkdirSync(consumer);
const archiveDirs=readdirSync(tmpdir()).filter(p=>p.startsWith('jev-package-smoke-')).map(p=>join(tmpdir(),p,'archives'));
const paths=receipt.archives.map(a=>{for(const d of archiveDirs){const p=join(d,a.name+'-0.0.0.tgz');if(existsSync(p)&&createHash('sha256').update(readFileSync(p)).digest('hex')===a.sha256)return p;}throw Error('Exact final archive not available: '+a.name)});
const unrelated=join(work,'unrelated');mkdirSync(unrelated);writeFileSync(join(unrelated,'package.json'),JSON.stringify({name:'unrelated-test-plugin',version:'1.0.0',main:'index.js'}));writeFileSync(join(unrelated,'index.js'),'module.exports = "unrelated plugin intact";');
writeFileSync(join(consumer,'package.json'),JSON.stringify({name:'jev-lifecycle-consumer',private:true}));
const sentinelFiles=['session.json','host-config.json'];for(const name of sentinelFiles)writeFileSync(join(consumer,name),JSON.stringify({unrelated:true,synthetic:true,name}));
const before=Object.fromEntries(sentinelFiles.map(n=>[n,readFileSync(join(consumer,n),'utf8')]));
function run(args){const p=spawnSync('npm',args,{cwd:consumer,env:{...process.env,npm_config_cache:join(work,'cache')},encoding:'utf8',timeout:180000});if(p.status!==0)throw Error(p.stderr);}
function intact(){for(const n of sentinelFiles)if(readFileSync(join(consumer,n),'utf8')!==before[n])throw Error('Changed unrelated file');const p=spawnSync('node',['-e',`if(require('unrelated-test-plugin')!=='unrelated plugin intact') process.exit(1)`],{cwd:consumer});if(p.status!==0)throw Error('Unrelated plugin broken');}
const flags=['--ignore-scripts','--no-audit','--no-fund'];
run(['install',...flags,unrelated,...paths]);intact();
run(['install',...flags,...paths]);intact();
run(['uninstall',...flags,...receipt.archives.map(a=>a.name)]);intact();for(const a of receipt.archives)if(existsSync(join(consumer,'node_modules',a.name)))throw Error('Owned package remains');
run(['install',...flags,...paths]);intact();
const result={passed:true,scope:'same-build install/reinstall/uninstall/restore of all 7 packages, synthetic unrelated plugin/session/config preservation; NOT version upgrade or real host-session migration',archiveHashes:receipt.archives.map(({name,sha256})=>({name,sha256})),checks:['initial-install','idempotent-reinstall','owned-package-uninstall','same-build-restore','unrelated-plugin-preserved','synthetic-session-and-config-byte-identical']};
writeFileSync(resolve(root,'artifacts/reconstruction_20260930_linux/packaging/lifecycle-smoke.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
