const Core={
 fresh:()=>({version:2,time:6*60+30,money:600,knowledge:1,scene:'village',x:DATA.map.spawn.x,y:DATA.map.spawn.y,bag:{'铁矿':3,'木材':1,'蚯蚓':6,'面团':6,'旧柴刀':1},plots:Array.from({length:4},()=>null),orders:[],chronicle:['景和八年，苏怀仁携女迁入清风村。'],donated:false,bridgeDone:false,departed:false,weapon:'旧柴刀（有缺口）',reading:'未读',speed:1}),
 date(t){const d=Math.floor(t/1440);return `景和${12+Math.floor((d+60)/360)}年 ${Math.floor(d%360/30)+3>12?Math.floor(d%360/30)-9:Math.floor(d%360/30)+3}月${d%30+1}日 ${String(Math.floor(t%1440/60)).padStart(2,'0')}:${String(Math.floor(t%60)).padStart(2,'0')}`},
 advance(s,m){s.time+=m;if(!s.bridgeDone&&s.time>=(s.donated?2880:4320)){s.bridgeDone=true;s.chronicle.push(this.date(s.time).split(' ').slice(0,2).join(' ')+'，村民合力修整河岸步道。'+(s.donated?'苏家少年出资购木。':''));}},
 mature(s,p){return p&&s.time-p.at>=DATA.crops[p.crop].hours*60},
 pay(s,n){if(s.money<n)return false;s.money-=n;return true},
 add(s,k,n=1){s.bag[k]=(s.bag[k]||0)+n},
 inRect(x,y,r){return x>=r.x&&x<=r.x+r.w&&y>=r.y&&y<=r.y+r.h},
 inPolygon(x,y,points){let inside=false;for(let i=0,j=points.length-1;i<points.length;j=i++){const a=points[i],b=points[j];if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])inside=!inside;}return inside},
 nearSegment(x,y,s){const dx=s.x2-s.x1,dy=s.y2-s.y1,length=dx*dx+dy*dy,t=length?Math.max(0,Math.min(1,((x-s.x1)*dx+(y-s.y1)*dy)/length)):0;return Math.hypot(x-(s.x1+t*dx),y-(s.y1+t*dy))<=s.width},
 riverAt(y){const bands=DATA.map.riverBands;for(let i=1;i<bands.length;i++){if(y<=bands[i][0]){const a=bands[i-1],b=bands[i],t=(y-a[0])/(b[0]-a[0]);return [a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t]}}return bands[bands.length-1].slice(1)},
 solid(x,y){
  if(x<14||x>716||y<18||y>946)return true;
  if(DATA.buildings.some(b=>(b.solids||[b]).some(r=>this.inRect(x,y,r))))return true;
  if(DATA.map.solidRects.some(r=>this.inRect(x,y,r)))return true;
  if((DATA.map.solidPolygons||[]).some(points=>this.inPolygon(x,y,points)))return true;
  if((DATA.map.fenceSegments||[]).some(segment=>this.nearSegment(x,y,segment)))return true;
  if((DATA.map.treeCircles||[]).some(tree=>Math.hypot(x-tree.x,y-tree.y)<=tree.r))return true;
  const [west,east]=this.riverAt(y);
  return x>=west&&x<=east&&!DATA.map.walkways.some(r=>this.inRect(x,y,r));
 },
 plant(s,i,crop){if(s.plots[i]||!DATA.crops[crop]||!this.pay(s,5))return false;s.plots[i]={crop,at:s.time};return true},
 harvest(s,i){const p=s.plots[i];if(!this.mature(s,p))return false;this.add(s,p.crop,DATA.crops[p.crop].yield);s.plots[i]=null;return true},
 order(s,type){const craft=type==='craft';if(!craft&&s.weapon!=='旧柴刀（有缺口）')return false;if(s.orders.some(o=>o.type===type))return false;if(craft&&((s.bag['铁矿']||0)<3||(s.bag['木材']||0)<1))return false;if(!this.pay(s,craft?300:30))return false;if(craft){s.bag['铁矿']-=3;s.bag['木材']--;}else{s.bag['旧柴刀']--;s.weapon='修理中';}s.orders.push({type,due:s.time+(craft?4320:360)});return true},
 collect(s){let n=0;s.orders=s.orders.filter(o=>{if(o.due>s.time)return true;this.add(s,o.type==='craft'?'粗铁剑':'柴刀');s.weapon=o.type==='craft'?'粗铁剑':'柴刀';n++;return false});return n}
};
if(typeof module!=='undefined')module.exports=Core;

