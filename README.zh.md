# dsh-timemachine

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）profile 插件树配置的版本控制。每当一个已启动 profile 的配置发生变化，host 就会记录一个**代（generation）**——该配置的持久输入，以其摘要寻址，连同这些输入组合出的结果与针对它的每次启动尝试一起存储。在这份历史之上，插件还提供带持久化重做栈的撤销/重做、编辑后自动存档、手动快照、以及遇漂移拒绝的恢复；这些能力可以从四个入口驱动：Web UI（侧边栏面板 + 会话头部按钮与快捷键）、agent 可调用的对话指令、独立 CLI、以及用于整个 dsh 树都起不来时的 loopback 局外救援 GUI。

本包是一个标准的外部 dsh 插件：用 `dsh plugin add` 安装，像任何其他 bundle 一样挂进 profile 的插件树，无需给 dsh 核心打补丁。

## 安装

包发布到 npm 之后：

```sh
dsh plugin --profile web add dsh-timemachine
```

发布之前，可以从 tarball 或 git URL 安装——同一条命令两种形式都接受：

```sh
dsh plugin --profile web add ./dsh-timemachine-0.2.0.tgz
dsh plugin --profile web add git+https://github.com/vimalinx/dsh-timemachine.git
```

安装后启动一次 `web` profile；第一代会在那次启动时被记录。

### 兼容性

已在实机上对 `@deepseek-ai/dsh@0.1.0-rc.6` 验证通过。peer 依赖范围为 `@deepseek-ai/cordis@^4.0.1`、`@deepseek-ai/dsh-app-boot`、`@deepseek-ai/dsh-atomic-write` 与 `@deepseek-ai/dsh-tools@^0.1.0-rc.6`；处于这些范围内的 dsh 安装会自带它们。

## Web UI

### 侧边栏面板

安装插件后，`web` profile 侧边栏底部会出现 **配置代（Config generations）** 入口（分支图标）。点击后历史列表在底栏上方展开：

- 每行显示代 id、最近使用时间、最近一次启动状态——**已激活**（启动到达了运行中的树）、**启动失败**、或**未启动**（已记录但尚无启动结果）——以及一个**来源徽标**，标明该记录如何产生（启动 / 自动 / 手动 / 后悔），手动快照的原因会一并显示。
- 行上还可能出现两个徽标：**最近可用（Last good）** 标记最新一份曾激活成功的配置——恢复时最可能想要的那份；**当前启动（Booted now）** 标记当前运行进程启动所用的配置。
- 点击某行展开其详情：各 bundle 层及其记录的版本、每次启动结果（含错误文本与当时的 `--patch` 覆盖层）、以及完整渲染出的组合结果。**与当前对比**会展开该代相对当前在线配置的行内 diff 预览，红绿高亮，长段未变化内容折叠为 `… (N unchanged lines)` 标记。
- 详情底部的 **恢复** 按钮会打开一个确认框，逐项列出将被写回的文件。确认后写入该代的输入文件，验证它们仍能重现所记录的树，然后报告写入结果或拒绝原因（见下文）。恢复在下次启动时生效。
- **删除此代** 在确认后删除一条记录；「最近可用」记录——以及树运行中当前启动所用的配置——受保护不可删除。
- 工具栏可以记录**手动快照**（可附原因）、按需**清理过期**的「启动/自动」记录、以及把整份历史**导出/导入**为一个 ZIP 归档（导入从不覆盖已有记录）。
- 最近一次启动未能激活时，面板顶部会出现横幅，提供一键回退到「最近可用」。
- **设置**区收纳插件自身的开关：自动存档开关、防抖毫秒、保留数量、以及撤销/恢复快捷键。

### 会话头部按钮与快捷键

每个会话头部会增加三个按钮（挂载在 `conversation.session.header.actions` 槽位）：**撤销**（红）、**恢复**（绿）、**快照**。撤销与恢复会先弹出确认；没有可撤销/恢复的目标时会明确提示，而不是悄无声息地无事发生。

默认快捷键为 **Ctrl+Alt+Z**（撤销）与 **Ctrl+Alt+Y**（恢复）。它们打开与按钮相同的确认框，且当输入框或其他可编辑元素持有焦点时绝不劫持按键。两者都可以在面板设置区自定义：聚焦输入框后按下组合键即可录入，Backspace 恢复默认。

## 对话指令

插件注册了五个 agent 工具——`timemachine_snapshot`、`timemachine_undo`、`timemachine_redo`、`timemachine_restore`、`timemachine_list`——因此对 agent 说「撤销上一步」「回退到某个版本」「恢复」「保存快照」「查看配置历史」（或对应的英文说法）即可触发。每次调用都会向发起 agent 的会话日志追加一条 `timemachine/*` 事件，作为谁动过配置的审计轨迹。

## 独立 CLI

