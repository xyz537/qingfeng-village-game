const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assert=require('node:assert/strict');

const noop=()=>{};
const drawCalls=[],canvasOps=[];
const context=new Proxy({drawImage:(...args)=>drawCalls.push(args),lineTo:(...args)=>canvasOps.push(['lineTo',...args]),moveTo:(...args)=>canvasOps.push(['moveTo',...args]),ellipse:(...args)=>canvasOps.push(['ellipse',...args]),translate:(...args)=>canvasOps.push(['translate',...args]),rotate:(...args)=>canvasOps.push(['rotate',...args]),scale:(...args)=>canvasOps.push(['scale',...args]),save:()=>canvasOps.push(['save']),restore:()=>canvasOps.push(['restore']),measureText:value=>({width:String(value).length*13})},{get:(target,key)=>key in target?target[key]:noop});
const elements={};
const windowListeners={};
const el=()=>({
 textContent:'',hidden:true,style:{},dataset:{},children:[],width:720,height:960,
 append(child){this.children.push(child)},replaceChildren(){this.children=[]},
 getContext:()=>context,setPointerCapture:noop,
 getBoundingClientRect:()=>({left:20,top:40,width:360,height:480})
});
class ImageMock{
 constructor(){this.complete=true;this.naturalWidth=1086;this.naturalHeight=1448;this.src='';}
}
const box={
 console,Image:ImageMock,performance:{now:()=>0},
 localStorage:{getItem:()=>null,setItem:noop},
 document:{getElementById:id=>elements[id]??=el(),createElement:el,querySelectorAll:()=>[],addEventListener:noop},
 window:{addEventListener:(name,listener)=>windowListeners[name]=listener},requestAnimationFrame:noop
};
vm.createContext(box);
for(const file of ['data.js','engine.js','navigation.js','combat.js','game.js']){
 vm.runInContext(fs.readFileSync(path.join(__dirname,file),'utf8'),box,{filename:file});
}
const DATA=vm.runInContext('DATA',box);
const Core=vm.runInContext('Core',box);
const Navigation=vm.runInContext('Navigation',box);
const Combat=vm.runInContext('Combat',box);
const mapImage=vm.runInContext('art.map',box);
const spriteImage=vm.runInContext('art.sprites',box);
const walkImage=vm.runInContext('art.walkers',box);
const walkExtraImage=vm.runInContext('art.walkExtra',box);
const banditImage=vm.runInContext('art.bandit',box);
const directionalImages=vm.runInContext('art.directions',box);
const interiorImages=Object.fromEntries(Object.keys(DATA.interiors).map(id=>[id,vm.runInContext(`art.${id}`,box)]));
const run=script=>vm.runInContext(script,box);
const check=expr=>assert.equal(run(expr),true,expr);

const freshBattle=Combat.createBattle();
assert.equal(freshBattle.status,'running');
assert.equal(freshBattle.result,null);
assert.equal(freshBattle.log.length,0);
assert.deepEqual(
 Object.fromEntries(['hp','maxHp','innerPower','maxInnerPower','attack','defense','attackInterval','moveSpeed','aiLevel','weapon','technique'].map(key=>[key,freshBattle.fighters.player[key]])),
 {hp:100,maxHp:100,innerPower:50,maxInnerPower:50,attack:18,defense:10,attackInterval:.75,moveSpeed:95,aiLevel:1,weapon:'长剑',technique:'剑击'}
);
assert.deepEqual(
 Object.fromEntries(['hp','maxHp','innerPower','maxInnerPower','attack','defense','attackInterval','moveSpeed','aiLevel','weapon','technique'].map(key=>[key,freshBattle.fighters.bandit[key]])),
 {hp:120,maxHp:120,innerPower:0,maxInnerPower:0,attack:25,defense:8,attackInterval:1.65,moveSpeed:88,aiLevel:0,weapon:'柴刀',technique:'挥刀'}
);
assert.deepEqual({...freshBattle.fighters.player.allowed},{attack:true,parry:true,dodge:true,guard:false});
assert.deepEqual({...freshBattle.fighters.bandit.allowed},{attack:true,parry:false,dodge:false,guard:false});
assert(freshBattle.fighters.player.x<freshBattle.fighters.bandit.x,'fighters must begin on opposing sides');

