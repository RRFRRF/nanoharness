---
name: web2prd
description: 当用户需要对一个 Web 应用进行逆向分析、从用户视角自动探索并生成产品需求文档时使用此 skill。使用 playwright-cli 模拟真人浏览，自动截图、分析页面结构、识别功能模块，最终产出 PRD、用户流程图和数据模型。
allowed-tools: execute
dependencies: playwright-cli
---

# Web2PRD — Web 应用自动探索需求逆向

> **核心理念**: 覆盖 UI 状态，而非 URL。像真人用户一样浏览，发现所有功能模块和交互状态，生成结构化 PRD。

---

## 你的角色

你是一位经验丰富的产品经理。你的任务是用 playwright-cli 像真人一样探索 Web 应用，理解功能、流程和设计，输出结构化 PRD。

---

## ⚠️ 工具使用规则

**必须使用 `playwright-cli` bash 命令操作浏览器，禁止使用 playwright MCP 工具。**

原因：MCP 工具的 `browser_snapshot` 会将完整 DOM 树内联返回到 context window，一个复杂页面可能占用数千行，导致 context 快速耗尽。`playwright-cli` 可以将快照保存到磁盘文件，按需读取，极大节省 context。

```
✅ playwright-cli snapshot --filename=path/to/snap.yaml   → 写磁盘，0 context 消耗
✅ playwright-cli screenshot --filename=path/to/shot.png   → 写磁盘
✅ playwright-cli click e15                                → 轻量输出
❌ mcp__playwright__browser_snapshot                        → 禁止，内联返回撑爆 context
❌ mcp__playwright__browser_click                           → 禁止
```

---

## 前置条件

### 1. 验证 playwright-cli

```bash
playwright-cli open
playwright-cli close
```

失败则停止并提示用户安装。

### 2. 用户提供目标 URL

### 3. 创建输出目录

```bash
mkdir -p outputs/web2prd/{slug}/screenshots outputs/web2prd/{slug}/pages
```

Slug 规则: `https://www.example.com` → `example-com_20260329`

---

## 三阶段流水线

```
阶段 1: 探索（BFS 广度 + DFS 深度 + 饱和判断）
    ↓
阶段 2: 状态图构建（综合证据 → state-graph.md）
    ↓
阶段 3: 文档生成（state-graph → prd.md）
```

---

# 阶段 1: 探索

## 1.1 启动

```bash
playwright-cli open {url}
playwright-cli resize 1920 1080
playwright-cli screenshot --filename=outputs/web2prd/{slug}/screenshots/page-01-home.png
playwright-cli snapshot --filename=outputs/web2prd/{slug}/pages/page-01-home.yaml
# 然后 read_file outputs/web2prd/{slug}/pages/page-01-home.yaml 分析首页结构
```

分析首页截图和快照 → 识别应用类型 → 读取 `docs/app-types.md` 获取对应探索优先顺序。

初始化 exploration-log.md（从 `templates/exploration-log.md` 复制到输出目录）。

## 1.2 探索策略

**URL 覆盖 ≠ 状态覆盖。** 同一 URL 模板访问第 2 次不产生新信息。目标是发现每种不同的 UI 布局、交互模式和用户流程。

### BFS 广度扫描（前 5-8 页）

目标：建立完整的顶层导航地图。

1. 从首页快照提取所有导航链接
2. 按优先级入队：顶层导航=10, 二级导航=8, CTA=7, 列表详情=5, 页脚=3, 外部=0(不访问)
3. 依次访问每个链接，每页执行证据采集（见 1.3）
4. 将新发现的链接入队

### DFS 深度跟随

当截图/快照中发现多步流程信号时切换 DFS：
- 步骤指示器（Step 1/3、进度条）
- "下一步"/"继续"按钮序列
- Onboarding 引导步骤
- Tab 页内容不同
- 模态框触发链

DFS 规则：完整跟随到终点，每步采集证据，最大深度 10 步，完成后返回 BFS 队列。

