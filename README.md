# MapleTool

MapleTool 是一个面向 GMS 国际服冒险岛玩家的 Electron 桌面小工具。

当前第一个功能是冷却放大镜：选择屏幕上的技能冷却区域，并在一个可移动、置顶的放大窗口里显示。

## 本地开发

```bash
pnpm install
pnpm dev
```

在 macOS 上，屏幕捕获可能需要给终端或打包后的应用开启屏幕录制权限。

## 构建

```bash
pnpm build
pnpm dist
```

Windows 安装包建议在 Windows 或 CI 环境里生成，结果更稳定。