const advanceFight=(battle,seconds,random=()=>.99)=>Combat.step(battle,seconds,random);
const ai0Battle=Combat.createBattle({player:{aiLevel:0,allowed:{parry:false,dodge:false,guard:false}}});
const ai0Start=ai0Battle.fighters.player.x;
advanceFight(ai0Battle,.1);
assert(ai0Battle.fighters.player.x>ai0Start,'AI0 should approach an out-of-range target');
advanceFight(ai0Battle,3);
assert(ai0Battle.fighters.player.attacks>0,'AI0 should attack in range');
assert(!ai0Battle.log.some(entry=>/招架|闪避|护体/.test(entry.text)),'AI0 must not use trained defenses');

const fleeingBattle=Combat.createBattle({bandit:{hp:20,x:530}});
advanceFight(fleeingBattle,.05,()=>0);
assert.equal(fleeingBattle.fighters.bandit.action.kind,'flee','low-health AI0 should be able to flee');

const resoluteBattle=Combat.createBattle({player:{x:300,allowed:{attack:false}},bandit:{hp:20,x:365}});
advanceFight(resoluteBattle,.05,()=>.99);
advanceFight(resoluteBattle,2,()=>0);
assert.equal(resoluteBattle.fighters.bandit.escaping,false,'an AI0 fighter should roll the low-health flee chance only once');

const reactingBattle=Combat.createBattle({player:{hp:40,x:300},bandit:{x:365}});
reactingBattle.fighters.bandit.action={kind:'windup',remaining:.4,resolved:false};
advanceFight(reactingBattle,.05,()=>.2);
assert(['parry','dodge'].includes(reactingBattle.fighters.player.action.kind),'AI1 should react to a visible windup');

const masterBattle=Combat.createBattle({player:{aiLevel:2,hp:30,allowed:{guard:true},x:300},bandit:{attack:40,x:365}});
masterBattle.fighters.bandit.action={kind:'windup',remaining:.4,resolved:false};
advanceFight(masterBattle,.05);
assert.equal(masterBattle.fighters.player.innerPower,40,'AI2 guard should spend exactly 10 inner power');
assert(masterBattle.fighters.player.guardRemaining>1.9,'AI2 guard should last about two seconds');
advanceFight(masterBattle,.05);
assert.equal(masterBattle.fighters.player.innerPower,40,'active guard must not spend inner power twice');

const parryBattle=Combat.createBattle({player:{x:300},bandit:{x:365}});
parryBattle.fighters.player.action={kind:'parry',remaining:.5,resolved:false};
parryBattle.fighters.bandit.action={kind:'windup',remaining:.01,resolved:false};
parryBattle.fighters.player.cooldown=99;
parryBattle.fighters.bandit.cooldown=99;
advanceFight(parryBattle,.05);
assert.equal(parryBattle.fighters.player.hp,94,'parry should reduce a 20-point hit to about 30%');

const dodgeBattle=Combat.createBattle({player:{hp:40,x:300,y:650},bandit:{x:365}});
dodgeBattle.fighters.bandit.action={kind:'windup',remaining:.4,resolved:false};
const dodgeY=dodgeBattle.fighters.player.y;
advanceFight(dodgeBattle,.05,()=>.2);
assert.equal(dodgeBattle.fighters.player.action.kind,'dodge');
assert.notEqual(dodgeBattle.fighters.player.y,dodgeY,'dodge should cause a side or rear displacement');
dodgeBattle.fighters.bandit.action={kind:'windup',remaining:.01,resolved:false};
dodgeBattle.fighters.bandit.cooldown=99;
const dodgeHp=dodgeBattle.fighters.player.hp;
advanceFight(dodgeBattle,.05);
assert.equal(dodgeBattle.fighters.player.hp,dodgeHp,'a dodge window should make the incoming attack miss');

