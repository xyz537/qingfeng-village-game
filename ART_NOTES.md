# 美术素材记录

本版使用内置 image_gen 工具模式制作游戏素材；工作区内的最终文件是 `assets/village-map.png` 和 `assets/villagers-atlas.png`。

## 底图提示词

> Use case: precise-object-edit. Asset type: 3:4 portrait, top-down 2D pixel-art village game background for a walking RPG. Edit target: the attached Qingfeng Village concept map. Preserve the exact 3:4 aspect ratio, camera angle, composition, spatial layout and relative location of every existing building, paths, central giant tree and well, farm at east, river, bridge, waterfall, wharf, village gate, mountains, foliage, pond, and lighting. Preserve the dense richly detailed hand-painted Chinese wuxia pixel-art aesthetic and crisp pixel texture. Remove ALL baked-in human figures, animals, standing NPCs, all text, all labels/signboards with text, the large title panel at upper left, descriptive text at upper left, and legend panel at lower left. Inpaint each removed region naturally with the underlying dirt, grass, stone, architecture or foliage. Keep functional building structures and unlettered signboard shapes, building entrances clear. No new buildings or relocated paths. No readable text anywhere. This must work as a clean game level background with independently animated player/NPC sprites overlaid at runtime.

## 人物图集提示词

> Use case: stylized-concept. Asset type: transparent sprite atlas for the attached Qingfeng Village 2D top-down wuxia RPG map. Treat attached image as STYLE REFERENCE ONLY: match its richly detailed, crisp hand-painted pixel art, miniature 3/4 top-down character perspective, ancient Chinese rural clothing, dark ink outlines and warm natural colors. Create a clean 3-column by 3-row contact sheet of NINE separate FULL BODY standing character sprites facing toward the viewer, each character centered within a large equal square cell, generous transparent gutters between cells, no overlap, same scale and perspective. Row 1: (1) young playable wanderer in dark blue robe with tied black hair, (2) older male herbalist physician in muted blue-grey, (3) young female herbalist in muted green. Row 2: (4) bespectacled or scholarly middle aged teacher in pale robe, (5) muscular village blacksmith with brown apron, (6) elderly village head in earth-colored robe. Row 3: (7) warm middle aged tavern woman in plum/brown apron, (8) school child in ochre outfit, (9) elderly farmer in green-brown workwear and straw hat. Every character completely separated, 3/4 top-down camera, tiny game-world body proportions like the figures in reference, no cast shadows beyond tiny underfoot, no environment, no backgrounds, no props extending outside their cell, no labels, no text, no border lines, genuinely transparent background including gaps. Production-ready sprite sheet; all faces and outlines clean.

## 石桥修订提示词

> Use case: precise-object-edit. Asset type: 1086 × 1448 portrait top-down pixel-art game map. Relocate only the grey stone arch bridge to approximately x=805–1015 and y=650–735, centered around (910,692), so its west entrance meets the open strip immediately below the residence and above the school. Keep it horizontal and connect it to the east-bank farm path. Remove the old bridge and restore natural river water, rocks and plants there. Preserve all buildings, village landmarks, river shape, lighting, composition and pixel-art style. Exactly one stone bridge; no people, animals, labels, UI or watermark.

## 室内提示词组

三个室内均以用户提供的建筑剖面图为布局与风格参考，使用 `stylized-concept` 生成独立的 3:4 竖屏游戏底图，统一要求：清晰的中式武侠像素画、三分之四俯视剖面、入口位于底部、保留清晰行走通道、移除所有固定人物与文字标签，不生成 UI、水印或其他面板。

- 酒馆：保留灶间、后门、长柜台、酒坛、桌席和右侧楼梯。
- 药铺：保留整面药柜、坐诊案、戥秤与药具、抓药台、候诊长凳和右侧楼梯。
- 私塾：保留先生讲案、成排课桌、中央走道、两侧书柜和左下小书房。

补充场景沿用同一 `stylized-concept` 模式、画幅与透视：

- 药铺二楼：三处朴素卧房、木制走廊、暖色灯火和右侧下楼楼梯，底部保留可行走区域。
- 医馆后院：围墙内的晾药架、药圃、石桌、水缸、树木与通往一层的下方院门。
- 酒馆二楼：三间客房、木制走廊、干净床铺、小桌灯具和右侧下楼楼梯。

所有补充场景均要求无固定人物、无文字、无 UI、无水印，家具外保留连续行走通道，供运行时角色和交互标记叠加。

## 人物步行动画提示词组

使用内置 `image_gen` 的 `precise-object-edit` 模式，以原九宫格人物图集为身份与画风参考。主图要求每名角色保持头部和躯干的高度、比例及落脚点稳定，只让左右手臂和双脚交替，形成接触姿势、经过姿势、反向接触姿势和反向经过姿势四帧循环；保持透明背景、人物服装与身份、像素边缘和三分之四俯视角，不允许整体身体弹跳、肢体重复或缺失。

主图生成后，为顾先生、赵铁山和周伯庸追加独立的 3 列 × 2 行透明补充图集，分别提供反向接触与反向经过两帧。运行时将主图与补充图组合为每人四帧。