### URL 去重

```
/products/12345     → /products/{id}
/users/abc-def-123  → /users/{uuid}
/page/2             → /page/{id}
```

模板已见 → 跳过（记录 SKIP）。新模板 → 入队（优先级 +2）。

### 饱和判断（每页后评估）

**停止条件**（任一满足）：
1. 队列为空
2. 已访问 ≥ 40 页
3. 队列中新模板占比 < 20%
4. 连续 5 页截图高度相似

**继续信号**（存在则不停止）：
- 队列中有新模板 URL
- 发现未记录的 UI 组件类型
- 有未完成的多步流程
- 7 维度覆盖有重要缺口

### 7 维度覆盖检查

| 维度 | 检查项 |
|------|--------|
| 导航入口 | 所有顶级/二级导航已访问或记录 |
| 认证状态 | 匿名 vs 已登录 UI 差异已记录 |
| CRUD 流程 | 列表/详情/创建/编辑/删除已记录 |
| 弹窗覆盖 | Modal/Drawer/Dropdown 已触发 |
| 表单覆盖 | 字段名/类型/校验已记录 |
| 搜索/筛选 | 搜索已触发，空结果已尝试 |
| 错误状态 | 404/空列表/加载状态已记录 |

## 1.3 每页证据采集

采用"先粗后细"策略：

### 第一轮：快速扫描（每页必做）

每页只做 4 步，保持节奏：

```bash
# 1. 截图（保存到 screenshots/）
playwright-cli screenshot --filename=outputs/web2prd/{slug}/screenshots/page-{NN}-{label}.png

# 2. 快照保存到磁盘（保存到 pages/，不要内联返回！）
playwright-cli snapshot --filename=outputs/web2prd/{slug}/pages/page-{NN}-{label}.yaml

# 3. 按需读取快照（只在需要精确元素引用时 read_file 文件）
#    read_file outputs/web2prd/{slug}/pages/page-{NN}-{label}.yaml

# 4. 记录到 exploration-log.md（见 1.4 持久化协议）
```

**关键**：快照始终 `--filename` 存盘，绝不裸调 `playwright-cli snapshot`（裸调会将完整 DOM 打印到 stdout 吃掉 context）。

**快照智能读取**（避免全量 read_file 大文件）：
- 需要找链接/按钮 → `grep "link\|button" pages/page-{NN}.yaml` 定向搜索
- 需要找表单字段 → `grep "textbox\|combobox\|checkbox" pages/page-{NN}.yaml`
- 需要看页面结构概览 → `read_file pages/page-{NN}.yaml` 加 `limit: 80` 只读前 80 行
- 需要精确定位某个元素的 ref → grep 元素文本关键词
- 只有确实需要完整 DOM 时才全量 read_file

**何时需要读快照 vs 只截图**：
- 只看页面长什么样、记录页面存在 → 截图即可，不读快照
- 需要点击/填写/hover 交互 → 必须读快照拿 element ref
- 需要提取表单字段详情 → 读快照

截图后快速分析：
- 页面目的（一句话）
- 主要 UI 区域
- 是否新模板
- 是否有多步流程信号（→ 触发 DFS）
- 是否有弹窗需要处理

### 第二轮：深度补充（扫描完成后，对关键页面执行）

对 P0 页面（核心流程节点）补充：

**交互探测**:
```bash
# 模态框（每页最多 3 个）
playwright-cli click {eNN}
playwright-cli screenshot --filename=...page-{NN}-modal-{name}.png
playwright-cli press Escape

# Tab 切换（模板相同只截前 2 个）
playwright-cli click {eNN-tab}
playwright-cli screenshot --filename=...page-{NN}-tab-{name}.png
```

**表单字段记录**: 从快照提取 name/type/required/placeholder/validation