const guardBattle=Combat.createBattle({player:{x:300},bandit:{x:365}});
guardBattle.fighters.player.guardRemaining=2;
guardBattle.fighters.player.action={kind:'guard',remaining:.35,resolved:false};
guardBattle.fighters.bandit.action={kind:'windup',remaining:.01,resolved:false};
guardBattle.fighters.player.cooldown=99;
guardBattle.fighters.bandit.cooldown=99;
advanceFight(guardBattle,.05);
assert.equal(guardBattle.fighters.player.hp,88,'guard should reduce a 20-point hit by 40%');
guardBattle.fighters.bandit.x=650;
advanceFight(guardBattle,2.1);
assert.equal(guardBattle.fighters.player.guardRemaining,0,'guard should expire after two seconds');
assert(guardBattle.maxStep<=.05,'large elapsed updates must be sliced into stable fixed steps');

const speedBattle=Combat.createBattle({player:{x:300},bandit:{x:365}});
advanceFight(speedBattle,3.3,()=>.99);
assert(speedBattle.fighters.player.attacks>speedBattle.fighters.bandit.attacks,'the faster player should attack more often in the same window');

const finishBattle=Combat.createBattle({player:{x:300},bandit:{x:365,hp:1}});
finishBattle.fighters.player.action={kind:'windup',remaining:.01,resolved:false};
advanceFight(finishBattle,.05);
assert.equal(finishBattle.status,'player_win');
const finishLogCount=finishBattle.log.length;
advanceFight(finishBattle,1);
assert.equal(finishBattle.log.length,finishLogCount,'a finished battle must not finalize twice');

const escapeBattle=Combat.createBattle({bandit:{hp:20,x:600}});
advanceFight(escapeBattle,.05,()=>0);
advanceFight(escapeBattle,2,()=>0);
assert.equal(escapeBattle.status,'bandit_fled');

assert(fs.existsSync(path.join(__dirname,mapImage.src)),'village map asset is missing');
assert(fs.existsSync(path.join(__dirname,spriteImage.src)),'villager sprite asset is missing');
assert(fs.existsSync(path.join(__dirname,walkImage.src)),'walking sprite atlas is missing');
assert(fs.existsSync(path.join(__dirname,walkExtraImage.src)),'supplemental walking sprite atlas is missing');
assert.equal(banditImage.src,'assets/bandit.png');
assert(fs.existsSync(path.join(__dirname,banditImage.src)),'bandit character asset is missing');
for(const [index,image] of directionalImages.entries())assert(fs.existsSync(path.join(__dirname,image.src)),`directional sprite ${index} is missing`);
for(const [id,image] of Object.entries(interiorImages))assert(fs.existsSync(path.join(__dirname,image.src)),id+' interior asset is missing');
run('tick(100);tick(200)');
assert(drawCalls.some(args=>args[0]===mapImage),'village map was not drawn');
assert(drawCalls.some(args=>directionalImages.includes(args[0])),'directional villagers were not drawn');
run("person(200,200,'#fff','你',true,0,{moving:true,phase:0,facing:'up'});person(240,200,'#fff','顾先生',false,3,{moving:true,phase:1,facing:'left'})");
assert(drawCalls.some(args=>args[0]===directionalImages[0]&&args[2]===directionalImages[0].naturalHeight/4),'player back-facing row was not drawn');
assert(drawCalls.some(args=>args[0]===directionalImages[3]&&args[2]===directionalImages[3].naturalHeight/2),'NPC left-facing row was not drawn');
assert.equal(run("directionFromDelta(0,-4,'down')"),'up');
assert.equal(run("directionFromDelta(3,0,'down')"),'right');
const banditPoses={};
for(const kind of ['idle','approach','windup','hurt','down']){
 const start=canvasOps.length;
 run(`drawBandit(360,500,{action:{kind:'${kind}'},facing:'left'})`);
 assert(drawCalls.some(args=>args[0]===banditImage),kind+' must draw the bandit image');
 banditPoses[kind]=JSON.stringify(canvasOps.slice(start));
}
assert.equal(new Set(Object.values(banditPoses)).size,5,'bandit combat states need distinct poses');
assert.equal(DATA.gameMinutesPerRealSecond,1,'24 real minutes must equal one game day');
run('state=Core.fresh();last=1000;tick(1441000)');
check('state.time===Core.fresh().time+1440');
run('state.speed=8;tick(1442000)');
check('state.time===Core.fresh().time+1448');
run(`for(const id of ['home','school','tavern','smith','elder']){
 enter(id);tick(300);service(id);leave();
}for(const id of ['home2','homeyard','tavern2']){
 state.scene=id;state.x=DATA.interiors[id].spawn.x;state.y=DATA.interiors[id].spawn.y;tick(301);
}state=Core.fresh();`);
for(const [id,image] of Object.entries(interiorImages))assert(drawCalls.some(args=>args[0]===image),id+' interior was not drawn');

