# 幸运大转盘

一个适合聚会、课堂点名、团建分组的纯前端工具。零构建，只依赖系统自带的 `python3` 起静态服务。

## 功能

**抽奖模式**
- 添加、删除、清空参与者，`ACDC` 一键载入 10 人预设阵容
- 自定义名称、权重、扇区颜色（相邻色自动错开）
- 按权重计算中奖概率
- 转盘旋转 + 胜者揭晓的全屏动效（速度线特效）
- 可选「胜出后从转盘移除」，抽奖结果 modal 支持「再来一次」
- ESC 中途取消，转盘顺滑归位

**分组模式**
- 按 2–20 组任意划分，支持「均匀」/「相同」两种分配模式
- 中心大牌依次投放并飞入所属 slot 的分组动画
- 分组结果 modal 支持拖拽换组
- ESC 中途取消，chip 淡出 + 空槽预览淡入衔接

**通用**
- 使用 `localStorage` 自动保存阵容、组数、模式等
- 全键盘可达（Space / Enter 启动，Tab 焦点循环，ESC 取消 / 关闭）
- 响应式布局，支持 `prefers-reduced-motion`

## 项目结构

```text
.
├── index.html       # 页面语义结构
├── styles.css       # 布局、主题、组件和动画样式
├── site.webmanifest # PWA 元信息与图标声明
├── serve.sh         # 一键启动本地静态服务
├── assets/
│   ├── favicon.svg          # 站点图标矢量源（主力）
│   ├── favicon-32.png       # 老 Safari / 抓取器兜底
│   ├── apple-touch-icon.png # iOS 主屏图标 180×180
│   ├── icon-192.png         # PWA 图标
│   └── icon-512.png         # PWA 启动图标
├── js/              # ES Modules
│   ├── state.js     # 共享状态 / 调色板 / 持久化 / 色彩工具
│   ├── ui.js        # esc / toast / tooltip / syncUI / renderList
│   ├── wheel.js     # Canvas 绘制 + 抽奖 + 结果 modal
│   ├── grouping.js  # 分组算法 + 中心大牌投放动画 + 结果 modal + 拖拽
│   └── main.js      # 阵容管理 + 模式切换 + 启动引导
├── DESIGN.md        # 产品与视觉设计规范
└── README.md
```

## 本地运行

代码采用 ES Modules 组织，浏览器的 CORS 策略禁止 `file://` 加载子模块，所以**不能双击 `index.html`**，必须走 http。

**方式一（推荐）**：项目根跑

```bash
./serve.sh          # 默认端口 5173，自动开浏览器
./serve.sh 8000     # 自选端口
```

**方式二**：VS Code 装 Live Server 扩展，在 `index.html` 上右键 "Open with Live Server"，保存自动刷新。

项目没有安装或构建步骤，只依赖系统自带的 `python3`。

## 代码分层

`index.html` 只负责页面结构；`styles.css` 负责视觉表现；`js/` 下按职责拆分为 ES Modules，依赖方向 `main → wheel/grouping → ui → state`，无循环导入：

1. `state.js` —— 共享可变状态（`state` 对象）、调色板、`localStorage` 持久化、色彩工具、`prefers-reduced-motion` 检测
2. `ui.js` —— DOM 通用工具：`esc`、Toast、Tooltip、`syncUI`/`renderList`
3. `wheel.js` —— Canvas 尺寸与转盘绘制、抽奖旋转 + anticipation、命中计算、抽奖结果 modal、速度线特效
4. `grouping.js` —— 分组算法、中心大牌依次投放并飞入的动画编排（前重后轻 stagger + 动态 HOLD 防堆积）、结果 modal、组间拖拽换组
5. `main.js` —— 阵容 CRUD、模式切换、事件委托、快捷键、启动引导

抽奖结果由转盘停止后的指针角度决定，每个扇区占比为 `参与者权重 / 总权重`。分组结果由 Fisher–Yates 洗牌后按分配模式切片得到。

## 后续优化建议

保持零构建起步，按收益推进：

1. 抽出纯函数 `pickWinner(entries, angle)` / `assignGroups(entries, k, mode)`，为权重边界、空名单、移除模式加自动化测试。
2. 把颜色、间距、字号、动画时长整理为更完整的设计令牌，便于换肤。
3. 需要开发工具时优先轻量的 Vite / ESLint / Prettier；在确实需要组件复用前不必引入大型框架。
4. 为主要桌面和移动端尺寸建立截图回归，避免视觉优化破坏布局。

## 数据说明

名单保存在当前浏览器的 `localStorage` 中，键名为 `lucky-wheel-state-v1`。清理浏览器站点数据会同时清除名单。

当前随机过程使用 `Math.random()`，适合娱乐用途，不适用于需要安全审计或可验证公平性的正式抽奖。
