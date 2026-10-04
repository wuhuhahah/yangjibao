'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dateCN = value => new Date(value).toLocaleDateString('sv-SE', {timeZone:'Asia/Shanghai'});
const num = value => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
function readJSON(file, fallback) { if (!fs.existsSync(file)) return fallback; return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/,'')); }
function atomicJSON(file, value) { const tmp = file + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(value,null,2)); fs.renameSync(tmp,file); }
function acquireRefreshLock(dir){
  const file=path.join(dir,'refresh.lock'),id=crypto.randomBytes(12).toString('hex');
  for(let attempt=0;attempt<2;attempt++){
    try{const fd=fs.openSync(file,'wx');fs.writeFileSync(fd,JSON.stringify({pid:process.pid,id}));fs.closeSync(fd);return ()=>{try{if(readJSON(file,{}).id===id)fs.unlinkSync(file);}catch{}};}
    catch(e){if(e.code!=='EEXIST')throw e;let saved;try{saved=readJSON(file,{});}catch{throw new Error('已有刷新正在开始，请稍后再试');}if(!Number.isInteger(saved.pid)||saved.pid<=0)throw new Error('刷新锁格式异常，请检查refresh.lock');try{process.kill(saved.pid,0);throw new Error('已有后台或定时刷新正在进行');}catch(check){if(check.code!=='ESRCH')throw check;}try{fs.unlinkSync(file);}catch{};}
  }
  throw new Error('已有其他刷新任务，请稍后重试');
}
function normalize(data) {
  if (!data || !data.fundList || typeof data.fundList !== 'object') throw new Error('缺少完整持仓，已保留上次有效数据');
  const seen = new Set();
  const funds = Object.values(data.fundList).map(f => {
    const money = num(f.money ?? f.hold_sum), share = num(f.hold_share);
    if (!/^\d{6}$/.test(f.code) || money === null || money < 0 || !f.short_name || seen.has(f.code)) throw new Error('持仓格式异常或基金代码重复，已保留上次有效数据');
    seen.add(f.code);
    return {code:f.code,name:f.short_name,money,share,cost:num(f.hold_cost),pnl:num(f.content?.earn?.hold_earn),pnlRate:num(f.content?.earn?.hold_earn_rate),dayPnl:num(f.content?.curr_earn),nav:num(f.content?.last_nv?.dwjz ?? f.nv_info?.dwjz),navDate:f.content?.last_nv?.net_time ?? f.nv_info?.jzrq ?? null};
  });
  if (!funds.length) throw new Error('插件返回空持仓，需核对后手动处理，已保留上次有效数据');
  return funds;
}
function sanitize(data, source) {
  normalize(data);
  const fundList=Object.fromEntries(Object.values(data.fundList).map(f=>[f.code,{code:f.code,short_name:f.short_name,money:f.money??f.hold_sum,hold_share:f.hold_share,hold_cost:f.hold_cost,content:{curr_earn:f.content?.curr_earn,earn:{hold_earn:f.content?.earn?.hold_earn,hold_earn_rate:f.content?.earn?.hold_earn_rate},last_nv:{dwjz:f.content?.last_nv?.dwjz??f.nv_info?.dwjz,net_time:f.content?.last_nv?.net_time??f.nv_info?.jzrq}}}]));
  return {fundList,timeStamp:data.timeStamp ?? null,syncMeta:{readAt:new Date().toISOString(),source,sourceTimestampMeaning:'插件存储时间；不能证明支付宝截图日期',screenshotConfirmedAt:null}};
}
function snapshot(dir, funds, meta) {
  const file = path.join(dir,'持仓历史.json'); const history = readJSON(file, []);
  const sorted = [...funds].sort((a,b)=>a.code.localeCompare(b.code));
  const hash = crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
  if (history.at(-1)?.hash !== hash) {
    history.push({at:meta?.readAt ?? new Date().toISOString(),hash,funds:sorted});
    atomicJSON(file,history); // 完整保留历史，不按天覆盖
  }
  return history;
}
function changes(before, after) {
  if (!before) return [];
  const a=new Map(before.map(f=>[f.code,f])),b=new Map(after.map(f=>[f.code,f])); const rows=[];
  for(const code of new Set([...a.keys(),...b.keys()])) {
    const old=a.get(code),now=b.get(code);
    if(!old||!now) rows.push({code,name:(now||old).name,type:now?'新增持仓':'持仓消失（待核对）',delta:(now?.money||0)-(old?.money||0),shareDelta:null});
    else if(Math.abs(now.money-old.money)>0.01 || now.share!==old.share) rows.push({code,name:now.name,type:now.share!==old.share?'份额变化（待核对）':'金额变化',delta:now.money-old.money,shareDelta:now.share!==null&&old.share!==null?now.share-old.share:null});
  }
  return rows;
}
class DataClient {
  constructor({fetcher=fetch,wait=sleep,interval=1600,attempts=3,timeout=12000,stateFile=null}={}) {Object.assign(this,{fetcher,wait,interval,attempts,timeout,stateFile});this.last=0;this.blocked=new Map();this.events=[];this.cooldowns=stateFile?readJSON(stateFile,{}):{};}
  pause(host,reason,ms=30*60000){this.blocked.set(host,reason);this.cooldowns[host]={until:Date.now()+ms,reason};if(this.stateFile)atomicJSON(this.stateFile,this.cooldowns);}
  async get(url,parse) {
    const host=new URL(url).host;
    if(this.cooldowns[host]?.until>Date.now())throw new Error('数据源冷却中：'+this.cooldowns[host].reason);
    if(this.blocked.has(host)) throw new Error('数据源已暂停：'+this.blocked.get(host));
    for(let i=0;i<this.attempts;i++) {
      await this.wait(Math.max(0,this.interval-(Date.now()-this.last))); this.last=Date.now();
      try {
        const r=await this.fetcher(url,{headers:{'User-Agent':'Mozilla/5.0','Referer':'https://fund.eastmoney.com/'},signal:AbortSignal.timeout(this.timeout)});
        if(r.status===403||r.status===401||r.status===429) {
          const reason='HTTP '+r.status+(r.headers.get('retry-after')?'，Retry-After '+r.headers.get('retry-after'):'');
          const raw=r.headers.get('retry-after'),waitMs=raw?(Number.isFinite(Number(raw))?Number(raw)*1000:Date.parse(raw)-Date.now()):0;
          this.pause(host,reason,Math.max(30*60000,waitMs||0)); throw Object.assign(new Error(reason),{stop:true});
        }
        if(!r.ok) throw Object.assign(new Error('HTTP '+r.status),{stop:r.status<500});
        const text=await r.text();
        if(/<html|captcha|访问验证|安全验证/i.test(text.slice(0,1500))) {this.pause(host,'返回验证页面');throw Object.assign(new Error('返回验证页面'),{stop:true});}
        return parse(text);
      } catch(e) {
        this.events.push({host,attempt:i+1,error:e.message});
        if(e.stop||i===this.attempts-1){if(!this.blocked.has(host))this.pause(host,e.message);throw e;}
        await this.wait(1500*2**i+Math.floor(Math.random()*400));
      }
    }
  }
}
function parseNAV(text) {
  const match=text.match(/Data_netWorthTrend\s*=\s*(\[.*?\]);/s);
  if(!match) throw new Error('净值字段缺失；未覆盖缓存');
  const points=JSON.parse(match[1]); let value=1,prev=null; const series=[];
  for(const p of points) {
    if(!(p.y>0)||!Number.isFinite(p.x)) continue;
    let dividend=0,split=1;
    if(p.unitMoney) {
      const d=String(p.unitMoney).match(/(?:派现金|现金红利)\s*([\d.]+)\s*元/);
      const s=String(p.unitMoney).match(/(?:折算|拆分).*?(?:每份|比例[:：]?)\s*([\d.]+)/);
      if(d) dividend=Number(d[1]);
      else if(s) split=Number(s[1]);
      else throw new Error('未识别的分红/折算事件，保留缓存等待核对');
    }
    if(prev!==null) value*= (p.y*split+dividend)/prev;
    series.push([dateCN(p.x),value]); prev=p.y;
  }
  if(series.length<30) throw new Error('有效历史少于30条');
  const evaluationMatch=text.match(/Data_performanceEvaluation\s*=\s*(\{.*?\});/s);
  let evaluation=null;if(evaluationMatch){try{const e=JSON.parse(evaluationMatch[1]);evaluation={avr:num(e.avr),detail:Object.fromEntries((e.categories||[]).map((k,i)=>[k,e.data?.[i]])),fetchedAt:new Date().toISOString()};}catch{}}
  return {series:series.slice(-251),method:'分红再投资净值（识别现金分红与份额折算）',fetchedAt:new Date().toISOString(),evaluation};
}
function legacySeries(cache,code) {
  if(!cache[code]) return null;
  const series=Object.entries(cache[code]).map(([date,v])=>[dateCN(Date.parse(date.replace(' ','T')+'Z')),num(v)]).filter(x=>x[1]>0).sort((a,b)=>a[0].localeCompare(b[0]));
  return series.length?{series,method:'旧版累计净值近似（非严格分红再投资）',fetchedAt:null}:null;
}
function metrics(series) {
  if(!series||series.length<31) return null;
  const rs=series.slice(1).map((p,i)=>p[1]/series[i][1]-1);const mean=rs.reduce((a,b)=>a+b,0)/rs.length;
  const vol=Math.sqrt(rs.reduce((a,b)=>a+(b-mean)**2,0)/(rs.length-1))*Math.sqrt(250);
  let peak=series[0][1],mdd=0;for(const [,v] of series){peak=Math.max(peak,v);mdd=Math.min(mdd,v/peak-1);}
  const days=(Date.parse(series.at(-1)[0])-Date.parse(series[0][0]))/86400000;
  return {start:series[0][0],end:series.at(-1)[0],count:series.length,return:series.at(-1)[1]/series[0][1]-1,ann:days>0?(series.at(-1)[1]/series[0][1])**(365.25/days)-1:null,vol,mdd,momentum:series.length>61?series.at(-1)[1]/series.at(-61)[1]-1:null};
}
function portfolio(funds,navs) {
  const eligible=funds.filter(f=>f.money>0&&navs[f.code]?.series.length>=31);
  const total=funds.reduce((s,f)=>s+f.money,0),covered=eligible.reduce((s,f)=>s+f.money,0);
  if(!eligible.length||!total) return {coverage:0,curve:[],stats:null};
  const dates=eligible.map(f=>new Map(navs[f.code].series));
  const common=[...dates[0].keys()].filter(d=>dates.every(m=>m.has(d))).sort();
  if(common.length<31) return {coverage:covered/total,curve:[],stats:null};
  let value=1;const curve=[[common[0],value]];
  for(let i=1;i<common.length;i++) {const r=eligible.reduce((s,f,j)=>s+f.money/covered*(dates[j].get(common[i])/dates[j].get(common[i-1])-1),0);value*=1+r;curve.push([common[i],value]);}
  // 共同净值日期之间可能跨多日，不能当作每天收益计算年化波动。
  const stats=metrics(curve);stats.vol=null;
  return {coverage:covered/total,curve,stats,approximate:eligible.some(f=>navs[f.code].method.startsWith('旧版')),note:'当前金额权重、每个共同观测点再平衡；覆盖部分归一化。非个人实际收益，不含交易费用。'};
}
function duplicateGroups(funds) {
  const groups=new Map();
  for(const f of funds) {const key=f.name.replace(/[AC]\s*$/i,'').replace(/（[AC]类?）/g,'');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(f);}
  return [...groups.entries()].filter(([,g])=>g.length>1).map(([name,g])=>({name,codes:g.map(f=>f.code),money:g.reduce((s,f)=>s+f.money,0),basis:'名称去除A/C后相同，需核对产品信息；仅合并展示'}));
}
module.exports={readJSON,atomicJSON,acquireRefreshLock,normalize,sanitize,snapshot,changes,DataClient,parseNAV,legacySeries,metrics,portfolio,duplicateGroups,dateCN,num};