const role=id=>DATA.npcs.find(n=>n.id===id);
assert.equal(run("npcSchedule(DATA.npcs.find(n=>n.id==='suhuairen'),9,0).scene"),'home');
assert.equal(run("npcSchedule(DATA.npcs.find(n=>n.id==='guteacher'),9,0).scene"),'school');
assert.equal(run("npcSchedule(DATA.npcs.find(n=>n.id==='zhaotieshan'),9,0).scene"),'smith');
assert.equal(run("npcSchedule(DATA.npcs.find(n=>n.id==='zhoubo'),9,0).scene"),'elder');
assert.equal(run("npcSchedule(DATA.npcs.find(n=>n.id==='hunter'),9,0).scene"),'away');
assert.equal(run("npcSchedule(DATA.npcs.find(n=>n.id==='schoolchild'),9,0).scene"),'school');
assert(run("npcSchedule(DATA.npcs.find(n=>n.id==='fisher'),6,0).activity.includes('捕鱼')"));
assert(run("npcSchedule(DATA.npcs.find(n=>n.id==='farmer'),16,0).activity.includes('劳作')"));
assert(run("npcSchedule(DATA.npcs.find(n=>n.id==='tavernkeeper'),20,0).activity.includes('最忙')"));
assert.equal(run("npcSchedule(DATA.npcs.find(n=>n.id==='grocer'),20,0).scene"),'away');
assert.equal(run("npcSchedule(DATA.npcs.find(n=>n.id==='suhuairen'),23,0).scene"),'away');
assert.equal(run("npcSchedule(DATA.npcs.find(n=>n.id==='tavernkeeper'),3,0).scene"),'away');
assert(run("npcSchedule(DATA.npcs.find(n=>n.id==='suqinghe'),16,0).activity.length>2"));
assert(run("npcSchedule(DATA.npcs.find(n=>n.id==='guteacher'),20,3).scene==='tavern'"));

