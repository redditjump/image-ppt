#!/usr/bin/env node
'use strict';
// Image-only PPT workflow. All authoring assets remain local; no network calls.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const fail = message => { throw new Error(message); };
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const inside = (root, file) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };

function args(argv) {
  const command = argv.shift();
  const opt = {};
  const flags = new Set(['compact', 'first']);
  const names = new Set(['project','title','id','image','prompt','notes','after','modules','version','quality',...flags]);
  while (argv.length) {
    const key = argv.shift();
    if (!key.startsWith('--') || !names.has(key.slice(2))) fail('Unknown argument: ' + key);
    const name = key.slice(2);
    if (name in opt) fail('Duplicate argument: ' + key);
    if (flags.has(name)) opt[name] = true;
    else { if (!argv.length || argv[0].startsWith('--')) fail('Missing value: ' + key); opt[name] = argv.shift(); }
  }
  const allowed = {
    init:['project','title'], doctor:['project','modules'], list:['project'], check:['project'],
    add:['project','id','title','image','prompt','notes','after','first'],
    replace:['project','id','title','image','prompt','notes'], remove:['project','id'],
    build:['project','modules','compact','version','quality']
  };
  if (!(command in allowed)) fail('Commands: init, doctor, list, check, add, replace, remove, build');
  for (const key of Object.keys(opt)) if (!allowed[command].includes(key)) fail(`--${key} is not valid for ${command}`);
  if (!opt.project) fail('--project is required');
  return {command, opt, root:path.resolve(opt.project)};
}

function atomic(file, value) {
  const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, value, {flag:'wx'});
  fs.renameSync(tmp, file);
}

function localFile(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) fail('Expected project-relative file: ' + relative);
  const full = path.resolve(root, relative);
  if (!inside(root, full) || !fs.existsSync(full) || !fs.statSync(full).isFile()) fail('Missing or out-of-project file: ' + relative);
  if (!inside(fs.realpathSync(root), fs.realpathSync(full))) fail('Linked file escapes project: ' + relative);
  return full;
}

function dimensions(file) {
  const b = fs.readFileSync(file);
  if (b.length >= 24 && b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && b.toString('ascii',12,16)==='IHDR') {
    return {width:b.readUInt32BE(16), height:b.readUInt32BE(20), ext:'.png'};
  }
  if (b[0]===255 && b[1]===216) {
    let p=2;
    const sof = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
    while (p+4<=b.length) {
      if (b[p++]!==255) fail('Invalid JPEG marker: '+file);
      while(b[p]===255) p++;
      const marker=b[p++];
      if(marker===0xda || marker===0xd9) break;
      if(marker===0x01 || (marker>=0xd0 && marker<=0xd7)) continue;
      const len=b.readUInt16BE(p);
      if(len<2 || p+len>b.length) fail('Invalid JPEG segment: '+file);
      if(sof.has(marker) && len>=8) return {width:b.readUInt16BE(p+5),height:b.readUInt16BE(p+3),ext:'.jpg'};
      p+=len;
    }
  }
  fail('Supported images: valid PNG or JPEG. File: '+file);
}

function validate(root, m, allowEmpty=false) {
  if(m.schema_version!==1 || typeof m.title!=='string' || !m.title.trim() || !Array.isArray(m.slides)) fail('Invalid manifest schema/title/slides');
  if(!allowEmpty && !m.slides.length) fail('No slides in manifest');
  const ids=new Set(), warnings=[];
  const slides=m.slides.map((s,i)=>{
    if(!s || typeof s.id!=='string' || !/^[a-z][a-z0-9-]{0,63}$/.test(s.id) || ids.has(s.id)) fail('Invalid or duplicate slide id at page '+(i+1));
    ids.add(s.id);
    if(typeof s.title!=='string' || !s.title.trim()) fail('Missing slide title: '+s.id);
    if(s.notes!==undefined && typeof s.notes!=='string') fail('notes must be text: '+s.id);
    const file=localFile(root,s.image), size=dimensions(file);
    if(!size.width || !size.height) fail('Invalid image dimensions: '+s.id);
    if(s.prompt!==undefined) localFile(root,s.prompt);
    if(Math.abs(size.width/size.height-16/9)>0.025) warnings.push(`${i+1}/${s.id}: ${size.width}x${size.height}; will contain without stretching/cropping`);
    return {...s, file, size, page:i+1};
  });
  return {slides,warnings};
}

const load = root => JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8').replace(/^\uFEFF/,''));
function save(root,m) {
  const target=path.join(root,'manifest.json');
  fs.mkdirSync(path.join(root,'revisions'),{recursive:true});
  fs.copyFileSync(target,path.join(root,'revisions','manifest-'+stamp()+'.json'),fs.constants.COPYFILE_EXCL);
  atomic(target,json(m));
}
function dependency(name,root,modules,optional=false) {
  const locations=[];
  if(modules) locations.push(()=>require(path.join(path.resolve(modules),name)));
  locations.push(()=>createRequire(path.join(root,'package.json'))(name),()=>require(name));
  for(const get of locations) {try{return get();}catch(e){if(e.code!=='MODULE_NOT_FOUND') throw e;}}
  if(optional) return null;
  fail(`Cannot load ${name}; use --modules <node_modules> or install it in the project.`);
}