本包附带 `dsh-timemachine` 可执行文件，供在已启动的树之外的 shell 中使用：

```sh
dsh-timemachine log --profile web          # 列出已记录的配置，最旧在前
dsh-timemachine show --profile web <id>    # 打印一份配置的组合结果
dsh-timemachine diff --profile web <id> [id]
                                           # 比较两份组合（默认与最新一份比较）
dsh-timemachine restore --profile web <id> # 把一份配置的输入文件写回
dsh-timemachine undo --profile web         # 回退到上一份配置
dsh-timemachine redo --profile web         # 前进一步到撤销所离开的配置
dsh-timemachine snapshot --profile web [reason]
                                           # 按当前状态记录一份配置
dsh-timemachine remove --profile web <id>  # 删除一条记录（最近可用的一份受保护）
dsh-timemachine status --profile web       # 撤销/重做可用性、启动健康状况、最新配置
dsh-timemachine export --profile web [out.zip]
                                           # 把整份历史打成 zip（默认 dsh-timemachine-<YYYYMMDD-HHmmss>.zip）
dsh-timemachine import --profile web <zip> # 把归档解进历史，从不覆盖已有记录
dsh-timemachine prune --profile web        # 立即应用保留上限
dsh-timemachine settings --profile web [--set k=v]
                                           # 打印设置；--set 更新 autoSave、debounceMs、
                                           # retention、shortcuts.undo、shortcuts.redo（可重复）
dsh-timemachine gui --profile web          # 在 127.0.0.1 上提供救援页面并打开浏览器
```

每次调用都必须带 `--profile <name>`。`<id>` 可以缩写为任意无歧义的前缀。没有可步进目标时，undo/redo 会打印 "nothing to undo" / "nothing to redo" 并以退出码 1 结束。

CLI 在 Harness home 下解析 profile：环境变量 `DSH_HOME` 已设置且非空时取它，否则取 `~/.dsh`。

## 局外救援 GUI

`dsh-timemachine gui --profile web` 从一个只监听 loopback 的服务器（127.0.0.1，随机空闲端口）提供一个自包含的救援页面，并用 `xdg-open` 打开；Ctrl+C 停止服务器。它为「整个 dsh 树都起不来」的场景而造：只依赖 node 内建模块与本包自己的核心层，从不依赖运行中的 dsh。

页面覆盖面板的全部能力——列表、diff 预览、恢复（同样先列出将写回的文件再确认）、删除、清理过期、导出/导入、以及设置——外加启动异常横幅与一键回退「最近可用」。如果检测到 dsh web 外壳似乎在运行（对 127.0.0.1:3080 的 TCP 探测有人应答），页面会显示黄色警告，且恢复操作需要二次确认；探测只警告，从不拦截。

页面语言跟随系统 locale；`DSH_TIMEMACHINE_LANG=zh|en` 可强制指定。系统托盘刻意不做。

## 什么是"一代"

一代记录的是决定一个 profile 插件树的三份**持久输入（durable inputs）**：

1. profile 清单——`<profile>/package.json`，具体说是其中的 `dsh.profile.bundles` 列表；
2. profile 补丁层——`<profile>/cordis.patch.yml`；
3. home 补丁层——`$DSH_HOME/cordis.patch.yml`，叠在每个 profile 自己的补丁层之上。

每条记录位于 `<profile>/timemachine/<id>.json`，`<id>` 是三份输入文本摘要的前 12 位十六进制字符。除输入外，记录还携带这些输入渲染出的组合结果、每个 bundle 层解析到的版本、以及针对该配置的每次启动结果。

**记录的是变更，不是启动。** 以未变化的配置再次启动，只会向已有记录追加一个新的启动结果，而不是新增一条记录。`recordedAt` 标记该配置首次出现的时间，永不移动；`lastSeenAt` 决定历史顺序。

### 来源（origin）

每一代都记录自己如何产生：**启动（boot）**——启动器观察自己的启动；**自动（auto）**——文件系统监视器看到落定后的编辑；**手动（manual）**——显式快照，可附带原因；**后悔（regret）**——撤销为它离开的配置所写的记录，好让重做能回到那里。该字段出现之前写入的记录读作 `boot`。

### 撤销与重做

- 代历史本身就是撤销栈：撤销回退到最近见过、且输入与当前不同的一份配置，通过与恢复相同的验证路径把它的输入文件写回（下次启动生效）。步进之前，撤销会把正要离开的配置记录为一个后悔代——那份记录就是重做要回到的地方。
- 只有重做栈需要文件：`<profile>/timemachine/undo-state.json`，因此重做可以跨重启存活。任何新的配置记录（输入变化后的启动、自动存档、快照、恢复）都会清空重做栈——撤销自己写的后悔代除外，因为它本身就是重做目标。重做栈中指向已被删除或清理掉的记录的条目会被跳过，而不是复活。
- 没有可步进目标时，撤销/重做会明确回答「没有可撤销的配置」/「没有可恢复的配置」，而不是静默失败。