function reachableCells(start,step=4){
 const cols=Math.ceil(DATA.width/step),rows=Math.ceil(DATA.height/step);
 const index=(x,y)=>y*cols+x;
 const seen=new Uint8Array(cols*rows),queue=new Int32Array(cols*rows);
 const sx=Math.round(start.x/step),sy=Math.round(start.y/step);
 assert(!Core.solid(start.x,start.y),'spawn is blocked');
 let head=0,tail=0;
 seen[index(sx,sy)]=1;queue[tail++]=index(sx,sy);
 while(head<tail){
  const cell=queue[head++],x=cell%cols,y=Math.floor(cell/cols);
  for(const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]){
   const nx=x+dx,ny=y+dy;
   if(nx<0||nx>=cols||ny<0||ny>=rows)continue;
   const next=index(nx,ny);
   if(seen[next]||Core.solid(nx*step,ny*step))continue;
   seen[next]=1;queue[tail++]=next;
  }
 }
 return point=>seen[index(Math.round(point.x/step),Math.round(point.y/step))]===1;
}
const reachable=reachableCells(DATA.map.spawn);
const destinations=[
 ...DATA.buildings.map(b=>['door: '+b.id,b.door]),
 ...DATA.map.plots.map((plot,i)=>['field: '+i,plot.interact]),
 ['fishing pier',DATA.map.fish],
 ['village road',DATA.map.road]
];
for(const [name,point] of destinations){
 assert(!Core.solid(point.x,point.y),name+' is blocked');
 assert(reachable(point),name+' cannot be reached from the spawn');
}
assert(Core.solid(300,270),'apothecary body should block walking');
assert(Core.solid(600,650),'river should block walking');
assert(Core.solid(90,90),'northwest mountain should block walking');
assert(Core.solid(450,870),'south mountain should block walking');
assert(Core.solid(150,174),'hunting-ground fence should block walking');
assert(Core.solid(372,646),'tree trunk should block walking');
assert(Core.solid(240,140),'dense northern woodland should block walking');
assert(Core.solid(25,520),'wooded western map edge should block walking');
assert(Core.solid(180,700),'southwest woodland should block walking');
assert(Core.solid(460,730),'southeast woodland should block walking');
assert(Core.solid(240,370),'covered market stall should block walking');
assert(!Core.solid(306,331),'apothecary gate should remain open');
assert(!Core.solid(320,790),'village gate should remain open');
assert(!Core.solid(600,470),'relocated stone bridge should be walkable');
assert(Core.solid(600,525),'old stone bridge location should now be river');
assert(!Core.solid(DATA.map.fish.x,DATA.map.fish.y),'fishing pier should be walkable');

const villageNavigation=Navigation.create(DATA.width,DATA.height,(x,y)=>Core.solid(x,y));
for(const [name,point] of destinations){
 const route=villageNavigation.plan(DATA.map.spawn,point);
 assert(route&&route.length,name+' has no automatic walking route');
 let previous=DATA.map.spawn;
 for(const waypoint of route){assert(villageNavigation.clear(previous,waypoint),name+' route crosses an obstacle');previous=waypoint;}
 assert(Math.hypot(previous.x-point.x,previous.y-point.y)<.01,name+' route ends at the wrong destination');
}
assert.equal(villageNavigation.plan(DATA.map.spawn,{x:600,y:650}),null,'river click must not walk into water');
const snappedRiver=villageNavigation.planNearest(DATA.map.spawn,{x:600,y:650});
assert(snappedRiver?.length,'blocked river destination should snap to reachable ground');
assert(!Core.solid(snappedRiver.at(-1).x,snappedRiver.at(-1).y),'snapped river destination must be walkable');
const separated=Navigation.create(100,100,(x,y)=>x>=45&&x<=55);
assert.equal(separated.plan({x:20,y:50},{x:80,y:50}),null,'unreachable destinations must be rejected');
const nearestWall=separated.planNearest({x:20,y:50},{x:50,y:50});
assert(nearestWall?.length&&nearestWall.at(-1).x<45,'blocked wall target should snap to the nearest reachable side');
const corner=Navigation.create(100,100,(x,y)=>(x>=40&&y<50)||(y>=50&&x<40));
assert.equal(corner.plan({x:20,y:20},{x:80,y:80}),null,'diagonal walking must not pass through a blocked corner');
const laneStart={x:188,y:420},laneEnd={x:235,y:265},laneRoute=villageNavigation.plan(laneStart,laneEnd);
assert(laneRoute?.length,'village-head-to-clinic footpath should remain connected');
assert(Math.max(...laneRoute.map(point=>point.x))<300,'small footpath should not detour around the east side of the clinic');
let laneDistance=0,lanePrevious=laneStart;for(const point of laneRoute){laneDistance+=Math.hypot(point.x-lanePrevious.x,point.y-lanePrevious.y);lanePrevious=point;}
assert(laneDistance<200,'small footpath route is still unnecessarily long');

