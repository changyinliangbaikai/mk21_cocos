#!/usr/bin/env node
/** C033: deterministic crop/atlas packing only. Artwork and alpha come from imagegen. */
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import sharp from 'sharp';
const root=resolve(import.meta.dirname,'..'),source=resolve(root,'design-library/08-十英雄扩展'),out=resolve(source,'export');
mkdirSync(out,{recursive:true});
const ids=['RH07','RH08','RH09','RH10'],manifest={decision:'C-033',atlases:[]},audit={generatedWith:'built-in image_gen',sources:[],decodedBytes:0,opaqueBoundaryPixels:0};
const clips={idle:{frames:[0,1],secondsPerFrame:.4,loop:true},attack:{frames:[2,3],secondsPerFrame:.12},cast:{frames:[4,5],secondsPerFrame:.2},hit:{frames:[6,7],secondsPerFrame:.1},defeated:{frames:[8,9],secondsPerFrame:.25,holdLast:true},revive:{frames:[10,11],secondsPerFrame:.3}};
async function regions(id,kind){
 const file=resolve(source,`素材/${id}-${kind}.png`),input=readFileSync(file),{data,info}=await sharp(input).ensureAlpha().raw().toBuffer({resolveWithObject:true}),n=kind==='actor'?4:3;
 const alpha=(x,y)=>data[(y*info.width+x)*4+3];
 const score=(axis,pos,lo,hi)=>{let core=0,a=0;for(let t=lo;t<hi;t++){const v=axis==='y'?alpha(t,pos):alpha(pos,t);core+=v>128?1:0;a+=v*v;}return core*1e8+a;};
 const cut=(axis,target,lo,hi)=>{let best=-1,bs=Infinity;for(let p=Math.floor(target-info.width/n*.18);p<=target+info.width/n*.18;p++){const s=score(axis,p,lo,hi)+Math.abs(p-target)*.01;if(s<bs){bs=s;best=p;}}return best;};
 const ys=[0,...Array.from({length:n-1},(_,i)=>cut('y',info.height*(i+1)/n,0,info.width)),info.height],frames=[];
 for(let j=0;j<n;j++){
  const xs=[0,...Array.from({length:n-1},(_,i)=>cut('x',info.width*(i+1)/n,ys[j],ys[j+1])),info.width];
  for(let i=0;i<n;i++){
   const [l,t,r,b]=[xs[i],ys[j],xs[i+1],ys[j+1]];let left=r,top=b,right=l,bottom=t,edge=0,solid=0;
   for(let y=t;y<b;y++)for(let x=l;x<r;x++){const a=alpha(x,y);if(a>16){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);}if(a>128){solid++;if(x===l||x===r-1||y===t||y===b-1)edge++;}}
   if(solid<500||edge)throw Error(`${id}-${kind} cell ${frames.length} empty or clipped: ${solid}/${edge}`);
   frames.push({rect:[l,t,r-l,b-t],visibleRect:[left,top,right-left+1,bottom-top+1],opaqueEdgePixels:edge,solidPixels:solid});
  }
 }
 const row={id,kind,file:`素材/${id}-${kind}.png`,width:info.width,height:info.height,sha256:createHash('sha256').update(input).digest('hex'),frames};audit.sources.push(row);return {input,frames,sha:row.sha256};
}
async function pack(id,kind,input,regions,refHeight,sha){
 const actor=kind==='hero',cell=kind==='single'?320:kind==='icon'?160:192,cols=kind==='single'?1:kind==='icon'||kind==='vfx'?3:4,rows=Math.ceil(regions.length/cols),layers=[],frames=[];
 for(let i=0;i<regions.length;i++){
  const [left,top,width,height]=regions[i].visibleRect,f=Math.min((cell-8)/width,(cell-8)/height,1),w=Math.max(1,Math.round(width*f)),h=Math.max(1,Math.round(height*f)),x=i%cols*cell+4,y=Math.floor(i/cols)*cell+4;
  layers.push({input:await sharp(input).extract({left,top,width,height}).resize(w,h).png().toBuffer(),left:x,top:y});
  frames.push({rect:[x,y,w,h],ratio:width/height,widthRatio:width/refHeight,heightRatio:height/refHeight,anchor:actor?[.5,0]:[.5,.5]});
 }
 const width=cols*cell,height=rows*cell,file=resolve(out,id+'.png');await sharp({create:{width,height,channels:4,background:'#00000000'}}).composite(layers).png({compressionLevel:9}).toFile(file);
 audit.decodedBytes+=width*height*4;
 manifest.atlases.push({id,resource:'r1/art/'+id,group:kind==='hero'||kind==='vfx'?'battle':'ui',kind,frames,clips:actor?clips:{},displayHeight:105.59,sourceSha256:sha});
}
for(const id of ids){const actor=await regions(id,'actor'),fx=await regions(id,'fx');await pack(id,'hero',actor.input,actor.frames.slice(0,12),actor.frames[0].visibleRect[3],actor.sha);await pack('PORTRAIT-'+id,'single',actor.input,actor.frames.slice(12,13),1,actor.sha);await pack('IC-'+id,'icon',actor.input,actor.frames.slice(13,16),1,actor.sha);await pack('FX-'+id,'vfx',fx.input,fx.frames,1,fx.sha);}
if(audit.decodedBytes>16*1048576)throw Error('Texture budget');
writeFileSync(resolve(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');writeFileSync(resolve(source,'asset-technical-audit.json'),JSON.stringify(audit,null,2)+'\n');
const sections=ids.map(id=>`<section id="${id}"><h2>${id}</h2><div class="phone">${['#e9d9aa','#182c35'].map(bg=>`<div style="background:${bg}"><h3>55px战斗比例 / 140px头像</h3><div class="poses">${manifest.atlases.find(a=>a.id===id).frames.map((f,i)=>`<span><canvas data-atlas="${id}" data-frame="${i}" data-size="55"></canvas><small>${['待机A','待机B','普攻前','普攻后','施法前','施法后','受击A','受击B','阵亡A','阵亡B','复起','复活'][i]}</small></span>`).join('')}</div><canvas data-atlas="PORTRAIT-${id}" data-frame="0" data-size="140"></canvas>${[0,1,2].map(i=>`<canvas data-atlas="IC-${id}" data-frame="${i}" data-size="56"></canvas>`).join('')}<div>${Array.from({length:9},(_,i)=>`<canvas data-atlas="FX-${id}" data-frame="${i}" data-size="90"></canvas>`).join('')}</div></div>`).join('')}</div></section>`).join('');
writeFileSync(resolve(source,'index.html'),`<!doctype html><meta charset="utf-8"><title>超力英雄 C033 十英雄素材自验</title><style>body{background:#13232b;color:#eef6f6;font:16px system-ui;margin:24px}h1{font-size:28px}.phone{display:grid;grid-template-columns:1fr 1fr;gap:12px}.phone>div{padding:18px;border-radius:14px;color:#748791}.poses{display:flex;gap:8px;flex-wrap:wrap}span{display:flex;flex-direction:column;align-items:center}small{font-size:12px}canvas{image-rendering:auto}section{margin-bottom:35px}a{color:#8cdbed}</style><h1>C033 十英雄素材自验</h1><p>12战斗动作、头像、3技能图标、9特效组件 / 明暗背景 / 实际55px英雄比例</p>${sections}<script>fetch('export/manifest.json').then(r=>r.json()).then(async m=>{for(const a of m.atlases){const im=new Image();im.src='export/'+a.id+'.png';await im.decode();for(const c of document.querySelectorAll('[data-atlas="'+a.id+'"]')){const f=a.frames[+c.dataset.frame],s=+c.dataset.size;c.width=s*2;c.height=s*2;c.style.width=s+'px';c.style.height=s+'px';const k=Math.min(s*2/f.rect[2],s*2/f.rect[3]);c.getContext('2d').drawImage(im,...f.rect,(s*2-f.rect[2]*k)/2,s*2-f.rect[3]*k,f.rect[2]*k,f.rect[3]*k)}}document.body.dataset.ready='yes'})</script>`);
if(process.argv.includes('--install')){
 const gate=JSON.parse(readFileSync(resolve(source,'asset-gate.json'),'utf8'));if(!gate.visualReviewPassed||!gate.readyForCoding||gate.sourceHashes.some(s=>!audit.sources.some(a=>a.sha256===s)))throw Error('Asset gate not approved or sources changed');
 const dest=resolve(root,'game/assets/resources/r1'),existing=JSON.parse(readFileSync(resolve(dest,'manifest.json'),'utf8'));existing.atlases=existing.atlases.filter(a=>!manifest.atlases.some(b=>b.id===a.id)).concat(manifest.atlases);existing.rosterExpansion='C-033';
 for(const a of manifest.atlases){const path=resolve(dest,'art/'+a.id+'.png');copyFileSync(resolve(out,a.id+'.png'),path);if(!existsSync(path+'.meta')){writeFileSync(path+'.meta',JSON.stringify({ver:'1.0.27',importer:'image',imported:false,uuid:randomUUID(),files:[],subMetas:{},userData:{type:'raw',fixAlphaTransparencyArtifacts:false,hasAlpha:true}},null,2)+'\n');}}
 writeFileSync(resolve(dest,'manifest.json'),JSON.stringify(existing,null,2)+'\n');
}
console.log(JSON.stringify({atlases:manifest.atlases.length,regions:manifest.atlases.reduce((n,a)=>n+a.frames.length,0),decodedMiB:audit.decodedBytes/1048576,sourceSheets:audit.sources.length,installed:process.argv.includes('--install')}));
