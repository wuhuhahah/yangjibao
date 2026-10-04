'use strict';
const fs=require('node:fs'),path=require('node:path');
const C=require('./dashboard-core');
const A=require('./market-analysis');
const DIR=__dirname;
async function main() {
  const offline=process.argv.includes('--offline'), force=process.argv.includes('--force');
  const raw=C.readJSON(path.join(DIR,'yjb-data.json'),null),funds=C.normalize(raw).filter(f=>f.money>0);
  const total=funds.reduce((s,f)=>s+f.money,0);
  const source=C.readJSON(path.join(DIR,'sync-status.json'),{});
  // 沿用原项目人工分类，不执行旧 Python 脚本。
  const old=fs.readFileSync(path.join(DIR,'portfolio.py'),'utf8');
  const themeText=old.match(/THEME\s*=\s*\{([\s\S]*?)\n\}/)?.[1]||'';
  const themes=Object.fromEntries([...themeText.matchAll(/'([0-9]{6})':\s*'([^']+)'/g)].map(m=>[m[1],m[2]]));
  const overrides=C.readJSON(path.join(DIR,'settings.json'),{}).themes||{};
  funds.forEach(f=>{f.theme=overrides[f.code]||themes[f.code]||'待分类';f.weight=f.money/total;});
  const cacheFile=path.join(DIR,'market-cache.json'),cache=C.readJSON(cacheFile,{navs:{}});cache.navs||={};
  const legacy=C.readJSON(path.join(DIR,'nav_cache.json'),{}),client=new C.DataClient({stateFile:path.join(DIR,'fetch-state.json')});let failures=0;
  for(const f of funds) {
    const previous=cache.navs[f.code]||C.legacySeries(legacy,f.code);
    const sameDay=previous?.fetchedAt&&C.dateCN(previous.fetchedAt)===C.dateCN(Date.now())&&(Date.now()-Date.parse(previous.fetchedAt)<6*3600000);
    let entry=previous,status='缓存';
    if(!offline&&(!sameDay||force)) {
      try {
        entry=await client.get('https://fund.eastmoney.com/pingzhongdata/'+f.code+'.js',C.parseNAV);
        cache.navs[f.code]=entry;C.atomicJSON(cacheFile,cache);status='本次获取';failures=0;
      } catch(e) {status=previous?'获取失败，保留缓存':'获取失败，无历史';f.fetchError=e.message;failures++;if(failures>=3)client.blocked.set('fund.eastmoney.com','连续获取失败，等待下次刷新');}
    } else if(offline) status='离线缓存';
    f.history=entry?.series?.length?{...C.metrics(entry.series),method:entry.method,fetchedAt:entry.fetchedAt}:null;
    f.evaluation=entry?.evaluation||legacy['eval:'+f.code]||null;
    f.historyStatus=status;
    f.historyStale=!!f.history&&!!f.navDate&&f.history.end<f.navDate;
    if(entry) cache.navs[f.code]=entry;
    console.log(f.code+' '+status+(f.historyStale?'；历史截止 '+f.history.end:''));
  }
  const sectorsFile=path.join(DIR,'sector-cache.json');let sector=C.readJSON(sectorsFile,null);
  if(!sector?.rows?.length){sector=A.backupSectors(DIR);if(sector?.rows?.length)C.atomicJSON(sectorsFile,sector);}
  if(!offline&&(!sector?.fetchedAt||C.dateCN(sector.fetchedAt)!==C.dateCN(Date.now())||force)) {
    try {
      const rows=[];
      for(let page=1;page<=6;page++) {
        const u=new URL('https://push2delay.eastmoney.com/api/qt/clist/get');Object.entries({pn:page,pz:100,po:1,np:1,fltt:2,invt:2,fid:'f12',fs:'m:90 t:2',fields:'f12,f14,f9,f23'}).forEach(([k,v])=>u.searchParams.set(k,v));
        const data=await client.get(u.toString(),t=>{const d=JSON.parse(t).data?.diff;if(!Array.isArray(d)||!d.length)throw new Error('板块响应格式异常');return d;});
        rows.push(...data);if(data.length<100)break;
      }
      const positive=rows.map(r=>r.f9).filter(v=>typeof v==='number'&&v>0);
      const wanted=['半导体','软件开发','计算机设备','通信设备','游戏','光伏设备','电池','银行','保险','证券','电力','煤炭','贵金属'];
      const selected=rows.filter(r=>wanted.some(k=>r.f14.includes(k))).map(r=>({code:r.f12,name:r.f14,pe:C.num(r.f9),pb:C.num(r.f23),percentile:r.f9>0&&positive.length?positive.filter(v=>v<r.f9).length/positive.length*100:null,financial:/银行|保险|证券/.test(r.f14),theme:Object.entries(A.THEMES).find(([,keys])=>keys.some(k=>r.f14.includes(k)))?.[0]||'其他',percentileBasis:'全部正PE行业板块横截面'}));
      for(const row of selected.filter(r=>r.financial)){
        if(row.pb>0)continue;
        try{const u=new URL('https://push2delay.eastmoney.com/api/qt/clist/get');Object.entries({pn:1,pz:500,po:1,np:1,fltt:2,invt:2,fid:'f3',fs:'b:'+row.code,fields:'f23'}).forEach(([k,v])=>u.searchParams.set(k,v));const values=await client.get(u.toString(),t=>{const diff=JSON.parse(t).data?.diff;if(!Array.isArray(diff))throw new Error('成分股PB数据格式异常');return diff.map(r=>r.f23).filter(v=>typeof v==='number'&&v>0).sort((a,b)=>a-b);});if(values.length){row.pb=values[Math.floor(values.length/2)];row.pbBasis='本次返回的正PB成分股中位数（单页样本）';}}
        catch(e){const previous=sector?.rows?.find(r=>r.name===row.name);if(previous?.pb>0){row.pb=previous.pb;row.pbBasis='上次PB备份（非本次行情）';row.pbDate=sector.fetchedAt||sector.backupGeneratedAt;}else row.pbBasis='获取失败，无有效缓存';}
      }
      sector={fetchedAt:new Date().toISOString(),source:'东财行业板块',rows:selected};
      C.atomicJSON(sectorsFile,sector);
    }catch(e){sector=sector?{...sector,error:e.message}:{rows:[],error:e.message};console.log('板块数据回退：'+e.message);}
  }
  if(!offline)C.atomicJSON(cacheFile,cache);
  const history=C.snapshot(DIR,C.normalize(raw).filter(f=>f.money>0),raw.syncMeta);
  const prior=history.length>1?history.at(-2):null;
  const changes=C.changes(prior?.funds,funds);
  const port=C.portfolio(funds,cache.navs);
  port.dailyVolatility=A.dailyVolatility(funds,cache.navs);
  const indices=await A.loadIndices(DIR,legacy,client,{offline,force});
  const themeAnalysis=A.themeAnalysis(funds,sector),correlations=A.correlations(funds,cache.navs);
  const payload={generatedAt:new Date().toISOString(),offline,total,accountPnl:raw.syncMeta?.accountPnlOverride??null,funds,source,readAt:raw.syncMeta?.readAt||null,pluginAt:typeof raw.timeStamp==='number'?new Date(raw.timeStamp).toISOString():null,screenshotConfirmedAt:raw.syncMeta?.screenshotConfirmedAt||null,historyCount:history.length,previousAt:prior?.at||null,changes,port,duplicates:C.duplicateGroups(funds),sector,indices,themeAnalysis,correlations,events:client.events,themeBasis:'人工主题分类；不是完整底层持仓穿透',baseline:!prior};
  const safe=JSON.stringify(payload).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
  let html=fs.readFileSync(path.join(DIR,'dashboard.template.html'),'utf8').replace('__PAYLOAD__',safe);
  if(fs.existsSync(path.join(DIR,'runtime-ui.js')))html=html.replace('</body>','<script data-yjb-runtime>'+fs.readFileSync(path.join(DIR,'runtime-ui.js'),'utf8')+'</script></body>');
  const target=path.join(DIR,'持仓看板.html');fs.writeFileSync(target+'.tmp',html);fs.renameSync(target+'.tmp',target);
  const stale=funds.filter(f=>f.historyStale).length;
  const report='# 持仓核对报告\n\n生成：'+payload.generatedAt+'\n\n总持仓：'+total.toFixed(2)+' 元；'+funds.length+' 只。\n\n'+(stale?'有 '+stale+' 只基金历史净值早于持仓净值日期，历史模拟需谨慎使用。':'历史截止日期见看板明细。')+'\n\n'+(source.ok===false?'本次插件读取失败，使用上次有效持仓。\n\n':'')+'持仓浮动盈亏来自养基宝，不包括所有历史已实现收益。当前权重历史模拟不是个人实际收益。\n\n## 本次与上次有效快照的变化\n\n'+(prior?changes.map(c=>'- '+c.name+'：'+c.type+'；金额变化 '+c.delta.toFixed(2)+' 元').join('\n'):'首次建立基线，下一次有效同步开始比较。')+'\n\n金额变化不能直接认定为买卖；消失持仓应核对赎回与截图遗漏。\n';
  fs.writeFileSync(path.join(DIR,'持仓核对报告.md'),report);
  console.log('新版看板已生成；'+funds.length+'只持仓，'+stale+'只历史数据待更新。');
}
if(require.main===module)main().catch(e=>{console.error('生成失败，已保留上次看板：'+e.message);process.exitCode=1;});
module.exports={main};
