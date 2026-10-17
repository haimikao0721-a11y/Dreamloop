# 素材目录

图片放在这里，不放进 `src/`。数值和文案仍在 `src/data/`。字和播放归哪一层见 [docs/05-表现与文字.md](../docs/05-表现与文字.md)。

内容包和引擎不写文件路径。界面以后按 id 来取，用 URL 引用，不把图片 `import` 进 TypeScript。

```
assets/
├─ characters/<roleId>/actions/    角色动作
├─ map/                            地形
├─ items/<itemId>/                 物品
└─ cutscenes/<cutsceneId>/         过场画面
```

## 角色动作

目录名用角色 id，和 `src/data/packs/core/roles.ts` 一致：`dream_archivist`、`ward_nurse`。

`actions/` 只放动作，文件名用动作名：

| 文件 | 动作 |
|---|---|
| `idle.webp` | 待机 |
| `move.webp` | 移动 |
| `attack.webp` | 攻击 |
| `hurt.webp` | 受击 |
| `death.webp` | 死亡 |

立绘以后放同级的 `portrait/`，不和动作帧放一起。

## 地图

地形全地图共用，文件直接放在 `map/`，名字用 `TileKind`：

`wall`、`floor`、`door`、`stairs`

不按角色、不按楼层再拆一套。

## 物品

一种物品一个目录，目录名用 `src/data/packs/core/items.ts` 里的 id，例如 `hollow_tonic/`、`ward_key/`。不按消耗品、遗物、钥匙混放。

## 过场画面

`cutscenes/<cutsceneId>/` 放合成好的一帧（背景、人物、气氛）。不把角色动作、地形、物品复制进来。一幕过场一个目录。

## 占位文件

空目录里的 `.gitkeep` 只为了让目录进仓库。真正的素材放进来之后可以删掉它。

画面现在用文字占位，不读这些目录里的图片。规格还没定，这里先不放生成出来的图。
