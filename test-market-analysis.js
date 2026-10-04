const test=require('node:test'),assert=require('node:assert/strict'),A=require('./market-analysis');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
test('restores backup PE/PB with provenance and excludes negative PE percentile',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yjb-sector-test-'));
  try {
    const folder=path.join(dir,'backups','before-v2-20261003');fs.mkdirSync(folder,{recursive:true});
    fs.writeFileSync(path.join(folder,'持仓看板.html'),'<h2>板块估值</h2><table><tr><td>银行</td><td>6</td><td>0.8</td><td>20</td><td>PB</td><td>红利防御</td></tr><tr><td>示例行业</td><td>-2</td><td>1</td><td>80</td><td>PE</td><td>其他</td></tr></table>报告生成 2026-10-03 12:00:00');
    const s=A.backupSectors(dir);assert.equal(s.rows.length,2);assert.equal(s.rows.find(r=>r.name==='银行').pb,0.8);assert.equal(s.rows.find(r=>r.pe<0).percentile,null);assert.equal(s.fetchedAt,null);assert.equal(s.backupGeneratedAt,'2026-10-03 12:00:00');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('golden cross distinguishes current state from newly crossed event; volume is retained',()=>{const c=Array(61).fill(100);c[c.length-1]=130;const r=A.tech({c,v:[100,100,100,100,100,140]});assert.equal(r.cross,'金叉运行');assert.equal(r.event,'最近观测日新金叉');assert.equal(r.volumeRatio,1.4);assert.equal(r.volumeTag,'放量');});
test('death cross and no volume are explicit',()=>{const c=Array(61).fill(100);c[c.length-1]=70;const r=A.tech({c,v:[]});assert.equal(r.cross,'死叉运行');assert.equal(r.event,'最近观测日新死叉');assert.equal(r.volumeRatio,null);assert.equal(r.volumeTag,'无量能数据');});
test('financial PE percentile is not misused as PB quadrant',()=>{const f=[{theme:'保险',money:100,weight:1,history:{ann:.1,momentum:.2}}];const a=A.themeAnalysis(f,{rows:[{name:'保险',theme:'保险',pe:5,pb:1,financial:true,percentile:10}]});assert.equal(a[0].percentile,null);assert.equal(a[0].financialOnly,true);});
test('historical sector data drives quadrant with timestamp',()=>{const a=A.themeAnalysis([{theme:'半导体',money:100,weight:1,history:{ann:.1,momentum:-.1}}],{source:'备份',backupGeneratedAt:'2026-10-03',rows:[{name:'半导体',pe:70,percentile:85}]});assert.equal(a[0].quadrant,'高位 + 弱动量');assert.equal(a[0].valuationDate,'2026-10-03');});
test('correlation uses common returns and exact same path gives 1',()=>{const series=Array.from({length:80},(_,i)=>[new Date(Date.UTC(2026,0,i+1)).toISOString().slice(0,10),1+i*.01+Math.sin(i)*.01]);const f=[{code:'a',name:'A',money:100},{code:'b',name:'B',money:100}];const p=A.correlations(f,{a:{series},b:{series}});assert.equal(p.length,1);assert.ok(Math.abs(p[0].correlation-1)<1e-10);assert.equal(p[0].count,79);assert.ok(A.dailyVolatility(f,{a:{series},b:{series}}).value>0);});
