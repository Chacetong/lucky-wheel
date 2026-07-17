# 幸运大转盘

一个适合聚会、课堂点名和随机选择的纯前端抽奖工具。项目不依赖框架或构建工具，直接打开 `index.html` 即可运行。

## 功能

- 添加、删除、清空参与者
- 自定义名称、权重和转盘颜色
- 按权重计算中奖概率
- 抽奖旋转与胜者揭晓的全屏动效
- 可选”中奖后从转盘移除”
- 使用 `localStorage` 自动保存名单和设置
- 响应式布局、键盘操作和减少动画支持

## 项目结构

```text
.
├── index.html       # 页面语义结构
├── styles.css       # 布局、主题、组件和动画样式
├── js/              # ES Modules
│   ├── state.js     # 共享状态 / 调色板 / 持久化 / 色彩工具
│   ├── ui.js        # esc / toast / tooltip / syncUI / renderList
│   ├── wheel.js     # Canvas 绘制 + 抽奖 + 结果 modal
│   ├── grouping.js  # 分组算法 + 动画 + 结果 modal + 拖拽
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

`index.html` 只负责页面结构；`styles.css` 负责视觉表现；`js/` 下按职责拆分为 ES Modules：

1. `state.js` —— 共享可变状态（`state` 对象）、调色板、`localStorage` 持久化、色彩工具
2. `ui.js` —— DOM 通用工具：`esc`、Toast、Tooltip、`syncUI`/`renderList`
3. `wheel.js` —— Canvas 尺寸与转盘绘制、抽奖动画、命中计算、抽奖结果 modal
4. `grouping.js` —— 分组算法、chaos 动画、结果 modal、拖拽换组
5. `main.js` —— 阵容 CRUD、模式切换、快捷键、启动引导

抽奖结果由转盘停止后的指针角度决定。每个扇区占比为 `参与者权重 / 总权重`。

## 后续优化建议

建议继续保持零构建起步，并按收益逐步演进：

1. 将 `app.js` 进一步拆为 `state.js`、`wheel.js`、`ui.js`，用 ES Modules 明确依赖边界。
2. 用事件委托替换 HTML 中的内联事件，降低结构和逻辑的耦合。
3. 抽出纯函数 `pickWinner(entries, angle)`，为权重边界、空名单和移除模式增加自动化测试。
4. 将颜色、间距、字号和动画时长整理为更完整的设计令牌，方便统一调整主题。
5. 增加开发工具时优先选择轻量的 Vite、ESLint 和 Prettier；在确实需要组件复用前不必引入大型框架。
6. 为主要桌面和移动端尺寸建立截图回归，避免视觉优化破坏布局。

## 数据说明

名单保存在当前浏览器的 `localStorage` 中，键名为 `lucky-wheel-state-v1`。清理浏览器站点数据会同时清除名单。

当前随机过程使用 `Math.random()`，适合娱乐用途，不适用于需要安全审计或可验证公平性的正式抽奖。