**空/错误状态**:
```bash
# 404
playwright-cli goto {base_url}/nonexistent-page-404-test
playwright-cli screenshot --filename=...page-{NN}-404.png

# 空搜索
playwright-cli fill {eNN-search} "xyzrandomquery12345"
playwright-cli press Enter
playwright-cli screenshot --filename=...page-{NN}-empty-search.png
```

## 1.4 持久化协议

**这是防止长探索丢状态的关键机制。**

每探索完一页，立即更新 `outputs/web2prd/{slug}/exploration-log.md`：

1. **追加页面记录**（在"已探索页面"章节末尾追加）：
```markdown
### Page {NN}: {label}
- URL: {url}
- Template: {normalized} | NEW
- Type: {List}
- Screenshot: page-{NN}-{label}.png
- Findings: {一句话关键发现}
- Queued: {/path1}, {/path2}
```

2. **更新模板注册表**（如果是新模板，追加一行）

3. **更新探索队列**（追加/标记，不需要整体替换）：
   - 新发现的 URL 追加为 PENDING 行
   - 刚访问的条目改为 DONE
   - 跳过的标记 SKIP + 原因
   - 更新底部统计行

队列格式（每行一条，便于追加和标记）：
```markdown
## 探索队列

- [PENDING] https://example.com/products (P10, from Page 01 nav)
- [DONE] https://example.com/cart (P10, from Page 01 nav)
- [SKIP] https://example.com/about (P3, 页脚链接，非核心)
- [PENDING] https://example.com/checkout (P8, from Page 03 CTA)

**统计**: 已访问 2 / 已跳过 1 / 队列剩余 2
```

标记 DONE/SKIP 时只需 edit_file 替换该行的 `[PENDING]` → `[DONE]` 或 `[SKIP]`，新 URL 直接追加到列表末尾。

### 恢复协议

当你感觉丢失了探索上下文（不确定已经访问了哪些页面、队列里还有什么），**立即 read_file exploration-log.md**。这个文件包含完整的探索状态：
- 已探索页面列表 → 知道去过哪里
- 模板注册表 → 知道哪些模板已见
- 探索队列 → 知道下一步该去哪里

## 1.5 认证处理

遇到登录墙：
1. 截图 + 快照，记录表单字段
2. 询问用户是否提供测试账号
3. 提供 → `fill` + `click` 登录，截图记录登录后状态
4. 不提供 → 标记 `AUTH-GATED`，继续探索公开内容

遇到 CAPTCHA：截图记录类型 → 询问用户人工协助 → 无法通过则标记 `CAPTCHA-BLOCKED`

## 1.6 Cookie/弹窗处理

首次访问后检查遮罩层（Cookie 同意、营销弹窗）→ 快照定位关闭按钮 → `click` 或 `press Escape`

## 1.7 SPA 虚拟视图

点击后 URL 不变但内容改变时：
1. 点击前快照存盘：`playwright-cli snapshot --filename=...page-{NN}-before.yaml`
2. 执行点击
3. 点击后快照存盘：`playwright-cli snapshot --filename=...page-{NN}-after.yaml`
4. read_file 两个文件对比差异
5. 新 UI 区域 = 虚拟视图，URL 记为 `{parent_url}#virtual:{action}`
6. 对虚拟视图执行截图

### 1.7.1 Hover 导航批处理

当顶部导航全是 hover/JS 触发的下拉菜单时（如 `javascript:void(0)`），不要逐个入队，改为一次性批量扫描：

```bash
# 对每个导航项：hover → 截图 → 记录，不离开页面
playwright-cli hover {eNN-nav1}
playwright-cli screenshot --filename=...page-{NN}-nav-{name1}.png
playwright-cli hover {eNN-nav2}
playwright-cli screenshot --filename=...page-{NN}-nav-{name2}.png
# ... 依次处理所有导航项
```

每个下拉菜单作为一个虚拟视图记录到 exploration-log，但不需要每个都单独入队再逐个处理。一轮 hover 扫完后，将下拉菜单中发现的真实链接统一入队。

