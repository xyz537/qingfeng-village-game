const $=id=>document.getElementById(id),canvas=$('game'),ctx=canvas.getContext('2d');
const art={map:new Image(),sprites:new Image(),walkers:new Image(),walkExtra:new Image(),directions:Array.from({length:9},(_,index)=>{const image=new Image();image.src=`assets/directional-${index}-v2.png`;return image;})};art.map.src='assets/village-map.png';art.sprites.src='assets/villagers-atlas.png';art.walkers.src='assets/villagers-walk.png';art.walkExtra.src='assets/villagers-walk-extra.png';
for(const [id,room] of Object.entries(DATA.interiors)){art[id]=new Image();art[id].src=room.asset;}
let state=Core.fresh();try{const s=JSON.parse(localStorage.getItem('qingfeng-v1'));if([1,2].includes(s?.version)&&Array.isArray(s.plots)&&Number.isFinite(s.time)){state={...state,...s};if(s.version===1){state.version=2;state.speed=1;}}}catch{}
if(state.scene==='village'&&Core.solid(state.x,state.y)){state.x=DATA.map.spawn.x;state.y=DATA.map.spawn.y;}
let modal=false,dialogue=null,near=null,toastUntil=0,last=0,saveTimer=0,fish=null,seated=false,frame=0,playerWalkPhase=0,playerFacing='down';
let travel=null,pointerStart=null,nearSignature='';const navigationCache=new Map();
const villagers=DATA.npcs.map((n,i)=>({...n,x:DATA.map.villageCenter.x+i*7,y:DATA.map.villageCenter.y+i*6,scene:'village',bubble:0,moving:false,movePhase:i,facing:'down'}));
function save(){try{localStorage.setItem('qingfeng-v1',JSON.stringify(state));}catch{}}
function tell(t){$('toast').textContent=t;toastUntil=performance.now()+4500;}
function close(){modal=false;dialogue=null;$('modal').hidden=true;$('dialogue').hidden=true;}
function dialoguePages(value,limit=48){
 const chars=Array.from(String(value).trim()),pages=[];
 while(chars.length>limit){let end=limit;for(let i=limit-1;i>=Math.floor(limit/2);i--)if(/[。！？；\n]/.test(chars[i])){end=i+1;break;}pages.push(chars.splice(0,end).join('').trim());}
 if(chars.length)pages.push(chars.join('').trim());return pages;
}
function drawDialoguePortrait(turn){
 const portrait=$('dialogue-portrait'),paint=portrait.getContext('2d');
 paint.clearRect(0,0,portrait.width,portrait.height);paint.fillStyle='#394735';paint.fillRect(0,0,portrait.width,portrait.height);
 if(!art.sprites.complete||!art.sprites.naturalWidth)return;
 const index=turn.sprite??0,sw=art.sprites.naturalWidth/3,sh=art.sprites.naturalHeight/3;
 paint.imageSmoothingEnabled=false;
 paint.drawImage(art.sprites,(index%3+.19)*sw,(Math.floor(index/3)+.07)*sh,sw*.62,sh*.62,0,0,portrait.width,portrait.height);
}
function renderDialogue(){
 if(!dialogue)return;const turn=dialogue.pages[dialogue.index],lastPage=dialogue.index===dialogue.pages.length-1,actions=lastPage?dialogue.actions:[];
 $('dialogue').dataset.speaker=turn.speaker==='player'?'player':'npc';
 $('dialogue-name').textContent=turn.name;$('dialogue-text').textContent=turn.text;
 $('dialogue-hint').textContent=!lastPage?'点击继续':actions.length?'请选择':'点击结束';
 $('dialogue-actions').replaceChildren();
 for(const [label,fn,disabled] of actions){const button=document.createElement('button');button.textContent=label;button.disabled=!!disabled;button.onclick=()=>{fn();save();};$('dialogue-actions').append(button);}
 $('dialogue').classList?.toggle('has-actions',actions.length>0);drawDialoguePortrait(turn);$('dialogue').hidden=false;
}
function startDialogue(turns,actions=[],pageLimit=48){
 close();cancelTravel();const pages=turns.flatMap(turn=>dialoguePages(turn.text,pageLimit).map(text=>({...turn,text})));
 if(!pages.length)return;modal=true;toastUntil=0;dialogue={pages,index:0,actions};renderDialogue();$('dialogue-next').focus?.({preventScroll:true});
}
function advanceDialogue(){if(!dialogue)return;if(dialogue.index===dialogue.pages.length-1&&dialogue.actions.length)return;if(++dialogue.index>=dialogue.pages.length)close();else renderDialogue();}
function talkTo(n){startDialogue([{speaker:'npc',name:n.name,sprite:n.sprite,text:n.line},{speaker:'player',name:'你',sprite:0,text:'那我先在村里走走，回头再聊。'}]);}
art.sprites.onload=()=>{if(dialogue)drawDialoguePortrait(dialogue.pages[dialogue.index]);};
function panel(title,body,actions=[]){
 const owners={home:'suhuairen',school:'guteacher',smith:'zhaotieshan',tavern:'tavernkeeper',elder:'zhoubo'},owned=/^(苏家药铺|私塾|铁铺|赵家铁铺|茶酒馆|清风茶酒馆|村长家)/.test(title),owner=owned?villagers.find(n=>n.id===owners[state.scene]):null;
 startDialogue([{speaker:owner?'npc':'player',name:owner?.name||'你',sprite:owner?.sprite??0,text:`【${title}】\n${body}`}],actions,160);
}
function spend(n,fn){if(Core.pay(state,n))fn();else tell('摸了摸钱袋，铜钱不够了。');}
function advance(m){Core.advance(state,m);save();}
function inventory(){panel('随身行囊',`${state.money} 文 · 学识 ${state.knowledge}\n兵器：${state.weapon}\n书页理解：${state.reading}\n\n`+Object.entries(state.bag).filter(([k,v])=>v>0).map(([k,v])=>`${k} × ${v}`).join('\n'),[['操作与村中日常',()=>panel('不急着成为大侠','点击道路或空地，主角会自动绕过障碍走过去。点击新的位置即可改道，「停下」可停止行走。\n远处的人物、建筑、田地或码头：点击后先走近，再点击一次触发。身边可交互的对象也会显示在地图下方，直接点击名称即可。\n室内点击案台使用设施，点击下方门口离开。\n时间自然流逝；现实24分钟为游戏一天。歇息与 ×8 时间可加快等待。\n种子每份 5 文，成熟后收获；酒馆可出售作物和鱼。蚯蚓与面团在河边补充。\n村民白天劳作，黄昏聚到村心，夜里回屋。\n随时从南边道路离村，亦可随时回来。存档保存在当前浏览器。')]]);}
function enter(id){cancelTravel();state.scene=id;const spawn=DATA.interiors[id]?.spawn||{x:360,y:790};state.x=spawn.x;state.y=spawn.y;seated=false;close();tell(DATA.buildings.find(b=>b.id===id).name+' · 点击室内设施，走近后再点击使用');save();}
function switchInterior(target){cancelTravel();state.scene=target.to;const spawn=target.spawn||DATA.interiors[target.to]?.spawn||{x:360,y:790};state.x=spawn.x;state.y=spawn.y;seated=false;close();tell(DATA.interiors[target.to]?.label||'进入室内');save();}
function leave(){cancelTravel();const b=DATA.buildings.find(b=>b.id===state.scene);state.scene='village';state.x=b?b.door.x:DATA.map.gate.x;state.y=b?b.door.y+8:DATA.map.gate.y;seated=false;fish=null;close();save();}
function service(id){const hour=state.time%1440/60,b=DATA.buildings.find(b=>b.id===id);if(id!=='home'&&(hour<b.hours[0]||hour>=b.hours[1])){panel(b.name,'屋里已安静下来。营业时辰：'+b.hours.join('—')+'时。明日再来吧。');return;}
 if(id==='home')panel('苏家药铺 · 也是你的家','药柜里有晒干的草木香。苏伯给你留了床铺，桌上摊着一本旧医书。',[['睡到明日清晨',()=>{advance(1440-state.time%1440+360);close();tell('一觉醒来，窗外又有了炊烟。');}],['翻阅旧医书',()=>panel('旧医书',state.knowledge>=4?'你终于看懂了几味草药的药性。纸角有苏怀仁年轻时的批注。':'你认识药名，却看不懂后面的医理。先记下这些字吧。')]]);
 if(id==='school')panel('私塾 · 读书随心','窗外风过竹梢，书页轻轻翻动。学识决定读懂多少，文字之外的武学仍须自己领悟。',[
 ['听先生讲一课 · 10文 / 一时辰',()=>spend(10,()=>{advance(120);state.knowledge++;close();tell('你多认得了一些字。学识 +1');})],
 ['翻《山河志》 · 学识需 3',()=>panel('山河志',state.knowledge>=3?'清风村地处云州南境。沿官道而行，山外还有许多城镇。':'字挨着字，你看得脑仁疼。')],
 ['读剑诀残页 · 学识需 5',()=>{if(state.knowledge>=5)state.reading='文字通读，武学尚待领悟';panel('旧剑诀',state.knowledge>=5?'文字已通，运气的道理却还陌生。读懂不等于会练。':'气……丹田……剑……不可……你只认出了几个字。');}],
 ['请先生代读残页',()=>{state.reading='青木剑诀·残（理解框架）';advance(30);panel('只听懂个大概','任凭私塾先生口水纷飞，你还是只听到了个大概。\n记住了两式的名字，后面的运气法门仍不明白。');}]]);
 if(id==='smith')panel('铁铺 · 炉火正暖','锄头、镰刀和铁锅挂满墙壁，角落才有几把普通刀剑。\n'+(state.orders.length?state.orders.map(o=>(o.type==='craft'?'粗铁剑':'柴刀修理')+'：'+(o.due<=state.time?'可领取':`还需 ${Math.ceil((o.due-state.time)/60)} 时`)).join('\n'):'赵铁山正忙着磨一把锄头。'),[
 ['买一把铁剑 · 180文',()=>spend(180,()=>{Core.add(state,'铁剑');state.weapon='铁剑';close();tell('这把普通铁剑，往后便陪着你了。');})],
 ['修旧柴刀 · 30文 / 六时',()=>{tell(Core.order(state,'repair')?'刀留下，晚些时候来拿。':'没有待修的旧柴刀，或铜钱不足。');service('smith');}],
 ['打造粗铁剑 · 铁矿3 / 木材1 / 300文 / 三日',()=>{tell(Core.order(state,'craft')?'三天后来拿。':'材料或铜钱不足，或已有打造订单。');service('smith');}],
 ['领取做好的物件',()=>{tell(Core.collect(state)?'物件已经收进行囊。':'还没有做好的物件。');service('smith');}]]);
 if(id==='tavern')panel('茶酒馆 · 人间烟火',seated?'你在窗边落座，看村民来来往往。':'有空桌，也有温着的酒。',[
 [seated?'起身':'坐下歇脚',()=>{seated=!seated;service('tavern');}],
 ['一碗阳春面 · 12文',()=>spend(12,()=>{advance(20);seated=true;close();tell('热面下肚，周身暖和。');})],
 ['一盏清茶 · 3文',()=>spend(3,()=>{advance(10);seated=true;close();tell('茶香清淡，窗外的风也慢了下来。');})],
 ['一碗米酒 · 8文',()=>spend(8,()=>{advance(15);seated=true;close();tell('浅饮一碗，听邻桌说些闲话。');})],
 ['卖出行囊里的作物与鱼',()=>{let income=0;for(const [k,v] of Object.entries(state.bag)){const price=DATA.crops[k]?.price||(k==='鲫鱼'?15:k==='鲤鱼'?25:0);if(price&&v>0){income+=v*price;state.bag[k]=0;}}state.money+=income;tell(income?`陈婶收下鲜货，付了 ${income} 文。`:'行囊里没有鲜货。');service('tavern');}]]);
 if(id==='elder')panel('村长家 · 村务与村志',state.bridgeDone?'河岸步道已经整修好了。村民走得安心。':'村民正商量整修河岸步道。即使你不帮忙，他们也会在第三日完工。',[
 ['翻阅《清风村志》',()=>panel('清风村志',state.knowledge>=3?state.chronicle.join('\n\n'):'密密麻麻的字里，你只认出了几个年月。学识 3 后可通读。')],
 ['出资购木 · 50文',()=>spend(50,()=>{state.donated=true;advance(0);service('elder');tell('周伯庸收下钱：那就能早一天修好了。');}),state.donated||state.bridgeDone]]);
}
function field(i){const p=state.plots[i];if(!p){panel('一小块田 · '+(i+1),'土已经松好，选一种种子埋下。无需浇水小游戏，等它慢慢长大。',Object.entries(DATA.crops).map(([name,c])=>[`${name} · 种子5文 / ${c.hours}时成熟`,()=>{tell(Core.plant(state,i,name)?'种子埋进土里，剩下的交给日光。':'铜钱不够了。');close();}]));}else panel(p.crop,Core.mature(state,p)?'已经成熟，可以收获了。':`嫩苗还在长。约 ${Math.ceil((DATA.crops[p.crop].hours*60-state.time+p.at)/60)} 时后成熟。`,[['收获',()=>{if(Core.harvest(state,i)){tell('新鲜的收获装进了行囊。');close();}},!Core.mature(state,p)]]);}
function fishing(){if(fish){const ready=state.time>=fish.due;panel('河畔垂钓',ready?'浮子沉下去了，该收杆了。':'水波轻轻荡着，鱼还未咬钩。',[['收杆',()=>{if(ready){const name=fish.bait==='蚯蚓'?'鲫鱼':'鲤鱼';Core.add(state,name);tell('钓到一尾'+name+'。');}else tell('收早了，鱼饵已经散了。');fish=null;close();}],['继续等待',close]]);return;}panel('河边 · 一竿清风','选一份饵，抛下鱼线。等待约半个游戏时辰，浮子下沉后收杆。离开河边将结束本次垂钓。',[
 ...['蚯蚓','面团'].map(bait=>[`${bait} ×${state.bag[bait]||0} · 抛竿`,()=>{state.bag[bait]--;fish={bait,due:state.time+30};close();tell('鱼线落入水中，等一等吧。');},!state.bag[bait]]),
 ['添置鱼饵 · 5文 / 各3份',()=>spend(5,()=>{Core.add(state,'蚯蚓',3);Core.add(state,'面团',3);fishing();})]]);}