### 自动存档与自写抑制

自动存档开启时（默认），树内服务监视三份持久输入，把落定后真实发生变化的状态在防抖之后记录为一个 `auto` 代（默认 1500 毫秒，可在设置中调整）。内容未变的重写完全不触发。服务自己刚做的写入——恢复、撤销、重做——在落盘前按摘要登记，绝不触发自动记录，因此它自己的写入不会误伤那本会被清掉的重做栈。

### 恢复语义

恢复会把输入文件写回（该代记录为缺失的补丁层则删除），然后**通过与启动完全相同的组合路径重新组合 profile**，验证所记录的树是否仍可重现：

- 验证通过时，恢复的配置**在下次启动时生效**。运行中的树保留自己挂起的那份组合——在运行中的树自己的活跃 agent 之下替换其组合没有已定义的生命周期。
- 如果某个已记录 bundle 的已安装版本发生了移动（**漂移**），恢复会被**拒绝**，漂移的包会被点名，所有输入文件全部回滚。bundle 变化之后只替换输入文件，会组合出一棵不同的树，却看起来像是成功回到了先前的状态。
- settings 文档会被记录在完整视野（full-scope）的代上，但**从不写回**：`dsh-settings-file` 以跨进程写者锁拥有它，会拒绝可能覆盖未被观察到的编辑的写入。把 settings 还原到某个已记录状态仍是手工编辑。
- 树内恢复（面板、对话工具、RPC）还会把完整视野的代所记录的本地自创 preset 文件一并写回，并刻意不动 home 补丁层；独立 CLI 与救援 GUI 没有 settings/preset 视野，只写三份持久输入。

### 保留策略

保留分两层。**手动**快照与**后悔**记录永不被自动清理。**启动**与**自动**代受保留数量约束（默认 50，可调）：最新的这么多代存活。而最新一代曾激活成功的配置——最近可用——无论多旧都会被保留，因为恢复需要的是最后一份已知可用的配置，而不是最近 50 次启动。记录新代时会顺带执行清理；面板工具栏、CLI 的 `prune` 与 RPC 端点按同样规则按需清理。

## 限制

- **恢复在下次启动时才生效**，从不在运行中的进程内生效。
- **与把该功能补丁进 dsh 核心的 fork 方案互斥。** 两者挂载同一个 `timemachine` 服务与 RPC 面；请只对原版（stock）dsh 安装使用本插件。
- **Loopback 边界。** Web 面板通过一个以 `authority: 'loopback'` 注册的 Connection RPC 通道（`/timemachine`，端点为 `list`、`read`、`restore`、`snapshot`、`undo`、`redo`、`remove`、`diff`、`export`、`import`、`status`、`getSettings`、`updateSettings`、`prune`）与服务通信——只应答同主机客户端，远程连接不可达。救援 GUI 的服务器同样只绑定 127.0.0.1。
- **CLI 与救援 GUI 要求 profile 已被创建。** 两者都经由启动器自己的加载器解析 profile，因此未知的 profile 名会在打开时报错；存在但从未启动过的 profile 只是还没有任何记录——先启动一次。
- **救援 GUI 的 dsh 运行检测是启发式的。** 它对 web 外壳的固定端口 3080 做 TCP 探测：该端口上的外来服务会造成误报，绑在别处的 shell 会造成漏报。这正是 GUI 选择警告加二次确认、而不是直接拒绝的原因。
- **不做系统托盘。** 救援 GUI 就是一个自包含页面加一个 loopback 服务器，这是设计如此。
- **settings 与 `.env` 刻意不碰。** settings 文档会被记录但从不写回（见上文），任何 `.env` 文件都既不读也不写——一次恢复移动的恰好是它确认框里列出的那些文件，不多不少。
- **运行期的补丁重载不新增一代。** 自动存档开启时，`dsh` 运行期间做出的编辑由监视器在落定后记录；关闭时，只在下次启动（或一次显式快照）时记录。
- **每次调用的瞬时输入不可恢复。** `--patch` 覆盖层与环境开关会记录在启动结果上供参考，但从不写回，因为它们并不持久。
- **恢复在崩溃面前不是原子的。** 先写入输入，再验证，不匹配则回滚；进程在该窗口内被杀死会让被恢复的配置留在原处——那是一份先前曾激活成功的配置，不是损坏的配置。
- **不恢复 bundle 版本。** 被拒绝的恢复会点名发生漂移的包；重装它们由你决定。

## 开发

```sh
pnpm install
pnpm build      # tsc -p tsconfig.build.json && tsdown
pnpm test       # vitest run
pnpm typecheck  # tsc -p tsconfig.json --noEmit
```

## 许可证

[MIT](LICENSE)