function init(root,title) {
  if(!title || !title.trim()) fail('--title is required');
  if(fs.existsSync(root)) fail('Project already exists; refusing to overwrite: '+root);
  fs.mkdirSync(root,{recursive:true});
  for(const d of ['assets','references','prompts','renders','scripts','output','revisions']) fs.mkdirSync(path.join(root,d));
  fs.writeFileSync(path.join(root,'manifest.json'),json({schema_version:1,title,slides:[]}));
  const docs={
    'AGENTS.md':'# 图片版PPT项目\n\n使用 image-ppt-workflow。开工读取 brief.md、outline.md、style-guide.md、manifest.json、progress.md 和 output/LATEST.json（若存在）。按整页生图、局部改图、合成PPT执行；保留提示词和原图。稳定页面id与页码分离。变更后同步PPT和预览，旧发布保留。\n',
    'brief.md':`# ${title}\n\n受众：待填写\n用途：待填写\n语言：待填写\n目标页数：待填写\n素材与必须保留的文案：待填写\n`,
    'outline.md':'# 逐页大纲\n\n记录每页标题、核心信息、素材和构图要求。\n',
    'style-guide.md':'# 已确认风格\n\n记录样张路径、配色、文字层级、构图及确认状态。\n',
    'progress.md':'# 进度\n\n项目已初始化，尚未生成或确认样张。\n'
  };
  for(const [name,body] of Object.entries(docs)) fs.writeFileSync(path.join(root,name),body);
  return {project:root,status:'initialized'};
}

function preview(title,slides) {
  const frames=slides.map((s,i)=>`<figure ${i?'hidden':''}><img src="../images/${String(i+1).padStart(3,'0')}-${s.id}${s.size.ext}" alt="${esc(s.title)}"><figcaption>${i+1} / ${slides.length} · ${esc(s.title)}</figcaption></figure>`).join('\n');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>*{box-sizing:border-box}body{margin:0;background:#101827;color:white;font-family:system-ui}main{height:100vh;display:grid;place-items:center;padding:12px 12px 60px}figure{margin:0;text-align:center;width:100%}figure[hidden]{display:none}img{display:block;margin:auto;max-width:100%;max-height:calc(100vh - 115px);object-fit:contain}figcaption{margin-top:10px;font-size:14px}nav{position:fixed;bottom:12px;width:100%;display:flex;justify-content:center;gap:16px}button{padding:8px 22px;cursor:pointer}</style><main>${frames}</main><nav><button id="prev" aria-label="上一页">上一页</button><button id="next" aria-label="下一页">下一页</button></nav><script>const f=Array.from(document.querySelectorAll('figure'));let p=0;function show(n){p=Math.max(0,Math.min(f.length-1,n));f.forEach((e,i)=>e.hidden=i!==p);document.getElementById('prev').disabled=p===0;document.getElementById('next').disabled=p===f.length-1;history.replaceState(null,'','#slide-'+(p+1))}document.getElementById('prev').onclick=()=>show(p-1);document.getElementById('next').onclick=()=>show(p+1);addEventListener('keydown',e=>{if(['ArrowRight','ArrowLeft',' ','Home','End'].includes(e.key)){e.preventDefault();show(e.key==='Home'?0:e.key==='End'?f.length-1:p+(['ArrowLeft'].includes(e.key)?-1:1))}});show(Number(location.hash.match(/slide-(\\d+)/)?.[1]||1)-1);</script></html>`;
}

async function build(root,m,opt) {
  const {slides,warnings}=validate(root,m);
  const Pptx=dependency('pptxgenjs',root,opt.modules);
  const sharp=opt.compact?dependency('sharp',root,opt.modules):null;
  const quality=opt.quality===undefined?90:Number(opt.quality);
  if(!Number.isInteger(quality) || quality<60 || quality>100) fail('--quality must be integer 60..100');
  if(opt.quality && !opt.compact) fail('--quality requires --compact');
  const version=opt.version||stamp();
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(version)) fail('Invalid version name');
  const out=path.join(root,'output');fs.mkdirSync(out,{recursive:true});
  const dest=path.join(out,version);
  if(fs.existsSync(dest)) fail('Release already exists: '+dest);
  const stage=path.join(out,'.building-'+stamp());fs.mkdirSync(stage);
  for(const folder of ['images','prompts','preview',...(sharp?['images-compact']:[])]) fs.mkdirSync(path.join(stage,folder));
  const record={schema_version:1,title:m.title,version,built_at:new Date().toISOString(),slide_count:slides.length,warnings,slides:[],files:[]};
  const snapshot={schema_version:1,title:m.title,slides:[]};
  for(const s of slides) {
    const stem=String(s.page).padStart(3,'0')+'-'+s.id;
    s.hd='images/'+stem+s.size.ext;
    const bytes=fs.readFileSync(s.file);
    fs.writeFileSync(path.join(stage,s.hd),bytes);
    const copy={id:s.id,title:s.title,image:s.hd};
    if(s.notes!==undefined) copy.notes=s.notes;
    if(s.prompt) {copy.prompt='prompts/'+stem+'.md';fs.copyFileSync(localFile(root,s.prompt),path.join(stage,copy.prompt));}
    const item={page:s.page,id:s.id,title:s.title,source:s.image,image:s.hd,width:s.size.width,height:s.size.height,sha256:hash(bytes)};
    if(sharp) {
      s.compact='images-compact/'+stem+'.jpg';
      await sharp(bytes).flatten({background:'#ffffff'}).resize({width:1920,height:1080,fit:'inside',withoutEnlargement:true}).jpeg({quality,chromaSubsampling:'4:4:4'}).toFile(path.join(stage,s.compact));
      item.compact=s.compact;item.compact_sha256=hash(fs.readFileSync(path.join(stage,s.compact)));
    }
    snapshot.slides.push(copy);record.slides.push(item);
  }
  for(const kind of sharp?['hd','compact']:['hd']) {
    const ppt=new Pptx();ppt.layout='LAYOUT_WIDE';ppt.title=m.title;ppt.subject='Image-based presentation';ppt.author='';ppt.company='';ppt.lang='zh-CN';
    for(const s of slides) {
      const page=ppt.addSlide();page.background={color:'FFFFFF'};
      const file=path.join(stage,s[kind]);
      const scale=Math.min(13.333333/s.size.width,7.5/s.size.height);
      const w=s.size.width*scale,h=s.size.height*scale;
      page.addImage({path:file,x:(13.333333-w)/2,y:(7.5-h)/2,w,h});
      page.addNotes([s.title,...(s.notes?[s.notes]:[])]);
    }
    const name=`deck-${kind}.pptx`;await ppt.writeFile({fileName:path.join(stage,name),compression:true});
    record.files.push({file:name,sha256:hash(fs.readFileSync(path.join(stage,name)))});
  }
  fs.writeFileSync(path.join(stage,'preview','index.html'),preview(m.title,slides));
  fs.writeFileSync(path.join(stage,'manifest.json'),json(snapshot));
  fs.writeFileSync(path.join(stage,'build.json'),json(record));
  fs.renameSync(stage,dest);
  const latest={version,path:dest,slide_count:slides.length,pptx:record.files.map(f=>path.join(dest,f.file)),preview:path.join(dest,'preview','index.html')};
  atomic(path.join(out,'LATEST.json'),json(latest));
  fs.appendFileSync(path.join(root,'progress.md'),`\n- ${record.built_at} 构建 ${version}，${slides.length} 页。发布：${dest}。视觉审阅状态由制作助手补充。\n`);
  return {...latest,warnings};
}