function interact(target=near){
 if(modal||!target)return;
 if(!canInteract(target)){requestWalk(targetPoint(target),target);return;}
 cancelTravel();
 if(target.type==='door')enter(target.id);if(target.type==='exit')leave();if(target.type==='service')service(state.scene);if(target.type==='plot')field(target.id);if(target.type==='fish')fishing();
 if(target.type==='transition')switchInterior(target);if(target.type==='inspect')panel(target.title,target.body);
 if(target.type==='road'){state.scene='road';state.x=360;state.y=760;if(!state.departed){state.departed=true;state.chronicle.push(Core.date(state.time)+'，苏家少年自村口出游。');}tell('你已走出清风村。远方的江湖，留待下一版。');save();}
 if(target.type==='return')leave();if(target.type==='npc')talkTo(target.n);
}
function rect(x,y,w,h,color){ctx.fillStyle=color;ctx.fillRect(x,y,w,h)}
function text(t,x,y,size=16,color='#324b3b'){ctx.font=`${size}px "Microsoft YaHei",sans-serif`;ctx.textAlign='center';ctx.fillStyle=color;ctx.fillText(t,x,y)}
function ellipse(x,y,rx,ry,color){ctx.fillStyle=color;ctx.beginPath();ctx.ellipse(x,y,rx,ry,0,0,Math.PI*2);ctx.fill()}
function tree(x,y,s=1){rect(x-4,y,8,32*s,'#716f47');ellipse(x,y-5,24*s,29*s,'#647e53');ellipse(x-13*s,y,19*s,20*s,'#738e5b');ellipse(x+13*s,y-15*s,19*s,22*s,'#81975f')}
function directionFromDelta(dx,dy,current='down'){
 if(Math.abs(dx)<.001&&Math.abs(dy)<.001)return current;
 return Math.abs(dx)>Math.abs(dy)?(dx<0?'left':'right'):(dy<0?'up':'down');
}
function person(x,y,color,name,player=false,sprite=null,motion={}){
 const index=player?0:(sprite??1);
 const col=index%3,row=Math.floor(index/3),sw=art.sprites.width/3,sh=art.sprites.height/3;
 const height=player?51:46,width=height*.8,moving=!!motion.moving,phase=motion.phase||0,direction=motion.facing||'down';
 ellipse(x,y+2,player?13:10,4,'#162a2099');
 if(player){ctx.strokeStyle='#fff2b5';ctx.lineWidth=2;ctx.beginPath();ctx.ellipse(x,y+2,17,7,0,0,Math.PI*2);ctx.stroke();}
 ctx.save();ctx.translate(x,y);
 const directional=art.directions[index];
 if(directional?.complete&&directional.naturalWidth){
  const directionRow={down:0,up:1,left:2,right:3}[direction]??0,fw=directional.naturalWidth/2,fh=directional.naturalHeight/4;
  const stepFrame=moving?Math.floor(phase)%2:0;
  ctx.drawImage(directional,stepFrame*fw,directionRow*fh,fw,fh,-width/2,-height+5,width,height);
 }
 else if(moving&&art.walkers.complete&&art.walkers.naturalWidth&&art.walkExtra.complete&&art.walkExtra.naturalWidth){
  const frame=Math.floor(phase)%4;let image=art.walkers,sx,sy,fw=art.walkers.naturalWidth/6,fh=art.walkers.naturalHeight/5;
  if(index<3){sx=(index*2+frame%2)*fw;sy=Math.floor(frame/2)*fh;}
  else if(index<6&&frame<2){sx=((index-3)*2+frame)*fw;sy=2*fh;}
  else if(index<6){image=art.walkExtra;fw=image.naturalWidth/3;fh=image.naturalHeight/2;sx=(index-3)*fw;sy=(frame-2)*fh;}
  else{sx=((index-6)*2+frame%2)*fw;sy=(3+Math.floor(frame/2))*fh;}
  ctx.drawImage(image,sx,sy,fw,fh,-width/2,-height+5,width,height);
 }
 else if(art.sprites.complete&&art.sprites.naturalWidth)ctx.drawImage(art.sprites,col*sw,row*sh,sw,sh,-width/2,-height+5,width,height);
 else {ellipse(0,-12,9,10,'#d9bd95');rect(-9,-4,18,23,color);}
 ctx.restore();
 ctx.font='bold 11px "Microsoft YaHei",sans-serif';const tw=ctx.measureText(name).width+13;
 rect(x-tw/2,y+10,tw,19,player?'#293e2dcf':'#263624b8');text(name,x,y+24,11,'#f7ebcc');
}
function building(b){rect(b.x+8,b.y+10,b.w,b.h,'#36534125');rect(b.x,b.y+22,b.w,b.h-22,'#d2c6a1');rect(b.x-9,b.y,b.w+18,37,b.color);for(let j=0;j<5;j++)rect(b.x-8,b.y+j*7,b.w+16,2,'#d7debd30');rect(b.x+14,b.y+53,29,25,'#66756b');rect(b.x+b.w-45,b.y+53,29,25,'#66756b');rect(b.x+b.w/2-16,b.y+b.h-42,32,42,'#625e45');rect(b.x+b.w/2-42,b.y+35,84,24,'#f0dfb6');text(b.name,b.x+b.w/2,b.y+52,14);rect(b.x+b.w/2-22,b.y+b.h,44,11,'#b9ae89')}
function drawVillage(){
 if(art.map.complete&&art.map.naturalWidth)ctx.drawImage(art.map,0,0,720,960);
 else rect(0,0,720,960,'#6a8065');
 const plots=DATA.map?.plots||[];
 for(let i=0;i<state.plots.length;i++){
  const plot=plots[i],p=state.plots[i];if(!plot||!p)continue;
  const mature=Core.mature(state,p);ctx.fillStyle=mature?'#dfc36d':'#7fad55';
  for(let j=0;j<5;j++){const x=plot.x+8+j%2*12,y=plot.y+7+Math.floor(j/2)*10;ellipse(x-3,y,5,3,'#3a6a31');ellipse(x+3,y-4,5,3,mature?'#e3c56a':'#73a746');}
 }
 if(fish){const f=DATA.map?.fish||{x:625,y:380};ellipse(f.x+12,f.y+12,5,3,state.time>=fish.due?'#e6b966':'#e2e0ca');}
 for(const b of DATA.buildings)mapSign(b.name,b.x+b.w/2,b.y+b.h/2+8);
 mapSign('钓鱼点',623,346);mapSign('农田',677,510);mapSign('村口',322,739);
}
function mapSign(label,x,y){ctx.font='bold 13px "Microsoft YaHei",sans-serif';const w=ctx.measureText(label).width+18;rect(x-w/2-1,y-15,w+2,23,'#cfb57b');rect(x-w/2,y-14,w,21,'#1b211ae8');text(label,x,y+1,13,'#f5e8c4');}
function drawInterior(){
 const b=DATA.buildings.find(b=>b.id===state.scene),image=art[state.scene];
 if(image?.complete&&image.naturalWidth){ctx.drawImage(image,0,0,720,960);return;}
 rect(0,0,720,960,'#334c40');rect(60,105,600,745,'#c9b78c');for(let i=0;i<18;i++)rect(60,110+i*40,600,2,'#b5a17b');rect(60,105,600,65,'#867858');rect(100,122,120,37,'#90aaa0');rect(500,122,120,37,'#90aaa0');text(b.name,360,78,27,'#e8dfbe');rect(155,270,410,77,'#89704c');rect(174,283,373,10,'#b09b70');text({smith:'铁砧 · 兵器架 · 炉火',elder:'账本 · 村志'}[state.scene],360,310,21,'#f4e4bd');for(let i=0;i<3;i++){rect(155+i*155,510,90,57,'#a08a63');rect(182+i*155,580,35,20,'#8c7757');}if(state.scene==='smith'){ellipse(578,396,27,28,'#a56840');ellipse(578,393,15,19,'#dfa663')}rect(321,825,78,29,'#344d3e');text('↓ 回到村中',360,890,18,'#e8dfbe');
}
function drawRoad(){rect(0,0,720,960,'#8fa77e');rect(298,0,125,960,'#caba91');for(let i=0;i<17;i++){tree(90+(i%2)*460,80+i*53,1.6);}text('村 外 古 道',360,160,30);text('江湖很远，脚下这一程已是自由。',360,240,19);text('后续区域尚未展开',360,280,16);text('↓ 返回清风村',360,897,19);}
const NPC_POS={herbs:[306,342],clinic:[430,480],clinicHelp:[300,430],homeRest:[350,590],smith:[360,405],elderDesk:[360,405],school:[360,330],tavern:[360,410],center:[365,590],tree:[260,590],farm:[682,625],river:[620,370],grocer:[130,662],hunt:[170,230],schoolyard:[478,580],tavernDoor:[451,686],well:[365,615]};
function npcAt(scene,pos,activity,line){return {scene,x:pos[0],y:pos[1],activity,line};}
function npcAway(activity,line){return {scene:'away',x:0,y:0,activity,line};}
function npcSchedule(n,h,day){
 const occasional=(cycle,offset=0)=>(day+offset)%cycle===0,role=n.role;
 if(role==='doctor'){
  if(h<5||h>=22)return npcAway('在楼上睡觉；若有急诊仍能被叫醒','夜深了，若不是急病，天亮再说。');
  if(h<7)return npcAt('village',NPC_POS.herbs,'整理、晾晒药材','晨露未干，药材正好翻一翻。');
  if(h<11)return npcAt('home',NPC_POS.clinic,'在医馆坐诊','坐吧，先说说哪里不舒服。');
  if(h<14)return npcAt('home',NPC_POS.homeRest,'吃饭、休息','午时歇一歇，药炉也该缓缓火。');
  if(h<18)return occasional(4,1)?npcAway('进山采药','今日进山找几味鲜药。'):npcAt('home',NPC_POS.clinicHelp,'炮制药材','这味药得慢慢焙，急不得。');
  return npcAt('home',NPC_POS.homeRest,'吃饭、看医书、整理药柜','把今日的药账理清，明日才不乱。');
 }
 if(role==='qinghe'){
  if(h<5||h>=22)return npcAway('在楼上睡觉','明日再聊吧。');
  if(h<7)return occasional(5,2)?npcAway('偶尔赖床','再睡一小会儿……'):npcAt('home',NPC_POS.clinicHelp,'起床帮忙弄药','这几包药，我来分好。');
  if(h<11)return npcAt('home',NPC_POS.clinicHelp,'在医馆帮忙','苏伯坐诊，我来抓药。');
  if(h<14)return npcAt('home',NPC_POS.homeRest,'回家吃饭','忙了一上午，总算能坐会儿了。');
  if(h<18){const pick=(day%3);return pick===0?npcAway('到村外采药','河坡那边该长新叶了。'):pick===1?npcAt('village',NPC_POS.river,'在河边辨认草药','临水的草木，药性也有些不同。'):npcAt('village',NPC_POS.schoolyard,'去邻家串门','村里绕一圈，总能遇见熟人。');}
  return occasional(4)?npcAt('tavern',[470,560],'去酒馆听外乡人聊天','外乡人的见闻，比话本还热闹。'):npcAt('home',NPC_POS.homeRest,'回家整理药材','今日采来的药草得趁鲜理好。');
 }
 if(role==='blacksmith'){
  if(h<5||h>=22)return npcAway('回家睡觉','炉火也该歇了。');
  if(h<7)return npcAt('smith',NPC_POS.smith,'起床开炉','火候起来，今日才好做活。');
  if(h<11)return npcAt('smith',NPC_POS.smith,'在铁匠铺工作','铛——铛——这锄头该磨了。');
  if(h<14)return npcAway('关炉吃饭','吃饱了才抡得动锤。');
  if(h<18)return npcAt('smith',NPC_POS.smith,'打铁、修理和制作委托','你那件东西，还得再等些火候。');
  return occasional(3,1)?npcAt('tavern',[300,575],'收炉后去酒馆喝酒','忙完这一日，喝一碗正好。'):npcAway('收炉回家','炉封好了，明日再开。');
 }
 if(role==='elder'){
  if(h<5||h>=22)return npcAt('elder',[360,650],'在家睡觉','夜里村中安稳，便好。');
  if(h<7)return npcAt('village',NPC_POS.tree,'起床在村中散步','清早绕村一圈，心里才踏实。');
  if(h<11)return npcAt('elder',NPC_POS.elderDesk,'在村长家处理村务','这几户的田界，还得重新核一核。');
  if(h<14)return npcAt('elder',[360,600],'吃饭、午休','村务再多，午时也得喘口气。');
  if(h<18)return occasional(2)?npcAt('village',NPC_POS.farm,'到田间巡视','地里的事，光看账本可不成。'):npcAt('village',NPC_POS.center,'在村中心与村民交谈','村里的事，大家坐下来总能说清。');
  return occasional(3)?npcAt('village',NPC_POS.tree,'在老树下乘凉','晚风一吹，老树下最舒服。'):npcAt('elder',[360,560],'回家整理村务','今日的事记一笔，免得明日忘了。');
 }
 if(role==='teacher'){
  if(h<5||h>=22)return npcAway('回家睡觉','书明日还读得完。');
  if(h<7)return npcAt('school',NPC_POS.school,'起床读书','清晨读书，心最静。');
  if(h<11)return npcAt('school',NPC_POS.school,'在私塾授课','今日先把昨日那篇背熟。');
  if(h<14)return npcAway('吃饭、休息','午后再来。');
  if(h<18)return npcAt('school',NPC_POS.school,'看书、写字、替村民写信','信里的话要写得明白，也要写得妥帖。');
  return occasional(4,1)?npcAt('tavern',[420,575],'去酒馆小坐','偶尔听听酒客闲谈，也算读世情。'):npcAway('回家读书','灯下再读几页。');
 }
 if(role==='tavernkeeper'){
  if(h<7)return npcAway('睡觉，起床较晚','天还早，酒馆尚未开门。');
  if(h<11)return npcAt('tavern',NPC_POS.tavern,'开门、备菜','灶火刚起，菜还得备齐。');
  if(h<14)return npcAt('tavern',NPC_POS.tavern,'照应第一波客人','热汤和面都在灶上，别急。');
  if(h<18)return npcAt('tavern',NPC_POS.tavern,'营业，和客人聊天','南来北往的人，故事都不一样。');
  if(h<22)return npcAt('tavern',NPC_POS.tavern,'酒馆最忙，江湖消息渐多','今晚外乡客多，话也格外多。');
  return h<24?npcAt('tavern',NPC_POS.tavern,'打烊、收拾桌席','最后一桌散了，就该收拾了。'):npcAway('睡觉','酒馆已经熄灯。');
 }
 if(role==='grocer'){
  if(h<5||h>=22)return npcAway('睡觉','铺子明早再开。');
  if(h<7)return npcAt('village',NPC_POS.grocer,'整理货物','盐袋和针线都得重新摆好。');
  if(h<11)return npcAt('village',NPC_POS.grocer,'开店','缺什么就看看，都是村里用得上的。');
  if(h<14)return npcAway('吃饭，店铺短暂清闲','铺门虚掩着，晚些再来。');
  if(h<18)return npcAt('village',NPC_POS.grocer,'营业、进货整理','新到的麻绳，结实得很。');
  return npcAway('关门回家','今日收摊了。');
 }
 if(role==='hunter'){
  if(h<5||h>=22)return npcAway('睡觉','山里走一天，也该歇了。');
  if(h<14)return npcAway(h<7?'带弓进山':'在山中狩猎','今日循着兽迹往北去。');
  if(h<18)return npcAt('village',NPC_POS.hunt,'返回村庄、处理猎物','先把皮肉收拾干净，免得糟蹋。');
  return occasional(3)?npcAt('tavern',[250,590],'去酒馆坐坐','山里的见闻，配酒才好讲。'):npcAway('回家歇息','弓弦也得松一松。');
 }
 if(role==='fisher'){
  if(h<5||h>=22)return npcAway('睡觉','河水夜里凉，不宜久留。');
  if(h<11)return npcAt('village',NPC_POS.river,'在河边捕鱼','清早的鱼最肯咬钩。');
  if(h<14)return npcAt('village',NPC_POS.tree,'回村，在树下休息','晒晒网，也歇歇腿。');
  if(h<18)return occasional(2)?npcAt('village',NPC_POS.river,'继续捕鱼','下午水暖，换个浅湾试试。'):npcAt('village',[610,405],'在河边修网','网眼破了，鱼可不会自己留下。');
  return npcAway('回家','鱼篓收了，明早再来。');
 }
 if(role==='farmer'){
  if(h<5||h>=22)return npcAway('睡觉','庄稼不等人，人也得睡。');
  if(h<11)return npcAt('village',NPC_POS.farm,h<7?'起床、前往农田':'在田间劳作','趁日头不烈，多做些活。');
  if(h<14)return npcAt('village',NPC_POS.tree,'回村吃饭，在树下休息','吃口干粮，下午还得下地。');
  if(h<18)return npcAt('village',NPC_POS.farm,'继续在田间劳作','再理完这几垄就收工。');
  return npcAt('village',NPC_POS.center,'收工回村，吃饭聊天','今年雨水还算顺，苗长得不错。');
 }
 if(role==='child'){
  if(h<5||h>=22)return npcAway('睡觉','明天还要早起。');
  if(h<7)return npcAway('起床，在家准备上学','书袋放哪儿了……');
  if(h<11)return npcAt('school',[360,470],'在私塾上课','先生，我真的没有打瞌睡。');
  if(h<14)return npcAway('回家吃饭','下午不用背书吧？');
  if(h<18){const spots=[NPC_POS.center,NPC_POS.river,NPC_POS.tree];return npcAt('village',spots[day%spots.length],'在村中心、河边或老树附近玩耍','今日轮到谁来捉人？');}
  return npcAway('回家','再玩一会儿就要挨骂了。');
 }
 if(h<5||h>=22)return npcAway('睡觉','夜深了。');
 if(h<7)return npcAt('village',NPC_POS.well,'做饭、打水、准备出门','先把水缸添满。');
 if(h<11)return npcAt('village',NPC_POS.grocer,'做家务、买东西','家里盐快用完了。');
 if(h<14)return npcAway('吃饭、休息','午时歇一会儿。');
 if(h<18)return npcAt('village',occasional(2)?NPC_POS.schoolyard:NPC_POS.grocer,'工作、串门、买东西','顺路问问邻家近来可好。');
 return npcAt('village',NPC_POS.tree,'回家前在老树附近聊天','天凉快了，大家坐会儿再散。');
}
function updateNPC(dt){
 const h=state.time%1440/60,day=Math.floor(state.time/1440);
 villagers.forEach((n,i)=>{
  const schedule=npcSchedule(n,h,day),{scene,x:tx,y:ty}=schedule;n.activity=schedule.activity;n.line=schedule.line||n.line;
  if(n.scene!==scene){n.scene=scene;n.x=tx;n.y=ty;n.moving=false;}
  const d=Math.hypot(tx-n.x,ty-n.y);
  n.moving=false;
  if(d>1){const distance=Math.min(d,dt*30),dx=(tx-n.x)/d*distance,dy=(ty-n.y)/d*distance,nx=n.x+dx,ny=n.y+dy;n.facing=directionFromDelta(dx,dy,n.facing);n.movePhase+=distance*.09;if(scene!=='village'||!Core.solid(nx,ny)){n.x=nx;n.y=ny;n.moving=true;}else{n.x=tx;n.y=ty;}}
  n.bubble=(frame/60+i*2.1)%19<4;
 });
}
function interactionTargets(){
 const list=[],scene=state.scene;
 if(scene==='village'){
  for(const b of DATA.buildings)list.push({x:b.door.x,y:b.door.y,type:'door',id:b.id,label:'进入'+b.name,hitRects:[{x:b.x-4,y:b.y-4,w:b.w+8,h:b.h+40}]});
  DATA.map.plots.forEach((p,i)=>{const crop=state.plots[i];list.push({x:p.interact.x,y:p.interact.y,type:'plot',id:i,label:`田地${i+1} · ${crop?(Core.mature(state,crop)?'收获'+crop.crop:'照看'+crop.crop):'播种'}`,reach:38,hitRects:[{x:p.x-5,y:p.y-5,w:p.w+10,h:p.h+16}]});});
  const f=DATA.map.fish,r=DATA.map.road;
  list.push({x:f.x,y:f.y,type:'fish',label:fish?(state.time>=fish.due?'鱼咬钩了 · 收杆':'等待 / 收杆'):'河边钓鱼',reach:f.reach,hitRects:[{x:540,y:325,w:110,h:75}]},
   {x:r.x,y:r.y,type:'road',label:'沿路出村',reach:r.reach,hitRects:[{x:282,y:715,w:74,h:100},{x:280,y:850,w:100,h:96}]});
 }else if(scene==='road')list.push({x:360,y:882,type:'return',label:'返回清风村',hitRects:[{x:285,y:840,w:150,h:80}]});
 else {
  const room=DATA.interiors[scene];
  if(room){
   if(room.exitVillage)list.push({x:360,y:805,type:'exit',label:'回到村中',hitRects:[{x:290,y:770,w:140,h:150}]});
   if(room.service){const p=room.service;list.push({x:p.x,y:p.y,type:'service',label:{home:'药柜、旧医书与床铺',school:'读书与上课',tavern:'茶酒与鲜货'}[scene],reach:p.reach||150,hitRects:[room.serviceHit||{x:145,y:255,w:430,h:135}]});}
   for(const t of room.transitions||[])list.push({x:t.x,y:t.y,type:'transition',id:t.id,label:t.label,reach:t.reach||70,hitRects:[t.hit],to:t.to,spawn:t.spawn});
   for(const item of room.inspects||[])list.push({x:item.x,y:item.y,type:'inspect',id:item.id,label:item.label,reach:item.reach||80,hitRects:[item.hit],title:item.title,body:item.body});
  }else{
   const servicePoint={x:360,y:377,reach:150};
   list.push({x:360,y:805,type:'exit',label:'回到村中',hitRects:[{x:290,y:770,w:140,h:150}]},{x:servicePoint.x,y:servicePoint.y,type:'service',label:{smith:'购买、修理与打造',elder:'村务与村志'}[scene],reach:servicePoint.reach,hitRects:[{x:145,y:255,w:430,h:135}]});
  }
 }
 for(const n of villagers)if(n.scene===scene)list.push({x:n.x,y:n.y,type:'npc',id:n.name,n,label:'与'+n.name+'闲谈',reach:43,hitRects:[{x:n.x-28,y:n.y-44,w:56,h:74}]});
 return list.map(t=>({...t,scene,reach:t.reach||58}));
}
function targetPoint(target){return target.type==='npc'?target.n:target;}
function canInteract(target){const p=targetPoint(target);return target.scene===state.scene&&(target.type!=='npc'||target.n.scene===state.scene)&&Math.hypot(state.x-p.x,state.y-p.y)<=target.reach;}
function nearbyTargets(){return interactionTargets().filter(canInteract).sort((a,b)=>{const p=targetPoint(a),q=targetPoint(b);return Math.hypot(state.x-p.x,state.y-p.y)-Math.hypot(state.x-q.x,state.y-q.y);});}
function findNear(){return nearbyTargets()[0]||null;}
function blockedAt(scene,x,y){
 if(scene==='village')return Core.solid(x,y);if(scene==='road')return x<270||x>450||y<310||y>920;
 const room=DATA.interiors[scene];
 if(room)return x<35||x>685||y<35||y>850||room.solids.some(r=>Core.inRect(x,y,r));
 return x<80||x>640||y<180||y>827||(x>145&&x<575&&y>255&&y<360)||(y>495&&y<605&&[155,310,465].some(a=>x>a-10&&x<a+100));
}
function blocked(x,y){return blockedAt(state.scene,x,y);}
function navigator(scene=state.scene){if(!navigationCache.has(scene))navigationCache.set(scene,Navigation.create(DATA.width,DATA.height,(x,y)=>blockedAt(scene,x,y)));return navigationCache.get(scene);}
function cancelTravel(message='点击道路或空地，自动走过去。'){travel=null;$('stop').hidden=true;$('walk-status').textContent=message;}
function requestWalk(point,target=null,silent=false){
 if(modal)return false;
 const nav=navigator(),blockedGoal=!target&&blocked(point.x,point.y);let snapped=blockedGoal;
 let path=blockedGoal?nav.planNearest(state,point):nav.plan(state,point,{exact:!target,maxSnap:target?Math.min(35,target.reach-7):14});
 if(!path&&!target){path=nav.planNearest(state,point);snapped=!!path;}
 if(!path){cancelTravel('这里暂时走不过去。');if(!silent)tell('这里无法落脚，请点击道路、空地或可交互的对象。');return false;}
 const landing=snapped?path[path.length-1]:point;
 seated=false;travel={points:path,scene:state.scene,target,goal:{x:landing.x,y:landing.y},requested:{x:point.x,y:point.y},replan:0};
 $('stop').hidden=false;$('walk-status').textContent=target?'正在走近：'+target.label:snapped?'目标处无法落脚，已改往最近的空地。':'正在前往点击的位置';
 if(snapped&&!silent)tell('那里无法落脚，已自动选择最近的可到达位置。');return true;
}
function advanceTravel(dt){
 if(!travel||modal)return;
 if(travel.scene!==state.scene){cancelTravel();return;}
 const target=travel.target;
 if(target?.type==='npc'){
  if(target.n.scene!==state.scene){cancelTravel('这位村民已经去了别处。');return;}
  travel.replan+=dt;const p=targetPoint(target);
  if(travel.replan>=.5&&Math.hypot(p.x-travel.goal.x,p.y-travel.goal.y)>16){requestWalk(p,target,true);if(!travel)return;}
 }
 let budget=115*dt;
 while(travel&&budget>0&&travel.points.length){
  const p=travel.points[0],distance=Math.hypot(p.x-state.x,p.y-state.y);
  if(distance<.01){travel.points.shift();continue;}
  const step=Math.min(budget,distance),dx=(p.x-state.x)/distance*step,dy=(p.y-state.y)/distance*step,x=state.x+dx,y=state.y+dy;
  if(blocked(x,y)){cancelTravel('前路有障碍，请重新点击目的地。');return;}
  playerFacing=directionFromDelta(dx,dy,playerFacing);playerWalkPhase+=step*.085;state.x=x;state.y=y;budget-=step;if(step>=distance)travel.points.shift();
 }
 if(travel&&!travel.points.length){const target=travel.target;cancelTravel(target?'已经走近，点击「'+target.label+'」即可。':'已到达。点击新的位置继续行走。');save();}
}
function hitTarget(point){
 const priority={npc:0,plot:1,fish:2,service:2,transition:2,inspect:2,exit:2,return:2,door:3,road:3};
 return interactionTargets().filter(t=>t.hitRects.some(r=>Core.inRect(point.x,point.y,r)))
  .sort((a,b)=>priority[a.type]-priority[b.type]||Math.hypot(point.x-a.x,point.y-a.y)-Math.hypot(point.x-b.x,point.y-b.y))[0]||null;
}
function clickMap(point){
 if(modal)return;
 const target=hitTarget(point);
 if(target&&canInteract(target)){interact(target);return;}
 requestWalk(target?targetPoint(target):point,target);
}
function canvasPoint(event){const r=canvas.getBoundingClientRect();return {x:(event.clientX-r.left)*canvas.width/r.width,y:(event.clientY-r.top)*canvas.height/r.height};}
function renderNearby(){
 const targets=nearbyTargets(),signature=(modal?'modal':state.scene)+targets.map(t=>t.type+':'+t.id+':'+t.label).join('|');
 if(signature===nearSignature)return;nearSignature=signature;$('near-actions').replaceChildren();
 if(modal)return;
 for(const target of targets){const b=document.createElement('button');b.textContent=target.label;b.onclick=()=>interact(target);$('near-actions').append(b);}
}
function drawNavigation(){
 if(travel){const p=travel.goal,pulse=3+Math.sin(frame*.12)*2;ctx.save();ctx.strokeStyle='#fff0a8';ctx.fillStyle='#5a3c1daa';ctx.lineWidth=2;ctx.beginPath();ctx.ellipse(p.x,p.y+3,12+pulse,6+pulse*.35,0,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.beginPath();ctx.moveTo(p.x,p.y-14-pulse);ctx.lineTo(p.x-6,p.y-5);ctx.lineTo(p.x+6,p.y-5);ctx.closePath();ctx.fillStyle='#fff0a8';ctx.fill();ctx.restore();return;}
 for(const target of nearbyTargets()){const p=targetPoint(target);ctx.strokeStyle='#f3dd85';ctx.lineWidth=2;ctx.beginPath();ctx.ellipse(p.x,p.y+4,target.type==='plot'?10:17,6,0,0,Math.PI*2);ctx.stroke();}
}
function sceneLabel(scene){if(scene==='village')return '春日漫游';if(scene==='road')return '村外古道';return DATA.interiors[scene]?.label||DATA.buildings.find(b=>b.id===scene)?.name||scene;}
function tick(now){
 const elapsedSeconds=last?Math.max(0,(now-last)/1000):0;
 const dt=Math.min(elapsedSeconds,.1);last=now;frame+=dt*60;
 Core.advance(state,elapsedSeconds*DATA.gameMinutesPerRealSecond*state.speed);
 advanceTravel(dt);
 const f=DATA.map.fish;
 if(fish&&(state.scene!=='village'||Math.hypot(state.x-f.x,state.y-f.y)>f.reach+28)){
  fish=null;tell('离开了水边，你把鱼线收了起来。');
 }
 updateNPC(dt);
 if(state.scene==='village')drawVillage();else if(state.scene==='road')drawRoad();else drawInterior();
 near=findNear();
 drawNavigation();
 const people=villagers.filter(n=>n.scene===state.scene).map(n=>({...n}));
 people.push({x:state.x,y:state.y,color:'#f0e6c8',name:seated?'你 · 歇坐':'你',player:true,moving:!!travel&&!modal,movePhase:playerWalkPhase,facing:playerFacing});
 people.sort((a,b)=>a.y-b.y).forEach(n=>person(n.x,n.y,n.color,n.name,n.player,n.sprite,{moving:n.moving,phase:n.movePhase,facing:n.facing}));
 const h=state.time%1440/60,night=h<6||h>=19;
 rect(0,0,720,960,night?'#14234366':h>17?'#b3854320':'#ffffff00');
 for(const n of villagers){
  if(n.scene!==state.scene||!n.bubble)continue;
  const line=h<6||h>=21?'呼……':n.line,w=Math.min(340,line.length*13+20);
  const x=Math.max(w/2+5,Math.min(715-w/2,n.x));
  rect(x-w/2,n.y-61,w,28,'#f5eed8ee');text(line,x,n.y-42,13);
 }
 renderNearby();
 $('date').textContent=Core.date(state.time)+(night?' · 夜':' · 昼');
 $('place').textContent=sceneLabel(state.scene);
 $('speed').textContent='时间 ×'+state.speed;$('toast').style.opacity=now<toastUntil?1:0;
 if(saveTimer+4000<now){save();saveTimer=now;}requestAnimationFrame(tick);
}
$('bag').onclick=inventory;$('close').onclick=close;
$('dialogue-next').onclick=advanceDialogue;$('dialogue-close').onclick=close;
$('stop').onclick=()=>cancelTravel('已停下。点击新的位置继续行走。');
$('speed').onclick=()=>{state.speed=state.speed===1?8:1;save();};
$('wait').onclick=()=>{cancelTravel();advance(120);tell('树影挪了位置，一时辰过去了。');};
canvas.onpointerdown=e=>{if(modal||e.button>0)return;e.preventDefault();pointerStart={x:e.clientX,y:e.clientY,scene:state.scene};canvas.setPointerCapture(e.pointerId);};
canvas.onpointerup=e=>{const start=pointerStart;pointerStart=null;if(!start||modal||start.scene!==state.scene||Math.hypot(e.clientX-start.x,e.clientY-start.y)>10)return;e.preventDefault();clickMap(canvasPoint(e));};
canvas.onpointercancel=()=>pointerStart=null;
canvas.onpointermove=e=>{canvas.style.cursor=hitTarget(canvasPoint(e))?'pointer':'crosshair';};
window.addEventListener('keydown',e=>{if(e.key==='Escape')close();else if(dialogue&&!e.repeat&&(e.key==='Enter'||e.key===' ')){e.preventDefault();advanceDialogue();}});
window.addEventListener('blur',save);
document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelTravel();save();}});
window.addEventListener('pagehide',save);cancelTravel();tell('点击目的地，自在走走。走近人物或地点后，再点击互动。');requestAnimationFrame(tick);

