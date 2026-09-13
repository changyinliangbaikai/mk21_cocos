#!/usr/bin/env node
import {createServer} from 'node:http';
import {existsSync,statSync,createReadStream} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
const root=resolve(process.argv[2] || 'game/build/web-mobile');
const port=Number(process.env.PORT || 7457);
if(!existsSync(resolve(root,'index.html'))){
 console.error(`尚无真实Cocos Web构建入口：${root}/index.html\n请完成编辑器创建/Boot场景挂载后运行 npm run build:web。此服务器不会伪造可玩页面。`);process.exit(1);
}
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.wasm':'application/wasm','.bin':'application/octet-stream','.woff':'font/woff','.ttf':'font/ttf','.svg':'image/svg+xml'};
createServer((req,res)=>{
 let path;try{path=resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));}catch{res.writeHead(400).end();return;}
 if(path!==root&&!path.startsWith(root+sep)){res.writeHead(403).end();return;}
 if(existsSync(path)&&statSync(path).isDirectory())path=resolve(path,'index.html');
 if(path===resolve(root,'favicon.ico')&&!existsSync(path)){res.writeHead(204).end();return;}
 if(!existsSync(path)||!statSync(path).isFile()){res.writeHead(404).end('Not found');return;}
 res.setHeader('Content-Type',mime[extname(path)]||'application/octet-stream');res.setHeader('Cache-Control','no-cache');createReadStream(path).pipe(res);
}).listen(port,'127.0.0.1',()=>console.log(`Cocos Web playable: http://127.0.0.1:${port}/\nServing actual build: ${root}`));
