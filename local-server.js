'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const C=require('./dashboard-core');
const T=require('./trading-schedule');
const APP='yangjibao-local-v1',EXT='lkfljjeajaekfbjfbbipopenjjebcphb';
function findProfiles(){const base=path.join(process.env.LOCALAPPDATA||'','Microsoft','Edge','User Data');if(!fs.existsSync(base))return [];return fs.readdirSync(base,{withFileTypes:true}).filter(e=>e.isDirectory()&&(e.name==='Default'||/^Profile \d+$/.test(e.name))).filter(e=>fs.existsSync(path.join(base,e.name,'Local Extension Settings',EXT))).map(e=>({name:e.name,path:path.join(base,e.name)}));}
function validateConfig(value,old={refreshMinutes:30,edgeProfile:''}){const refreshMinutes=Number(value.refreshMinutes??old.refreshMinutes);if(![0,10,30,60,120].includes(refreshMinutes))throw new Error('刷新间隔只能选择关闭、10、30、60或120分钟');const edgeProfile=value.edgeProfile??old.edgeProfile;if(typeof edgeProfile!=='string'||edgeProfile.length>1000)throw new Error('Edge资料路径无效');if(edgeProfile&&!findProfiles().some(p=>p.path===edgeProfile))throw new Error('请选择检测到的养基宝Edge资料');return {refreshMinutes,edgeProfile};}
function createApp({dir=__dirname,runStep,intervalMs=null,startupRefresh=true,now=Date.now}={}){
  const configFile=path.join(dir,'desktop-settings.json'),token=crypto.randomBytes(24).toString('hex'),rootId=crypto.createHash('sha256').update(dir.toLowerCase()).digest('hex');
  let config=C.readJSON(configFile,{refreshMinutes:30,edgeProfile:''});try{config=validateConfig(config);}catch{config={refreshMinutes:30,edgeProfile:''};}
  let timer=null,activeChild=null,closed=false;
  const state={app:APP,rootId,busy:false,phase:'等待刷新',version:fs.existsSync(path.join(dir,'持仓看板.html'))?'saved':'empty',lastStarted:null,lastFinished:null,lastResult:null,nextAt:null,config};
  const logFile=path.join(dir,'后台刷新.log');
  function log(line){fs.appendFileSync(logFile,new Date().toISOString()+' '+line+'\n');if(fs.statSync(logFile).size>2e6)fs.renameSync(logFile,logFile+'.previous');}
  const step=runStep||((file,args=[])=>new Promise(resolve=>{
    const env={...process.env};if(config.edgeProfile)env.YJB_EDGE_PROFILE=config.edgeProfile;
    const child=spawn(process.execPath,[path.join(dir,file),...args],{cwd:dir,env,windowsHide:true,stdio:['ignore','pipe','pipe']});activeChild=child;let lastLine='';
    child.stdout.on('data',d=>{const lines=d.toString('utf8').trim().split(/\r?\n/);lastLine=lines.at(-1)||lastLine;state.phase=lastLine;log(lines.join(' | '));});
    child.stderr.on('data',d=>{lastLine=d.toString('utf8').trim();log(lastLine);});
    const deadline=setTimeout(()=>{lastLine='刷新超过8分钟，已停止本次任务';child.kill();},8*60*1000);
    child.on('error',e=>{clearTimeout(deadline);activeChild=null;resolve({ok:false,message:e.message});});
    child.on('close',code=>{clearTimeout(deadline);activeChild=null;resolve({ok:code===0,message:lastLine});});
  }));
  function schedule(){clearTimeout(timer);state.nextAt=null;if(closed||!config.refreshMinutes||state.busy)return;const due=T.nextRefreshTime(now(),config.refreshMinutes,{delayMs:intervalMs});if(due===null)return;state.nextAt=new Date(due).toISOString();timer=setTimeout(()=>{if(config.refreshMinutes&&T.isTradingTime(now()))refresh('定时刷新');else schedule();},Math.max(1,due-now()));}
  async function refresh(reason){
    if(state.busy||closed)return false;state.busy=true;clearTimeout(timer);state.nextAt=null;state.lastStarted=new Date().toISOString();state.phase='正在读取Edge插件';
    let sync={ok:false},report={ok:false},release=null;
    try{release=C.acquireRefreshLock(dir);log(reason+'开始');sync=await step('yjb.js');if(!closed){state.phase='正在更新净值并生成看板';report=await step('dashboard.js');}state.lastResult={ok:sync.ok&&report.ok,holdingOK:sync.ok,reportOK:report.ok,message:report.ok?(sync.ok?'持仓与看板已更新':'插件读取失败，已用上次有效持仓生成看板'):(report.message||'看板生成失败，请查看同步状态')};}
    catch(e){state.lastResult={ok:false,message:e.message};log(e.message);}
    finally{if(release)release();state.busy=false;state.lastFinished=new Date().toISOString();state.phase=state.lastResult.message;if(report.ok)state.version=crypto.randomBytes(8).toString('hex');schedule();}
    return true;
  }
  const send=(res,code,value,type='application/json; charset=utf-8')=>{res.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(type.startsWith('application/json')?JSON.stringify(value):value);};
  const server=http.createServer(async(req,res)=>{
    const expected='127.0.0.1:'+server.address().port;
    if(req.headers.host!==expected)return send(res,403,{error:'仅允许本机地址'});
    const route=new URL(req.url,'http://'+expected).pathname;
    if(req.method==='OPTIONS')return send(res,403,{error:'不允许跨域调用'});
    if(req.method==='POST'){
      if(req.headers.origin!=='http://'+expected||req.headers['x-yjb-token']!==token)return send(res,403,{error:'请求来源不匹配，请重新打开看板'});
      let body='';try{for await(const chunk of req){body+=chunk;if(body.length>10000)throw new Error('请求过大');}const input=body?JSON.parse(body):{};
        if(route==='/api/refresh'){if(state.busy)return send(res,409,{error:'已有刷新正在进行'});void refresh('手动后台刷新');return send(res,202,{started:true});}
        if(route==='/api/config'){config=validateConfig(input,config);C.atomicJSON(configFile,config);state.config=config;schedule();return send(res,200,{config});}
        if(route==='/api/stop'){send(res,200,{stopped:true});setTimeout(()=>close(),50);return;}
        return send(res,404,{error:'没有此操作'});
      }catch(e){return send(res,400,{error:e.message});}
    }
    if(req.method!=='GET')return send(res,405,{error:'不支持此请求'});
    if(route==='/api/status')return send(res,200,{...state,tradingNow:T.isTradingTime(now()),scheduleStatus:config.refreshMinutes?T.scheduleStatus(now()):'自动刷新已关闭',profiles:findProfiles()});
    if(route==='/runtime-ui.js')return send(res,200,fs.readFileSync(path.join(dir,'runtime-ui.js'),'utf8'),'text/javascript; charset=utf-8');
    if(route==='/'){
      const file=path.join(dir,'持仓看板.html');let html=fs.existsSync(file)?fs.readFileSync(file,'utf8'):fs.readFileSync(path.join(dir,'welcome.html'),'utf8');
      html=html.replace('</head>','<meta name="yjb-token" content="'+token+'"></head>');if(!html.includes('data-yjb-runtime'))html=html.replace('</body>','<script src="/runtime-ui.js"></script></body>');return send(res,200,html,'text/html; charset=utf-8');
    }
    return send(res,404,{error:'没有此页面'});
  });
  async function close(){closed=true;clearTimeout(timer);if(activeChild)activeChild.kill();await new Promise(resolve=>server.close(resolve));}
  async function listen(port=8787){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});schedule();if(startupRefresh&&config.refreshMinutes&&T.isTradingTime(now()))setTimeout(()=>{if(!closed&&config.refreshMinutes&&T.isTradingTime(now()))refresh('启动时刷新');},100);return 'http://127.0.0.1:'+server.address().port+'/';}
  return {server,state,refresh,listen,close,rootId};
}
function openBrowser(url){const child=spawn('explorer.exe',[url],{windowsHide:true,detached:true,stdio:'ignore'});child.on('error',()=>console.log('请在浏览器打开 '+url));child.unref();}
async function start(){const app=createApp();let url;for(let port=8787;port<8807;port++){try{url=await app.listen(port);break;}catch(e){if(e.code!=='EADDRINUSE')throw e;try{const s=await(await fetch('http://127.0.0.1:'+port+'/api/status',{signal:AbortSignal.timeout(1000)})).json();if(s.app===APP&&s.rootId===app.rootId){if(process.argv.includes('--open'))openBrowser('http://127.0.0.1:'+port+'/');return;}}catch{}}}if(!url)throw new Error('找不到可用的本地端口');C.atomicJSON(path.join(__dirname,'local-runtime.json'),{url,pid:process.pid});console.log('看板后台已启动：'+url);if(process.argv.includes('--open'))openBrowser(url);process.on('SIGINT',()=>app.close());process.on('SIGTERM',()=>app.close());}
if(require.main===module)start().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={createApp,validateConfig,findProfiles};
