import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root=fileURLToPath(new URL('..',import.meta.url));
process.chdir(root);
const browse=async port=>{
  const url=`http://127.0.0.1:${port}/`;
  console.log(`配音工作台：${url}`);
  if(process.argv.includes('--no-browser'))return;
  try{await promisify(execFile)('open',[url]);}catch{console.log('未能自动打开浏览器，请手动打开上方地址。');}
};
try{
  if(process.platform!=='darwin')throw new Error('此分发包仅验证了 macOS，请使用相应平台的正式交付。');
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(major<22 || (major===22&&minor<13))throw new Error('请先安装 Node.js 22.13 或更新版本，再重新启动。');
  if(process.argv.slice(2).some(argument=>argument!=='--no-browser'))throw new Error('启动参数无效；端口和保存位置请使用 PORT / DATA_DIR。');
  if(!existsSync(join(root,'dist','index.html')))throw new Error('预构建界面缺失，请重新解压完整体验包。');
  const {startServer,settings}=await import('../server/index.mjs');
  const {workspaceDirectory}=await import('../server/workspace.mjs');
  const directory=workspaceDirectory(),runtime=join(directory,'runtime.json');
  let running=existsSync(runtime)?JSON.parse(readFileSync(runtime,'utf8')):null;
  if(running){
    if(!Number.isSafeInteger(running.pid)||running.pid<1)throw new Error('工作区运行记录无效，请检查原启动窗口；原资料仍保留。');
    try{process.kill(running.pid,0);}catch(error){if(error.code==='ESRCH')running=null;else throw error;}
  }
  if(running){
    if(!Number.isInteger(running.port)||running.port<1||running.port>65535)throw new Error('现有服务的端口记录无效，请检查原启动窗口。');
    try{
      const response=await fetch(`http://127.0.0.1:${running.port}/api/state`,{signal:AbortSignal.timeout(5000)}),state=await response.json();
      if(!response.ok||!Array.isArray(state.projects)||!Array.isArray(state.chapters)||resolve(state.settings?.workspaceDirectory||'')!==resolve(directory))throw new Error();
    }catch{throw new Error('此工作区已有进程，但对应服务尚未就绪；请稍后重试或检查原运行窗口。');}
    console.log(`已复用正在运行的工作区：${directory}`);await browse(running.port);
  }else{
    const port=Number(process.env.PORT||4318);
    if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT 必须是 1 至 65535 的整数。');
    const {toolsAvailable}=await import('../server/audio.mjs');
    if(!await toolsAvailable())throw new Error('未找到可用的 FFmpeg / FFprobe。请安装音频工具，或设置 FFMPEG_PATH / FFPROBE_PATH 为可执行文件的完整路径。');
    const config=settings(),app=await startServer({directory,port,config});
    let stopping=false;
    for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,async()=>{
      if(stopping)return;stopping=true;console.log('正在安全停止，等待在途任务结束…');
      await app.close();process.exit(0);
    });
    console.log(`工作区：${directory}\n使用期间请保留此窗口；停止请按 Control+C。`);
    if(!config.key)console.log('未配置配音密钥，可先体验免费演示及本地编辑；AI准备和模型配音需要配置接口。');
    await browse(app.server.address().port);
  }
}catch(error){
  const message=error.code==='EADDRINUSE'?'端口已被其他服务占用。请关闭对应服务，或设置其他 PORT；工作区资料未删除。':error.code==='EACCES'?'无法访问保存位置或可执行文件，请检查目录权限和工具路径。':error.message;
  console.error(`启动失败：${message}`);process.exitCode=1;
}
