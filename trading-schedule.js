'use strict';
const calendar=require('./trading-calendar.json');
const SHIFT=8*3600000,DAY=86400000,SESSIONS=[[570,690],[780,900]];
function localParts(time){const d=new Date(Number(time)+SHIFT);return {day:d.toISOString().slice(0,10),year:d.getUTCFullYear(),weekday:d.getUTCDay(),minute:d.getUTCHours()*60+d.getUTCMinutes(),midnight:Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())-SHIFT};}
function tradingDay(time,data=calendar){const p=localParts(time),ranges=data.years?.[p.year];return !!ranges&&p.weekday!==0&&p.weekday!==6&&!ranges.some(([start,end])=>p.day>=start&&p.day<=end);}
function isTradingTime(time=Date.now(),data=calendar){const p=localParts(time);return tradingDay(time,data)&&SESSIONS.some(([start,end])=>p.minute>=start&&p.minute<end);}
function scheduleStatus(time=Date.now(),data=calendar){const p=localParts(time);if(!data.years?.[p.year])return '休市日历未配置，自动刷新暂停';if(!tradingDay(time,data))return '休市日，自动刷新暂停';if(isTradingTime(time,data))return '开盘时段，自动刷新已启用';if(p.minute>=690&&p.minute<780)return '午休，自动刷新暂停';return '非开盘时段，自动刷新暂停';}
function nextRefreshTime(time,minutes,{data=calendar,delayMs=null}={}){
  if(!minutes)return null;
  const candidate=isTradingTime(time,data)?Number(time)+(delayMs??minutes*60000):Number(time);
  const base=localParts(candidate).midnight;
  for(let i=0;i<370;i++){
    const midnight=base+i*DAY;
    if(!data.years?.[localParts(midnight).year])return null;
    if(!tradingDay(midnight,data))continue;
    for(const [start,end]of SESSIONS){const opening=midnight+start*60000,closing=midnight+end*60000;const due=Math.max(candidate,opening);if(due<closing)return due;}
  }
  return null;
}
module.exports={isTradingTime,nextRefreshTime,scheduleStatus,tradingDay};