async function main(argv) {
  const {command,opt,root}=args(argv);
  if(command==='init') return init(root,opt.title);
  if(command==='doctor') return {project:root,node:process.version,pptxgenjs:!!dependency('pptxgenjs',root,opt.modules,true),sharp:!!dependency('sharp',root,opt.modules,true),image_generation:'Check available host image tool separately'};
  if(!fs.existsSync(root)) fail('Project missing: '+root);
  if(['list','check'].includes(command)) {
    const {slides,warnings}=validate(root,load(root),command==='list');
    return {slide_count:slides.length,slides:slides.map(s=>({page:s.page,id:s.id,title:s.title,image:s.image})),warnings};
  }
  const lock=path.join(root,'.image-ppt.lock');let fd;
  try{fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,json({pid:process.pid,command,time:new Date().toISOString()}));}
  catch(e){if(e.code==='EEXIST') fail('Project write lock exists; verify running process before recovering: '+lock);throw e;}
  try {
    const m=load(root);validate(root,m,true);
    if(command==='build') return await build(root,m,opt);
    if(!opt.id) fail('--id is required');
    const index=m.slides.findIndex(s=>s.id===opt.id);
    if(command==='add') {
      if(index!==-1) fail('Slide id already exists: '+opt.id);
      if(opt.first && opt.after!==undefined) fail('--first and --after are mutually exclusive');
      let at=m.slides.length;
      if(opt.first) at=0;
      else if(opt.after!==undefined) {at=m.slides.findIndex(s=>s.id===opt.after)+1;if(!at) fail('Unknown --after id: '+opt.after);}
      const slide={id:opt.id,title:opt.title,image:opt.image};
      for(const k of ['prompt','notes']) if(k in opt) slide[k]=opt[k];
      m.slides.splice(at,0,slide);
    } else {
      if(index<0) fail('Unknown slide id: '+opt.id);
      if(command==='remove') m.slides.splice(index,1);
      else {
        if(!['image','title','prompt','notes'].some(k=>k in opt)) fail('No replacement fields supplied');
        for(const k of ['image','title','prompt','notes']) if(k in opt) m.slides[index][k]=opt[k];
      }
    }
    validate(root,m,true);save(root,m);
    return {command,id:opt.id,slide_count:m.slides.length,manifest:path.join(root,'manifest.json')};
  } finally {fs.closeSync(fd);fs.unlinkSync(lock);}
}

if(require.main===module) main(process.argv.slice(2)).then(r=>console.log(json(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={main,dimensions,validate};