function resetClickScene(){run("close();cancelTravel();state=Core.fresh();villagers.forEach(n=>n.scene='elsewhere')");}
function finishWalking(){run('for(let i=0;i<5000&&travel;i++)advanceTravel(.05)');check('travel===null');}
for(const id of ['home','tavern','school']){
 run(`close();cancelTravel();state=Core.fresh();state.scene='${id}';state.x=DATA.interiors.${id}.spawn.x;state.y=DATA.interiors.${id}.spawn.y;(()=>{const t=interactionTargets().find(x=>x.type==='service');requestWalk(targetPoint(t),t)})()`);
 check('travel!==null');finishWalking();
 check("interactionTargets().some(t=>t.type==='service'&&canInteract(t))");
}
for(const [source,room] of Object.entries(DATA.interiors)){
 for(const transition of room.transitions||[]){
  run(`close();cancelTravel();state=Core.fresh();state.scene='${source}';state.x=DATA.interiors.${source}.spawn.x;state.y=DATA.interiors.${source}.spawn.y;(()=>{const t=interactionTargets().find(x=>x.id==='${transition.id}');requestWalk(targetPoint(t),t)})()`);
  check('travel!==null');finishWalking();
  check(`interactionTargets().some(t=>t.id==='${transition.id}'&&canInteract(t))`);
  run(`interact(interactionTargets().find(t=>t.id==='${transition.id}'))`);
  check(`state.scene==='${transition.to}'`);
  check('!blockedAt(state.scene,state.x,state.y)');
 }
}
resetClickScene();
run("enter('school')");
check("state.x===445&&state.y===805");
check("hitTarget({x:470,y:870})?.type==='exit'");
run("clickMap({x:470,y:870})");check("state.scene==='village'");
check("!Core.solid(state.x,state.y)");
run("clickMap({x:350,y:575})");check("travel!==null");
run("close();cancelTravel();state=Core.fresh();state.scene='homeyard';state.x=DATA.interiors.homeyard.spawn.x;state.y=DATA.interiors.homeyard.spawn.y;(()=>{const t=interactionTargets().find(x=>x.id==='herb-yard');requestWalk(targetPoint(t),t)})()");
finishWalking();run("interact(interactionTargets().find(t=>t.id==='herb-yard'))");
check("modal && dialogue && document.getElementById('dialogue-text').textContent.includes('医馆后院')");
resetClickScene();
run('clickMap({x:310,y:280})');check("travel!==null && !modal && state.scene==='village'");
run('advanceTravel(.1)');check("playerWalkPhase>0 && ['up','down','left','right'].includes(playerFacing)");
finishWalking();check("!modal && state.scene==='village'");
run('clickMap({x:310,y:280})');check("state.scene==='home'");
run('clickMap({x:360,y:300})');check('travel!==null && !modal');finishWalking();
run('clickMap({x:360,y:300})');check("modal && dialogue && document.getElementById('dialogue-text').textContent.includes('苏家药铺')");

resetClickScene();
run("villagers[0].scene='village';villagers[0].x=370;villagers[0].y=400;clickMap({x:370,y:380})");
check('travel?.target?.type===\'npc\' && !modal');finishWalking();check('!modal');
run('clickMap({x:370,y:380})');
check("modal && dialogue && document.getElementById('dialogue-name').textContent==='苏怀仁'");
check("document.getElementById('modal').hidden && !document.getElementById('dialogue').hidden && document.getElementById('dialogue').dataset.speaker==='npc'");
check("document.getElementById('dialogue-text').textContent===villagers[0].line");
elements['dialogue-next'].onclick();
check("document.getElementById('dialogue').dataset.speaker==='player' && document.getElementById('dialogue-name').textContent==='你'");
check("document.getElementById('dialogue-hint').textContent==='点击结束'");
elements['dialogue-next'].onclick();check("!modal && dialogue===null && document.getElementById('dialogue').hidden");
run("startDialogue([{speaker:'npc',name:'顾先生',sprite:3,text:'书'.repeat(125)},{speaker:'player',name:'你',sprite:0,text:'我记下了。'}])");
check('dialogue.pages.length===4 && dialogue.pages.every(p=>Array.from(p.text).length<=48)');
windowListeners.keydown({key:'Enter',preventDefault:noop});check('dialogue.index===1');
windowListeners.keydown({key:'Enter',repeat:true,preventDefault:noop});check('dialogue.index===1');
windowListeners.keydown({key:' ',preventDefault:noop});check('dialogue.index===2');
windowListeners.keydown({key:'Escape'});check('!modal && dialogue===null');
run('talkTo(villagers[0]);inventory()');
check("modal && dialogue && !document.getElementById('dialogue').hidden && document.getElementById('modal').hidden && document.getElementById('dialogue-text').textContent.includes('随身行囊')");
run('talkTo(villagers[0])');elements['dialogue-close'].onclick();check('!modal && dialogue===null');