## 1.8 探索结束检查

- [ ] 所有顶层导航已访问或记录跳过原因
- [ ] 登录/注册流程已记录
- [ ] 至少 1 个创建/编辑表单已记录字段
- [ ] 搜索/筛选已触发
- [ ] 弹窗/模态框已触发并截图
- [ ] 至少一条端到端用户流程已覆盖
- [ ] 空/错误状态已尝试

---

# 阶段 2: 状态图构建

综合所有探索证据，填写 `templates/state-graph.md` → 输出到 `outputs/web2prd/{slug}/state-graph.md`。

**要求**：
- 每个已探索页面对应一个 NODE
- 每个虚拟视图对应一个 VVIEW
- 所有页面间跳转记录到 Edges 表
- 从表单字段推断数据实体
- 填写角色映射和覆盖率摘要

---

# 阶段 3: 文档生成

从 state-graph.md 派生 PRD，使用 `templates/prd.md` → 输出到 `outputs/web2prd/{slug}/prd.md`。

## 3.1 生成原则

1. 所有 FR 必须有 state-graph 节点作为证据
2. 置信度诚实：宁可标 Medium/Low 也不过度推断
3. 按用户目标分组，不按技术层次
4. 中文描述，技术名词保留英文

## 3.2 置信度矩阵

| 截图可见 | DOM 确认 | 置信度 |
|----------|----------|--------|
| ✅ | ✅ | 🟢 High |
| ✅ | ❌ | 🟡 Medium |
| ❌ | ✅ | 🟡 Medium |
| ❌ | ❌ | 🔴 Low |

## 3.3 优先级规则

| 优先级 | 原则 | 示例 |
|--------|------|------|
| P0 | 核心流程必经节点 | 商品浏览、加购、下单、登录 |
| P1 | 显著提升体验但非必须 | 搜索、筛选、收藏、评价 |
| P2 | 边缘场景或低置信度推断 | 分享、通知偏好、个性化 |

## 3.4 PRD 内容要求

PRD 必须包含：
- 执行摘要（产品定位、目标用户、核心价值）
- 用户角色表
- 功能模块（按用户目标分组，每个 FR 含优先级/置信度/证据/描述/验收标准）
- 核心业务流程（Mermaid flowchart）
- 数据模型（Mermaid ERD + 字段表）
- 非功能需求
- 待确认问题汇总

---

## 输出目录

```
outputs/web2prd/{slug}/
├── exploration-log.md    ← 探索日志（持久化状态）
├── state-graph.md        ← 状态图（唯一真实来源）
├── prd.md                ← 完整 PRD（含流程图 + 数据模型）
├── screenshots/          ← 页面截图（.png）
│   └── page-{NN}-{label}.png
└── pages/                ← 页面快照（.yaml，按需 read_file）
    └── page-{NN}-{label}.yaml
```

---

## 完成报告

```
## Web2PRD 完成报告

**应用**: {名称}
**URL**: {url}
**类型**: {类型}
**探索页面数**: {N}
**覆盖率**: {N}%

### 生成文档
- state-graph.md — {N} 个节点, {M} 条边
- prd.md — {N} 个 FR ({x} P0, {y} P1, {z} P2)

### 关键发现
- {核心功能}
- {用户角色/权限}
- {核心业务流程}
- {阻断记录}
```

---

## 结束

```bash
playwright-cli close
```

## Token 管理

| 操作 | 预估消耗 |
|------|----------|
| 截图分析（read_file .png） | ~200 tokens |
| 快照按需读取（read_file .yaml） | ~300 tokens（仅在需要元素引用时） |
| 快照存盘（--filename） | ~0 tokens（不进入 context） |
| 状态图节点 | ~200 tokens |
| **每页目标** | **< 500 tokens** |

核心原则：**所有 playwright-cli 输出都存磁盘，按需 read_file**。绝不让大块 DOM/快照内联进入 context window。
