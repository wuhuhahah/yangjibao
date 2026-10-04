'use strict';
const C=require('./dashboard-core');
(async()=>{let release;try{release=C.acquireRefreshLock(__dirname);try{await require('./yjb').once();}catch(e){console.error('持仓同步失败，使用上次有效数据：'+e.message);}await require('./dashboard').main();}catch(e){console.error(e.message);process.exitCode=1;}finally{if(release)release();}})();
