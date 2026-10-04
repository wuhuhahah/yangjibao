'use strict';
const fs=require('node:fs'),path=require('node:path'),C=require('./dashboard-core');
const THEMES={'半导体':['半导体'],'AI科技':['软件开发','计算机设备','通信设备','互联网','游戏'],'新能源':['光伏设备','电池','能源金属'],'公用事业':['电力'],'保险':['保险'],'券商保险':['证券'],'黄金':['贵金属'],'红利防御':['银行','煤炭']};
const INDEX={'1.000688':'科创50','0.399006':'创业板指','1.000300':'沪深300','1.000922':'中证红利','fund:012349':'恒生科技','100.NDX':'纳斯达克100','fund:539003':'富时100'};
function text(s){return s.replace(/<[^>]*>/g,'').replace(/&[^;]+;/g,' ').trim();}
function backupSectors(dir){
  const file=path.join(dir,'backups','before-v2-20261003','持仓看板.html');if(!fs.existsSync(file))return null;
  const html=fs.readFileSync(file,'utf8'),section=html.match(/<h2>板块估值[\s\S]*?<table>([\s\S]*?)<\/table>/);
  if(!section)return null;
  const rows=[...section[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].flatMap(m=>{const cells=[...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(x=>text(x[1]));if(cells.length<6)return [];const pe=C.num(cells[1]);return [{name:cells[0],pe,pb:C.num(cells[2]),percentile:pe>0?C.num(cells[3]):null,financial:cells[4]==='PB',theme:cells[5],percentileBasis:'备份中的旧版PE横截面口径'}];});
  return {rows,fetchedAt:null,backupGeneratedAt:html.match(/报告生成 ([\d-]+ [\d:]+)/)?.[1]||null,source:'改造前看板备份',warning:'备份值仅供回看，原始行情截止日期未记录；不代表本次获取'};
}
function tech(entry){
  const c=entry.c||[],v=entry.v||[];if(c.length<60)return {cross:'数据不足',position:'—',volumeRatio:null,volumeTag:'无量能数据'};
  const avg=a=>a.reduce((s,n)=>s+n,0)/a.length,ma20=avg(c.slice(-20)),ma60=avg(c.slice(-60));
  const prev20=c.length>60?avg(c.slice(-21,-1)):null,prev60=c.length>60?avg(c.slice(-61,-1)):null;
  const ratio=v.length>=6&&avg(v.slice(-6,-1))>0?v.at(-1)/avg(v.slice(-6,-1)):null;
  return {ma20,ma60,cross:ma20>ma60?'金叉运行':ma20<ma60?'死叉运行':'均线持平',event:prev20!==null&&prev60!==null?(prev20<=prev60&&ma20>ma60?'最近观测日新金叉':prev20>=prev60&&ma20<ma60?'最近观测日新死叉':'无新交叉'):'无法判断新交叉',position:c.at(-1)>ma20?'线上':'线下',volumeRatio:ratio,volumeTag:ratio===null?'无量能数据':ratio>1.2?'放量':ratio<.8?'缩量':'量能平'};
}
function parseIndex(data){
  const rows=data?.data?.klines;if(!Array.isArray(rows)||rows.length<60)throw new Error('指数历史数据不完整');
  const points=rows.map(r=>r.split(',')).filter(r=>Number(r[1])>0).slice(-1250);
  const close=points.map(r=>Number(r[1]));if(close.length<60)throw new Error('指数有效数据不足');
  return {d:C.dateCN(Date.now()),lastDate:points.at(-1)[0],p:close.filter(v=>v<close.at(-1)).length/close.length*100,c:close.slice(-80),v:points.slice(-12).map(r=>Number(r[2])),sample:close.length,source:'东财指数日K'};
}
async function loadIndices(dir,legacy,client,{offline=false,force=false}={}){
  const file=path.join(dir,'index-cache.json'),cache=C.readJSON(file,{}),today=C.dateCN(Date.now());const out=[];
  for(const [code,name]of Object.entries(INDEX)){
    let entry=cache[code]||legacy['idx:'+code],error=null;
    if(!offline&&(!entry||entry.d!==today||force)){
      try{
        if(code.startsWith('fund:')){
          entry=await client.get('https://fund.eastmoney.com/pingzhongdata/'+code.slice(5)+'.js',t=>{const m=t.match(/Data_ACWorthTrend\s*=\s*(\[.*?\]);/s);if(!m)throw new Error('代理基金历史字段缺失');const a=JSON.parse(m[1]).filter(p=>p[1]>0).slice(-1250);if(a.length<60)throw new Error('代理基金历史不足');const c=a.map(p=>p[1]);return {d:today,lastDate:C.dateCN(a.at(-1)[0]),p:c.filter(v=>v<c.at(-1)).length/c.length*100,c:c.slice(-80),v:[],sample:c.length,source:'联接基金累计净值代理（含汇率和费用影响）'};});
        }else{
          const u=new URL('https://push2his.eastmoney.com/api/qt/stock/kline/get');Object.entries({secid:code,fields1:'f1,f2,f3',fields2:'f51,f53,f56',klt:101,fqt:0,beg:'20210101',end:'20500101'}).forEach(([k,v])=>u.searchParams.set(k,v));
          try{entry=await client.get(u.toString(),t=>parseIndex(JSON.parse(t)));}catch(e){client.blocked.set(u.host,'指数请求失败，本轮使用上次缓存');throw e;}
        }
        cache[code]=entry;C.atomicJSON(file,cache);
      }catch(e){error=e.message;}
    }
    if(!entry){out.push({code,name,error:error||'暂无缓存',cross:'数据不足',position:'—',volumeTag:'无量能数据'});continue;}
    out.push({code,name,date:entry.d,lastDate:entry.lastDate||null,percentile:entry.p,sample:entry.sample||null,proxy:code.startsWith('fund:'),source:entry.source||'原版指数缓存',error,...tech(entry)});
  }
  return out;
}
function median(a){if(!a.length)return null;const v=[...a].sort((a,b)=>a-b),i=Math.floor(v.length/2);return v.length%2?v[i]:(v[i-1]+v[i])/2;}
function themeAnalysis(funds,sector){
  const groups=new Map();for(const f of funds){if(!groups.has(f.theme))groups.set(f.theme,[]);groups.get(f.theme).push(f);}
  return [...groups.entries()].map(([theme,g])=>{
    const money=g.reduce((s,f)=>s+f.money,0), valid=g.filter(f=>f.history?.ann!=null),mom=g.filter(f=>f.history?.momentum!=null);
    const annAmount=valid.reduce((s,f)=>s+f.money,0),momAmount=mom.reduce((s,f)=>s+f.money,0);
    const ann=annAmount?valid.reduce((s,f)=>s+f.history.ann*f.money,0)/annAmount:null,momentum=momAmount?mom.reduce((s,f)=>s+f.history.momentum*f.money,0)/momAmount:null;
    const rows=(sector?.rows||[]).filter(r=>r.theme===theme||THEMES[theme]?.some(k=>r.name.includes(k)));
    const eligible=rows.filter(r=>!r.financial&&r.pe>0&&r.percentile!=null),percentile=median(eligible.map(r=>r.percentile));
    const quadrant=percentile==null||momentum==null?'缺少可比估值/动量':percentile>70?(momentum>0?'高位 + 强动量':'高位 + 弱动量'):percentile<30?(momentum>0?'低位 + 强动量':'低位 + 弱动量'):'中性估值位置';
    const action=percentile==null?'核对数据与仓位规则':percentile>70?(momentum>0?'检查新增资金与仓位上限':'检查减仓计划与费用'):percentile<30?(momentum>0?'检查分批计划与风险预算':'观察拐点，核对基本面'):'按原计划复核';
    return {theme,money,weight:g.reduce((s,f)=>s+f.weight,0),ann,momentum,coverage:annAmount/money,momentumCoverage:momAmount/money,percentile,quadrant,action,valuationSource:sector?.source||'当前行业板块横截面',valuationDate:sector?.fetchedAt||sector?.backupGeneratedAt||null,financialOnly:rows.length>0&&eligible.length===0};
  }).sort((a,b)=>b.money-a.money);
}
function correlations(funds,navs){
  const out=[];
  for(let i=0;i<funds.length;i++)for(let j=i+1;j<funds.length;j++){
    const a=funds[i],b=funds[j],sa=navs[a.code]?.series,sb=navs[b.code]?.series;if(!sa||!sb)continue;
    const mb=new Map(sb),common=sa.filter(p=>mb.has(p[0]));if(common.length<62)continue;
    const x=[],y=[];for(let k=1;k<common.length;k++){x.push(common[k][1]/common[k-1][1]-1);y.push(mb.get(common[k][0])/mb.get(common[k-1][0])-1);}
    const avg=v=>v.reduce((s,n)=>s+n,0)/v.length,mx=avg(x),my=avg(y);let cov=0,vx=0,vy=0;for(let k=0;k<x.length;k++){cov+=(x[k]-mx)*(y[k]-my);vx+=(x[k]-mx)**2;vy+=(y[k]-my)**2;}const r=vx&&vy?cov/Math.sqrt(vx*vy):null;
    if(r>.85)out.push({a:a.name,b:b.name,codes:[a.code,b.code],correlation:r,money:a.money+b.money,count:x.length,start:common[0][0],end:common.at(-1)[0]});
  }
  return out.sort((a,b)=>b.correlation-a.correlation);
}
function dailyVolatility(funds,navs){
  const eligible=funds.filter(f=>f.money>0&&navs[f.code]?.series.length>=31);if(!eligible.length)return null;
  const series=eligible.map(f=>navs[f.code].series);
  const start=series.map(s=>s[0][0]).sort().at(-1),end=series.map(s=>s.at(-1)[0]).sort()[0];
  const dates=[...new Set(series.flatMap(s=>s.map(p=>p[0])))].filter(d=>d>=start&&d<=end).sort();if(dates.length<31)return null;
  const amount=eligible.reduce((s,f)=>s+f.money,0),cursor=series.map(()=>0);let previous=null;const returns=[];
  for(const date of dates){const values=series.map((s,j)=>{while(cursor[j]+1<s.length&&s[cursor[j]+1][0]<=date)cursor[j]++;return s[cursor[j]][1];});if(previous)returns.push(values.reduce((sum,v,j)=>sum+eligible[j].money/amount*(v/previous[j]-1),0));previous=values;}
  const mean=returns.reduce((s,v)=>s+v,0)/returns.length;
  return {value:Math.sqrt(returns.reduce((s,v)=>s+(v-mean)**2,0)/(returns.length-1))*Math.sqrt(250),start,end,count:returns.length,coverage:amount/funds.reduce((s,f)=>s+f.money,0),method:'共同历史区间按净值观测日对齐；缺失日沿用此前已公布值，年化系数√250，跨市场非同步行情的近似'};
}
module.exports={backupSectors,tech,parseIndex,loadIndices,themeAnalysis,correlations,dailyVolatility,THEMES};
