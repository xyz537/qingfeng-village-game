/* Positions follow the 1086 × 1448 Qingfeng Village reference, scaled to 720 × 960. */
const DATA={width:720,height:960,gameMinutesPerRealSecond:1,
 map:{
  reference:{width:1086,height:1448},
  spawn:{x:350,y:575},
  villageCenter:{x:321,y:578},
  fish:{x:620,y:370,reach:58},
  road:{x:326,y:918,reach:52},
  gate:{x:320,y:780},
  plots:[
   {x:670,y:522,w:18,h:27,interact:{x:675,y:555}},
   {x:694,y:522,w:18,h:27,interact:{x:701,y:555}},
   {x:670,y:565,w:18,h:27,interact:{x:675,y:600}},
   {x:694,y:565,w:18,h:27,interact:{x:701,y:600}}
  ],
  /* Each band is [y, west bank, east bank]. The river bends behind the houses. */
  riverBands:[
   [0,651,720],[150,646,720],[230,627,720],[280,596,720],
   [350,576,720],[440,574,720],[495,559,710],[545,550,665],
   [620,543,653],[690,548,674],[750,554,712],[815,557,720],[960,562,720]
  ],
  /* Bridges and piers remain walkable even where they cross the river. */
  walkways:[
   {x:578,y:258,w:101,h:34},
   {x:540,y:350,w:108,h:39},
   /* Stone bridge now meets the clear lane north of the school. */
   {x:520,y:438,w:198,h:64},
   {x:536,y:774,w:106,h:61}
  ],
  solidRects:[
   /* The grocery, dwelling, central tree and well are landmarks, not interiors yet. */
   {x:68,y:570,w:124,h:79},
   {x:397,y:378,w:130,h:73},
   {x:286,y:491,w:65,h:68},
   /* The covered market stall between the village head's home and clinic. */
   {x:201,y:336,w:93,h:67},
   /* Gateposts leave a clear opening for the south road. */
   {x:248,y:728,w:31,h:76},{x:361,y:728,w:30,h:76},
   /* Waterwheel and southern rocks close the shallow river edge. */
   {x:616,y:614,w:46,h:87},{x:431,y:839,w:107,h:121}
  ],
  /* Broad rock/forest masses stop clicks from treating painted mountains as paths. */
  solidPolygons:[
   [[14,18],[304,18],[289,63],[255,96],[220,128],[181,151],[132,158],[99,194],[54,210],[14,202]],
   /* Dense northern woodland beside the hunting ground; the pale footpath stays open. */
   [[72,32],[279,32],[300,70],[293,111],[274,149],[248,183],[219,207],[184,219],[149,215],[116,199],[91,171],[70,134]],
   [[381,0],[455,0],[459,44],[441,76],[414,94],[389,78]],
   [[452,18],[650,18],[644,78],[614,126],[586,171],[558,215],[519,225],[480,195],[451,154],[434,98]],
   [[14,216],[44,217],[71,253],[69,300],[53,340],[14,364]],
   [[505,179],[563,167],[594,198],[592,251],[574,295],[547,330],[512,315],[494,270]],
   /* Smaller forest masses that were visually dense but previously walkable. */
   [[455,175],[505,179],[520,220],[500,260],[477,285],[452,266],[460,225]],
   [[0,300],[55,300],[72,330],[61,365],[48,402],[57,442],[55,486],[62,530],[56,575],[72,620],[62,655],[0,670]],
   [[64,635],[175,636],[210,652],[239,681],[234,716],[209,750],[174,781],[126,776],[88,748],[68,704]],
   [[472,690],[509,690],[544,719],[552,757],[535,789],[497,808],[451,801],[412,778],[390,739],[411,714],[449,707]],
   [[14,648],[54,636],[88,678],[91,728],[126,774],[171,818],[218,872],[238,946],[14,946]],
   [[397,866],[432,833],[492,829],[548,864],[570,946],[397,946]]
  ],
  /* Split fence segments leave visible gates open while blocking the rails. */
  fenceSegments:[
   {x1:72,y1:174,x2:220,y2:174,width:5},{x1:72,y1:174,x2:66,y2:258,width:5},
   {x1:67,y1:281,x2:132,y2:326,width:5},{x1:198,y1:307,x2:226,y2:298,width:5},
   {x1:207,y1:315,x2:278,y2:332,width:5},{x1:338,y1:333,x2:431,y2:325,width:5},
   {x1:377,y1:459,x2:448,y2:461,width:5},{x1:493,y1:463,x2:537,y2:458,width:5},
   {x1:172,y1:781,x2:272,y2:799,width:6},{x1:382,y1:796,x2:532,y2:785,width:6},
   {x1:425,y1:829,x2:503,y2:820,width:5},{x1:535,y1:807,x2:590,y2:806,width:5}
  ],
  /* Trunk-sized circles: foliage can overlap the player, but the trunk cannot be crossed. */
  treeCircles:[
   {x:272,y:363,r:11},{x:382,y:410,r:10},{x:322,y:546,r:22},
   {x:536,y:472,r:10},{x:235,y:676,r:11},{x:372,y:646,r:12},
   {x:532,y:666,r:11},{x:230,y:748,r:10},{x:400,y:739,r:11}
  ]
 },
 buildings:[
  {id:'home',name:'苏家药铺',x:249,y:232,w:163,h:85,door:{x:306,y:331},solids:[{x:249,y:232,w:163,h:85},{x:217,y:275,w:35,h:44}],color:'#69796e',hours:[0,24]},
  {id:'elder',name:'村长家',x:38,y:335,w:139,h:82,door:{x:84,y:432},color:'#7b7764',hours:[6,21]},
  {id:'smith',name:'赵家铁铺',x:41,y:463,w:151,h:83,door:{x:102,y:561},color:'#647777',hours:[6,19]},
  {id:'school',name:'私塾',x:408,y:485,w:114,h:79,door:{x:478,y:580},color:'#737a66',hours:[7,18]},
  {id:'tavern',name:'清风茶酒馆',x:407,y:588,w:120,h:81,door:{x:451,y:686},color:'#956954',hours:[7,23]}
 ],
 interiors:{
  home:{asset:'assets/home-interior.png',label:'怀仁药铺（一层）',exitVillage:true,spawn:{x:360,y:790},service:{x:430,y:475,reach:115},serviceHit:{x:55,y:120,w:610,h:500},transitions:[{id:'home-up',label:'上二楼',x:570,y:590,reach:80,hit:{x:575,y:405,w:110,h:390},to:'home2',spawn:{x:570,y:700}},{id:'home-yard',label:'去医馆后院',x:105,y:380,reach:75,hit:{x:35,y:220,w:105,h:300},to:'homeyard',spawn:{x:360,y:780}}],solids:[{x:65,y:25,w:590,h:220},{x:330,y:315,w:225,h:150},{x:55,y:420,w:225,h:155},{x:585,y:430,w:80,h:350},{x:105,y:625,w:210,h:80},{x:405,y:625,w:205,h:80}]},
  home2:{asset:'assets/home-second-floor.png',label:'怀仁药铺（二楼）',spawn:{x:570,y:700},transitions:[{id:'home-down',label:'下楼回医馆',x:570,y:700,reach:80,hit:{x:535,y:565,w:145,h:290},to:'home',spawn:{x:570,y:590}}],inspects:[{id:'bedrooms',label:'看看楼上的房间',x:390,y:450,reach:95,hit:{x:70,y:75,w:570,h:520},title:'药铺楼上的住处',body:'青禾的房间、主角房间和苏怀仁的房间都收拾得很简单。灯油、换洗衣物和几本旧书，各自放在惯常的位置。'}],solids:[{x:135,y:115,w:175,h:245},{x:430,y:115,w:190,h:245},{x:180,y:455,w:220,h:265}]},
  homeyard:{asset:'assets/home-yard.png',label:'医馆后院',spawn:{x:360,y:780},transitions:[{id:'yard-back',label:'返回医馆',x:360,y:780,reach:80,hit:{x:285,y:675,w:150,h:190},to:'home',spawn:{x:110,y:380}}],inspects:[{id:'herb-yard',label:'查看后院药材',x:340,y:560,reach:100,hit:{x:45,y:70,w:620,h:570},title:'医馆后院',body:'药架上挂着刚洗净的根茎和叶片，药圃里也长着常用草药。苏怀仁将这里照料得井井有条。'}],solids:[{x:55,y:55,w:410,h:210},{x:485,y:45,w:185,h:300},{x:45,y:350,w:260,h:300},{x:300,y:330,w:185,h:175},{x:505,y:445,w:150,h:210}]},
  tavern:{asset:'assets/tavern-interior.png',label:'清风酒肆（一层）',exitVillage:true,spawn:{x:360,y:790},service:{x:360,y:415,reach:115},serviceHit:{x:45,y:75,w:625,h:405},transitions:[{id:'tavern-up',label:'上二楼客房',x:570,y:430,reach:80,hit:{x:575,y:55,w:110,h:400},to:'tavern2',spawn:{x:570,y:700}}],solids:[{x:45,y:55,w:230,h:310},{x:280,y:220,w:300,h:160},{x:590,y:65,w:85,h:370},{x:90,y:420,w:180,h:105},{x:290,y:475,w:185,h:115},{x:525,y:405,w:150,h:120},{x:70,y:610,w:190,h:110},{x:525,y:610,w:150,h:110}]},
  tavern2:{asset:'assets/tavern-second-floor.png',label:'清风酒肆（二楼）',spawn:{x:570,y:700},transitions:[{id:'tavern-down',label:'下楼回大堂',x:570,y:700,reach:80,hit:{x:555,y:480,w:130,h:360},to:'tavern',spawn:{x:500,y:430}}],inspects:[{id:'guestrooms',label:'看看楼上客房',x:360,y:470,reach:100,hit:{x:55,y:65,w:610,h:520},title:'酒馆客房',body:'三间客房大小相仿，床铺干净，桌上各留着一盏灯。外乡客多时，这里常会住满。'}],solids:[{x:60,y:85,w:190,h:275},{x:265,y:85,w:190,h:275},{x:470,y:85,w:185,h:275}]},
  school:{asset:'assets/school-interior.png',label:'清风村塾',exitVillage:true,spawn:{x:360,y:790},service:{x:360,y:330,reach:125},serviceHit:{x:55,y:80,w:610,h:360},solids:[{x:55,y:35,w:610,h:165},{x:280,y:210,w:180,h:100},{x:105,y:315,w:190,h:75},{x:425,y:315,w:190,h:75},{x:105,y:445,w:190,h:75},{x:425,y:445,w:190,h:75},{x:105,y:575,w:190,h:75},{x:425,y:575,w:190,h:75},{x:55,y:670,w:235,h:145}]}
 },
 crops:{'青菜':{hours:8,yield:3,price:8},'玉米':{hours:20,yield:4,price:12},'花生':{hours:16,yield:3,price:14},'豌豆':{hours:12,yield:4,price:9}},
 npcs:[
 {id:'suhuairen',name:'苏怀仁',sprite:1,color:'#e0d6b7',role:'doctor',line:'药要慢煎，人也别太着急。'},
 {id:'suqinghe',name:'苏青禾',sprite:2,color:'#9baf86',role:'qinghe',line:'河边的草药，该长新叶了。'},
 {id:'guteacher',name:'顾先生',sprite:3,color:'#abbfc4',role:'teacher',line:'读书不急，先把这句读明白。'},
 {id:'zhaotieshan',name:'赵铁山',sprite:4,color:'#bd8c68',role:'blacksmith',line:'铛——铛——这锄头该磨了。'},
 {id:'zhoubo',name:'周伯庸',sprite:5,color:'#c8bc94',role:'elder',line:'河东的田，今年收成应当不错。'},
 {id:'tavernkeeper',name:'陈婶',sprite:6,color:'#b89caa',role:'tavernkeeper',line:'灶上有热汤，进来歇歇脚。'},
 {id:'grocer',name:'孙有财',sprite:8,color:'#b7a276',role:'grocer',line:'针头线脑、盐糖酱醋，都在这儿。'},
 {id:'hunter',name:'秦老猎户',sprite:4,color:'#8d795f',role:'hunter',line:'山里的风向，今天有些不一样。'},
 {id:'fisher',name:'杜渔夫',sprite:8,color:'#77969a',role:'fisher',line:'看浮子得静，心急就钓不着鱼。'},
 {id:'farmer',name:'陈老伯',sprite:8,color:'#9fa382',role:'farmer',line:'种子落了地，就得给它些时日。'},
 {id:'schoolchild',name:'周小满',sprite:7,color:'#ceab68',role:'child',line:'人之初……先生刚才念到哪了？'},
 {id:'villager',name:'刘嫂',sprite:6,color:'#b89caa',role:'villager',line:'村里每天都有些琐碎事。'}]};
if(typeof module!=='undefined')module.exports=DATA;