resetClickScene();
run('clickMap({x:678,y:535})');check("travel?.target?.type==='plot' && !modal");finishWalking();check('!modal');
run('clickMap({x:678,y:535})');check("modal && dialogue && document.getElementById('dialogue-text').textContent.includes('田 · 1')");
elements['dialogue-actions'].children[0].onclick();check("state.plots[0]?.crop==='青菜' && state.plots[1]===null && !modal");
run('requestWalk(DATA.map.plots[1].interact)');finishWalking();run('renderNearby()');
const secondPlot=elements['near-actions'].children.find(b=>b.textContent.startsWith('田地2'));
assert(secondPlot,'each adjacent plot needs its own clickable action');secondPlot.onclick();
check("document.getElementById('dialogue-text').textContent.includes('小块田 · 2')");
run('close();Core.advance(state,480);clickMap({x:678,y:535})');
elements['dialogue-actions'].children[0].onclick();check("state.bag['青菜']===3 && state.plots[0]===null");

resetClickScene();
run('clickMap({x:620,y:370})');check("travel?.target?.type==='fish' && !modal");finishWalking();
run('clickMap({x:620,y:370})');check("modal && dialogue && document.getElementById('dialogue-text').textContent.includes('一竿清风')");elements['dialogue-actions'].children[0].onclick();
check("fish!==null && state.bag['蚯蚓']===5 && !modal");
run('Core.advance(state,30);clickMap({x:620,y:370})');elements['dialogue-actions'].children[0].onclick();
check("fish===null && state.bag['鲫鱼']===1");

resetClickScene();
const pointer={clientX:145,clientY:380,pointerId:1,button:0,preventDefault:noop};
elements.game.onpointerdown(pointer);elements.game.onpointerup(pointer);
check('travel.goal.x===250 && travel.goal.y===680');
run('clickMap({x:260,y:680})');check('travel.goal.x===260');
elements.stop.onclick();check('travel===null');
elements.game.onpointerdown(pointer);elements.game.onpointerup({...pointer,clientX:165});check('travel===null');
run('clickMap({x:600,y:650})');check('travel!==null && !blocked(travel.goal.x,travel.goal.y) && Math.hypot(travel.goal.x-600,travel.goal.y-650)>0');
run('cancelTravel();clickMap({x:90,y:90})');check('travel!==null && !blocked(travel.goal.x,travel.goal.y) && Math.hypot(travel.goal.x-90,travel.goal.y-90)>0');
run('cancelTravel();clickMap({x:372,y:646})');check('travel!==null && !blocked(travel.goal.x,travel.goal.y) && Math.hypot(travel.goal.x-372,travel.goal.y-646)>0');
run('cancelTravel()');

canvasOps.length=0;
run("travel={points:[{x:111,y:222},{x:333,y:444}],scene:state.scene,target:null,goal:{x:500,y:600},replan:0};drawNavigation();travel=null");
assert(!canvasOps.some(op=>op.slice(1).includes(111)||op.slice(1).includes(222)||op.slice(1).includes(333)||op.slice(1).includes(444)),'navigation must not draw route waypoints');
assert(canvasOps.some(op=>op[0]==='ellipse'&&op[1]===500),'navigation must draw one destination cursor');

run("state=Core.fresh();state.time=360;villagers[0].scene='village';villagers[0].x=298;villagers[0].y=342;villagers[0].movePhase=0;updateNPC(.1)");
check("villagers[0].moving && villagers[0].movePhase>0 && villagers[0].x>298");

