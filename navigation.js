/* Static scene navigation. All paths use the same collision rules as movement. */
const Navigation={
 create(width,height,isBlocked,step=8){
  const cols=Math.ceil(width/step),rows=Math.ceil(height/step),count=cols*rows;
  const point=id=>({x:(id%cols)*step+step/2,y:Math.floor(id/cols)*step+step/2});
  const safe=(x,y)=>![[0,0],[-3,0],[3,0],[0,-3],[0,3]].some(([dx,dy])=>isBlocked(x+dx,y+dy));
  const clear=(a,b,margin=false)=>{const distance=Math.hypot(b.x-a.x,b.y-a.y),samples=Math.max(1,Math.ceil(distance/2));for(let i=0;i<=samples;i++){const t=i/samples,x=a.x+(b.x-a.x)*t,y=a.y+(b.y-a.y)*t;if(margin?!safe(x,y):isBlocked(x,y))return false;}return true;};
  const open=new Uint8Array(count);for(let id=0;id<count;id++){const p=point(id);open[id]=safe(p.x,p.y)?1:0;}
  function candidates(p,radius,connect){
   const list=[];
   for(let y=Math.max(0,Math.floor((p.y-radius)/step));y<Math.min(rows,Math.ceil((p.y+radius)/step));y++)
    for(let x=Math.max(0,Math.floor((p.x-radius)/step));x<Math.min(cols,Math.ceil((p.x+radius)/step));x++){
     const id=y*cols+x,q=point(id),d=Math.hypot(q.x-p.x,q.y-p.y);
     if(open[id]&&d<=radius&&(!connect||clear(p,q)))list.push({id,d});
    }
   return list.sort((a,b)=>a.d-b.d);
  }
  return {
   clear,
   planNearest(start,goal,{maxSnap=Infinity}={}){
    const nearest=candidates(goal,maxSnap,false);
    /* Usually the first candidate is reachable. A small bounded fallback handles
       the opposite bank of water or a fence without scanning the whole map. */
    for(let i=0;i<Math.min(nearest.length,64);i++){
     const route=this.plan(start,point(nearest[i].id),{exact:true,maxSnap:step/2});
     if(route)return route;
    }
    return null;
   },
   plan(start,goal,{exact=true,maxSnap=14}={}){
    if(exact&&isBlocked(goal.x,goal.y))return null;
    const starts=candidates(start,24,true),goals=candidates(goal,maxSnap,!isBlocked(goal.x,goal.y));
    if(!starts.length||!goals.length)return null;
    const endSet=new Set(goals.map(n=>n.id)),cost=new Float64Array(count).fill(Infinity),parent=new Int32Array(count).fill(-1),closed=new Uint8Array(count),heap=[];
    const push=(id,f)=>{let i=heap.length;heap.push({id,f});while(i){const p=(i-1)>>1;if(heap[p].f<=f)break;heap[i]=heap[p];i=p;}heap[i]={id,f};};
    const pop=()=>{const first=heap[0],last=heap.pop();if(heap.length){let i=0;while(i*2+1<heap.length){let j=i*2+1;if(j+1<heap.length&&heap[j+1].f<heap[j].f)j++;if(heap[j].f>=last.f)break;heap[i]=heap[j];i=j;}heap[i]=last;}return first.id;};
    const heuristic=id=>{const p=point(id);return Math.max(0,Math.hypot(p.x-goal.x,p.y-goal.y)-maxSnap);};
    for(const n of starts){cost[n.id]=n.d;push(n.id,n.d+heuristic(n.id));}
    while(heap.length){
     const id=pop();if(closed[id])continue;closed[id]=1;
     if(endSet.has(id)){
      const path=[];for(let p=id;p!==-1;p=parent[p])path.push(point(p));path.reverse();
      if(exact&&clear(path[path.length-1],goal))path.push({x:goal.x,y:goal.y});
      // Shorten only straight, collision-free segments; never cut through a corner.
      const shortened=[];let anchor=start,index=0;
      while(index<path.length){let far=index;while(far+1<path.length&&clear(anchor,path[far+1],shortened.length>0))far++;shortened.push(path[far]);anchor=path[far];index=far+1;}
      return shortened;
     }
     const x=id%cols,y=Math.floor(id/cols),a=point(id);
     for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]){
      const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=cols||ny>=rows)continue;
      const next=ny*cols+nx;if(!open[next]||closed[next])continue;
      if(dx&&dy&&(!open[y*cols+nx]||!open[ny*cols+x]))continue;
      const b=point(next);if(!clear(a,b,true))continue;
      const value=cost[id]+step*(dx&&dy?Math.SQRT2:1);
      if(value>=cost[next])continue;cost[next]=value;parent[next]=id;push(next,value+heuristic(next));
     }
    }
    return null;
   }
  };
 }
};
if(typeof module!=='undefined')module.exports=Navigation;
