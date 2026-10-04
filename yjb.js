#!/usr/bin/env node
'use strict';
// 仅读取当前用户授权的本地插件数据，不启动、关闭或调试浏览器。
const fs=require('node:fs'),path=require('node:path');
const C=require('./dashboard-core');
const EXT_ID='lkfljjeajaekfbjfbbipopenjjebcphb';
const DIR=__dirname;
function varint(buf,p) {
  let n=0,shift=0;
  for(let i=0;i<5;i++){if(p>=buf.length)throw new Error('WriteBatch长度截断');const b=buf[p++];n+=(b&127)*2**shift;if(!(b&128))return [n,p];shift+=7;}
  throw new Error('WriteBatch长度异常');
}
function crc32c(buf) {let c=0xffffffff;for(const b of buf){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0x82f63b78:0);}return (c^0xffffffff)>>>0;}
function records(buf) {
  let p=0,parts=null;const out=[];
  while(p+7<=buf.length) {
    const remaining=32768-p%32768;
    if(remaining<7){p+=remaining;continue;}
    const expected=buf.readUInt32LE(p),len=buf.readUInt16LE(p+4),type=buf[p+6];
    if(type===0&&len===0){p+=remaining;continue;}
    if(len+7>remaining||p+7+len>buf.length)throw new Error('LevelDB记录未写完整，请稍后刷新');
    const crc=crc32c(buf.subarray(p+6,p+7+len));const masked=(((crc>>>15)|(crc<<17))+0xa282ead8)>>>0;
    if(masked!==expected)throw new Error('LevelDB校验失败，请稍后刷新');
    const fragment=buf.subarray(p+7,p+7+len);p+=7+len;
    if(type===1){if(parts)throw new Error('LevelDB分片不完整');out.push(fragment);}
    else if(type===2){if(parts)throw new Error('LevelDB分片顺序异常');parts=[fragment];}
    else if(type===3){if(!parts)throw new Error('LevelDB中间分片缺失');parts.push(fragment);}
    else if(type===4){if(!parts)throw new Error('LevelDB起始分片缺失');parts.push(fragment);out.push(Buffer.concat(parts));parts=null;}
    else throw new Error('LevelDB记录类型异常');
  }
  if(parts)throw new Error('LevelDB尾部分片尚未写完整');
  return out;
}
function batch(buf) {
  if(buf.length<12)throw new Error('WriteBatch头不完整');
  const seq=buf.readBigUInt64LE(0),count=buf.readUInt32LE(8);let p=12;const out=[];
  for(let i=0;i<count;i++) {
    const type=buf[p++];if(type!==0&&type!==1)throw new Error('未知WriteBatch类型');
    let len;[len,p]=varint(buf,p);if(p+len>buf.length)throw new Error('WriteBatch键截断');
    const key=buf.subarray(p,p+len).toString('utf8');p+=len;let value=null;
    if(type===1){[len,p]=varint(buf,p);if(p+len>buf.length)throw new Error('WriteBatch值截断');value=buf.subarray(p,p+len).toString('utf8');p+=len;}
    out.push({seq:seq+BigInt(i),key,value});
  }
  if(p!==buf.length)throw new Error('WriteBatch长度不一致');
  return out;
}
function readStorage(storage) {
  if(!fs.existsSync(storage))throw new Error('找不到插件存储目录；检查插件安装位置，其他Edge资料可设置YJB_EDGE_PROFILE');
  const files=fs.readdirSync(storage).filter(f=>/^\d+\.log$/.test(f));
  if(!files.length)throw new Error('没有可读取的日志；请打开养基宝插件完成同步后重试');
  const latest=new Map();
  for(const file of files)for(const record of records(fs.readFileSync(path.join(storage,file))))for(const item of batch(record)){if(!latest.has(item.key)||latest.get(item.key).seq<item.seq)latest.set(item.key,item);}
  const data={};for(const [key,item]of latest){if(item.value!==null){try{data[key]=JSON.parse(item.value);}catch{data[key]=item.value;}}}
  if(!data.fundList)throw new Error('日志不含完整fundList（可能已压缩入SST），请打开插件更新持仓后重试；不会覆盖旧数据');
  C.normalize(data);
  // fundList是整体替换的JSON值，可读取最新日志中的整份值；不声称还原了整个LevelDB。
  return data;
}
function profilePath(){
  if(process.env.YJB_EDGE_PROFILE)return process.env.YJB_EDGE_PROFILE;
  const base=path.join(process.env.LOCALAPPDATA||'','Microsoft','Edge','User Data');
  const profiles=fs.existsSync(base)?fs.readdirSync(base,{withFileTypes:true}).filter(e=>e.isDirectory()&&(e.name==='Default'||/^Profile \d+$/.test(e.name))).map(e=>path.join(base,e.name)).filter(p=>fs.existsSync(path.join(p,'Local Extension Settings',EXT_ID))):[];
  if(profiles.length===1)return profiles[0];
  if(profiles.length>1)throw new Error('多个Edge资料安装了养基宝，请在页面后台设置中选择使用的资料');
  return path.join(base,'Default');
}
async function once() {
  try {
    const storage=path.join(profilePath(),'Local Extension Settings',EXT_ID);
    const data=readStorage(storage),clean=C.sanitize(data,'Edge本地日志中的完整持仓值');
    const old=C.readJSON(path.join(DIR,'yjb-data.json'),null);
    if(old?.fundList){const a=C.normalize(old).filter(f=>f.money>0),b=C.normalize(clean).filter(f=>f.money>0);if(a.length>=5&&b.length<a.length*.5)throw new Error('持仓数量突然减少超过一半，需核对截图完整性；已保留旧数据');}
    C.snapshot(DIR,C.normalize(clean).filter(f=>f.money>0),clean.syncMeta);
    C.atomicJSON(path.join(DIR,'yjb-data.json'),clean);
    C.atomicJSON(path.join(DIR,'sync-status.json'),{ok:true,attemptAt:new Date().toISOString(),source:clean.syncMeta.source});
    console.log('同步成功：'+Object.keys(clean.fundList).length+'只基金。仅保存持仓白名单字段，未导出账号或登录凭证。');
  }catch(e){C.atomicJSON(path.join(DIR,'sync-status.json'),{ok:false,attemptAt:new Date().toISOString(),error:e.message});throw e;}
}
if(require.main===module)(async()=>{do{try{await once();}catch(e){console.error('同步失败：'+e.message);if(!process.argv.includes('--watch')){process.exitCode=1;return;}}if(process.argv.includes('--watch'))await new Promise(r=>setTimeout(r,60000));}while(process.argv.includes('--watch'));})().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={varint,crc32c,records,batch,readStorage,once,profilePath};