run("close();state.scene='tavern';state.time=480;service('tavern')");
check("modal && dialogue && document.getElementById('modal').hidden && !document.getElementById('dialogue').hidden && document.getElementById('dialogue-actions').children.length===5");
run('close()');

resetClickScene();run('clickMap({x:326,y:918})');finishWalking();check("state.scene==='village'");
run('clickMap({x:326,y:918})');check("state.scene==='road'");
assert(DATA.map.bandit,'road bandit data is missing');
check("interactionTargets().filter(t=>t.type==='bandit').length===1");
run('clickMap(DATA.map.bandit)');check("travel?.target?.type==='bandit' && !modal");finishWalking();
run('clickMap(DATA.map.bandit)');
check("modal && dialogue && document.getElementById('dialogue-name').textContent==='山贼'");
assert.deepEqual(elements['dialogue-actions'].children.map(button=>button.textContent),['拔剑迎战','暂且退开']);
elements['dialogue-actions'].children[1].onclick();
check("state.scene==='road' && !modal && dialogue===null");
run("banditEncounter();toastUntil=9999;document.getElementById('walk-status').textContent='旧提示'");
elements['dialogue-actions'].children[0].onclick();
check("state.scene==='battle' && battle?.status==='running'");
check("toastUntil===0 && document.getElementById('walk-status').textContent==='战斗自动进行中，双方会自行判断攻防。'");
check("battle.fighters.player.hp===100 && battle.fighters.bandit.hp===120");
assert.equal(elements['combat-hud'].hidden,false,'battle HUD should be visible');
run('renderNearby()');
assert.equal(elements['near-actions'].children.length,0,'ordinary nearby actions should be hidden in battle');
run('last=1000;tick(1100)');check('battle.time>0 && battle.time<=.11');
run('battleBeforeRestart=battle');elements['combat-restart'].onclick();
check("battle!==battleBeforeRestart && battle.fighters.player.hp===100 && battle.fighters.bandit.hp===120");
run('last=1000;tick(6000)');check('battle.time<=.11');
elements['combat-return'].onclick();
check("state.scene==='road' && battle===null && document.getElementById('combat-hud').hidden");
check("document.getElementById('walk-status').textContent.includes('古道')");
run('clickMap({x:360,y:890})');finishWalking();run('clickMap({x:360,y:890})');check("state.scene==='village'");

for(const crop of ['青菜','玉米','花生','豌豆']){
 run(`state=Core.fresh();Core.plant(state,0,'${crop}')`);
 check('!Core.harvest(state,0)');
 run(`Core.advance(state,DATA.crops['${crop}'].hours*60)`);
 check(`Core.harvest(state,0) && state.bag['${crop}']===DATA.crops['${crop}'].yield`);
 check('!Core.harvest(state,0)');
}
run('state=Core.fresh()');
check("Core.order(state,'craft')");
check("!Core.order(state,'craft')");
check('Core.collect(state)===0');
run('Core.advance(state,4320)');
check("Core.collect(state)===1 && state.bag['粗铁剑']===1");
check('Core.collect(state)===0');
run('state=Core.fresh()');
check("Core.order(state,'repair') && state.bag['旧柴刀']===0");
run('Core.advance(state,360);Core.collect(state)');
check("state.weapon==='柴刀'");
run('state=Core.fresh();Core.advance(state,4320)');
check('state.bridgeDone && state.chronicle.length===2');
run('Core.advance(state,10000)');
check('state.chronicle.length===2');
run('state=Core.fresh();state.money=0');
check("!Core.plant(state,0,'青菜') && !Core.order(state,'craft')");
run('state=Core.fresh();state.x=DATA.map.road.x;state.y=DATA.map.road.y;near=findNear();interact()');
check("state.scene==='road' && state.departed");
run('tick(500);leave()');
check("state.scene==='village' && !Core.solid(state.x,state.y)");

console.log('PASS: hand-and-foot walking frames, tree collision, nearest walkable snapping, unified dialogue interactions, terrain collision, destination-only cursor, interiors and NPC schedules');
