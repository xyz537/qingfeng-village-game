const Combat=(()=>{
 const templates={
  player:{id:'player',name:'主角',side:'player',hp:100,maxHp:100,innerPower:50,maxInnerPower:50,attack:18,defense:10,attackRange:82,attackInterval:.75,windup:.22,moveSpeed:95,aiLevel:1,weapon:'长剑',technique:'剑击',allowed:{attack:true,parry:true,dodge:true,guard:false},x:190,y:650,facing:'right'},
  bandit:{id:'bandit',name:'山贼',side:'enemy',hp:120,maxHp:120,innerPower:0,maxInnerPower:0,attack:25,defense:8,attackRange:76,attackInterval:1.65,windup:.52,moveSpeed:88,aiLevel:0,weapon:'柴刀',technique:'挥刀',allowed:{attack:true,parry:false,dodge:false,guard:false},x:530,y:650,facing:'left'}
 };
 function fighter(source,overrides={}){
  return {...source,...overrides,allowed:{...source.allowed,...overrides.allowed},action:{kind:'idle',remaining:0,resolved:false},cooldown:0,guardRemaining:0,attacks:0,decision:'观察对手',decisionReason:'等待战机',escaping:false,fleeChecked:false};
 }
 function createBattle(overrides={}){
  return {time:0,status:'running',fighters:{player:fighter(templates.player,overrides.player),bandit:fighter(templates.bandit,overrides.bandit)},log:[],result:null,maxStep:0};
 }
 function previewDamage(attacker,defender){
  let damage=Math.max(1,attacker.attack-defender.defense*.5);
  if(defender.action.kind==='parry')damage*=.3;
  if(defender.guardRemaining>0)damage*=.6;
  return Math.max(1,Math.round(damage));
 }
 function addLog(battle,text,type='info'){
  battle.log.push({time:battle.time,text,type});
  if(battle.log.length>12)battle.log.splice(0,battle.log.length-12);
 }
 function setAction(fighter,kind,remaining,decision,reason){
  fighter.action={kind,remaining,resolved:false};
  fighter.decision=decision;
  fighter.decisionReason=reason;
 }
 function finish(battle,status,text){
  if(battle.status!=='running')return;
  battle.status=status;
  battle.result={status,time:battle.time,text,playerAttacks:battle.fighters.player.attacks,banditAttacks:battle.fighters.bandit.attacks};
  addLog(battle,text,'result');
 }
 function opponentOf(battle,fighter){return fighter.id==='player'?battle.fighters.bandit:battle.fighters.player;}
 function distance(a,b){return Math.hypot(a.x-b.x,a.y-b.y);}
 function dodge(fighter,opponent,battle){
  const direction=fighter.y<=opponent.y?-1:1;
  fighter.y=Math.max(565,Math.min(735,fighter.y+direction*48));
  fighter.x+=fighter.x<opponent.x?-22:22;
  setAction(fighter,'dodge',.42,'闪避','对手正在蓄势，侧身拉开距离');
  addLog(battle,`${fighter.name}侧身闪避。`,'defense');
 }
 function defend(fighter,opponent,battle){
  if(opponent.action.kind!=='windup'||fighter.aiLevel<1)return false;
  const threatened=previewDamage(opponent,fighter),low=fighter.hp/fighter.maxHp<=.45;
  if(fighter.aiLevel>=2&&fighter.allowed.guard&&fighter.guardRemaining<=0&&fighter.innerPower>=10&&(low||threatened>=fighter.hp*.25)){
   fighter.innerPower-=10;fighter.guardRemaining=2;
   setAction(fighter,'guard',.35,'内力护体','威胁较高且内力充足');
   addLog(battle,`${fighter.name}运起内力护体。`,'defense');return true;
  }
  if(low&&fighter.allowed.dodge){dodge(fighter,opponent,battle);return true;}
  if(fighter.allowed.parry){setAction(fighter,'parry',.48,'招架','看见对手起手，稳住兵刃');addLog(battle,`${fighter.name}横兵招架。`,'defense');return true;}
  if(fighter.allowed.dodge){dodge(fighter,opponent,battle);return true;}
  return false;
 }
 function beginAttack(fighter,battle){
  fighter.cooldown=fighter.attackInterval;fighter.attacks++;
  setAction(fighter,'windup',fighter.windup,fighter.technique,`目标进入${fighter.attackRange}步攻击范围`);
  addLog(battle,`${fighter.name}准备使出${fighter.technique}。`,'attack');
 }
 function resolveAttack(battle,attacker){
  const defender=opponentOf(battle,attacker);
  if(battle.status!=='running'||attacker.action.resolved)return;
  attacker.action.resolved=true;
  if(defender.action.kind==='dodge'||distance(attacker,defender)>attacker.attackRange+12){
   addLog(battle,`${attacker.name}的${attacker.technique}落空。`,'miss');return;
  }
  const parried=defender.action.kind==='parry',guarded=defender.guardRemaining>0,damage=previewDamage(attacker,defender);
  defender.hp=Math.max(0,defender.hp-damage);
  const note=parried?'，伤势被招架化去大半':guarded?'，护体卸去部分力道':'';
  addLog(battle,`${attacker.name}以${attacker.technique}命中${defender.name}，造成 ${damage} 点伤害${note}。`,'hit');
  if(defender.hp<=0){setAction(defender,'down',Infinity,'倒地','气血归零');finish(battle,attacker.id==='player'?'player_win':'bandit_win',attacker.id==='player'?'山贼倒地，主角获胜。':'主角不支倒地。');}
  else if(!['parry','dodge','guard'].includes(defender.action.kind))setAction(defender,'hurt',.18,'受击',`承受 ${damage} 点伤害`);
 }
 function updateAction(battle,fighter,dt){
  if(!Number.isFinite(fighter.action.remaining)||fighter.action.kind==='approach'||fighter.action.kind==='idle')return;
  fighter.action.remaining=Math.max(0,fighter.action.remaining-dt);
  if(fighter.action.kind==='windup'&&fighter.action.remaining<=0){resolveAttack(battle,fighter);if(battle.status==='running')setAction(fighter,'idle',0,'观察对手','攻击已经完成');return;}
  if(fighter.action.remaining<=0)setAction(fighter,'idle',0,'观察对手','准备下一次判断');
 }
 function move(fighter,opponent,dt,away=false){
  const dx=fighter.x-opponent.x,dy=fighter.y-opponent.y,d=Math.hypot(dx,dy)||1;
  const direction=away?1:-1,amount=fighter.moveSpeed*dt;
  fighter.x+=dx/d*amount*direction;fighter.y+=dy/d*amount*direction;
  fighter.x=Math.max(25,Math.min(695,fighter.x));fighter.y=Math.max(565,Math.min(735,fighter.y));
 }
 function decide(battle,fighter,random,dt){
  if(battle.status!=='running'||['windup','parry','dodge','guard','hurt','down'].includes(fighter.action.kind))return;
  const opponent=opponentOf(battle,fighter);
  if(fighter.escaping){move(fighter,opponent,dt,true);setAction(fighter,'flee',Infinity,'逃跑','气血过低，只想保命');if(fighter.x<=40||fighter.x>=680)finish(battle,fighter.id==='bandit'?'bandit_fled':'player_fled',`${fighter.name}逃离了战场。`);return;}
  if(fighter.aiLevel===0&&fighter.hp/fighter.maxHp<.2&&!fighter.fleeChecked){
   fighter.fleeChecked=true;
   if(random()<.35){fighter.escaping=true;setAction(fighter,'flee',Infinity,'逃跑','气血低于两成');addLog(battle,`${fighter.name}胆怯后退，想要逃跑。`,'flee');return;}
  }
  if(defend(fighter,opponent,battle))return;
  if(distance(fighter,opponent)>fighter.attackRange){setAction(fighter,'approach',Infinity,'接近','目标在攻击范围外');move(fighter,opponent,dt);return;}
  if(fighter.cooldown<=0&&fighter.allowed.attack){beginAttack(fighter,battle);return;}
  setAction(fighter,'idle',0,'等待','攻击尚未恢复');
 }
 function slice(battle,dt,random){
  battle.time+=dt;battle.maxStep=Math.max(battle.maxStep,dt);
  for(const fighter of Object.values(battle.fighters)){
   fighter.cooldown=Math.max(0,fighter.cooldown-dt);
   fighter.guardRemaining=Math.max(0,fighter.guardRemaining-dt);
  }
  for(const fighter of Object.values(battle.fighters))updateAction(battle,fighter,dt);
  if(battle.status!=='running')return;
  decide(battle,battle.fighters.player,random,dt);
  decide(battle,battle.fighters.bandit,random,dt);
 }
 function step(battle,seconds,random=Math.random){
  if(battle.status!=='running'||!Number.isFinite(seconds)||seconds<=0)return battle;
  let remaining=Math.min(seconds,10);
  while(remaining>0&&battle.status==='running'){const dt=Math.min(.05,remaining);slice(battle,dt,random);remaining-=dt;}
  return battle;
 }
 return {createBattle,step,previewDamage};
})();
if(typeof module!=='undefined')module.exports=Combat;
