# dsh-config-generations

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）profile 插件树配置的版本控制。每当一个已启动 profile 的配置发生变化，host 就会记录一个**代（generation）**——该配置的持久输入，以其摘要寻址，连同这些输入组合出的结果与针对它的每次启动尝试一起存储。之后你可以在 Web 侧边栏浏览这份历史、比较两份配置，或从面板或独立 CLI 恢复到较早的一份。

本包是一个标准的外部 dsh 插件：用 `dsh plugin add` 安装，像任何其他 bundle 一样挂进 profile 的插件树，无需给 dsh 核心打补丁。

## 安装

包发布到 npm 之后：

```sh
dsh plugin --profile web add dsh-config-generations
```

发布之前，可以从 tarball 或 git URL 安装——同一条命令两种形式都接受：

```sh
dsh plugin --profile web add ./dsh-config-generations-0.1.0.tgz
dsh plugin --profile web add git+https://github.com/Electricitysheep/dsh-config-generations.git
```

安装后启动一次 `web` profile；第一代会在那次启动时被记录。

### 兼容性

已在实机上对 `@deepseek-ai/dsh@0.1.0-rc.6` 验证通过。peer 依赖范围为 `@deepseek-ai/cordis@^4.0.1`、`@deepseek-ai/dsh-app-boot` 与 `@deepseek-ai/dsh-atomic-write@^0.1.0-rc.6`；处于这些范围内的 dsh 安装会自带它们。

## Web 面板

安装插件后，`web` profile 侧边栏底部会出现 **配置代（Config generations）** 入口（分支图标）。点击后历史列表在底栏上方展开：

- 每行显示代 id、最近使用时间与最近一次启动状态——**已激活**（启动到达了运行中的树）、**启动失败**、或**未启动**（已记录但尚无启动结果）。
- 行上可能出现两个徽标：**最近可用（Last good）** 标记最新一份曾激活成功的配置——恢复时最可能想要的那份；**当前启动（Booted now）** 标记当前运行进程启动所用的配置。
- 点击某行展开其详情：各 bundle 层及其记录的版本、每次启动结果（含错误文本与当时的 `--patch` 覆盖层）、以及完整渲染出的组合结果。
- 详情底部的 **恢复** 按钮会打开一个确认框，逐项列出将被写回的文件。确认后写入该代的输入文件，验证它们仍能重现所记录的树，然后报告写入结果或拒绝原因（见下文）。恢复在下次启动时生效。

## 独立 CLI

本包附带 `dsh-config-generations` 可执行文件，供在已启动的树之外的 shell 中使用：

```sh
dsh-config-generations log --profile web       # 列出已记录的配置，最旧在前
dsh-config-generations show --profile web <id> # 打印一份配置的组合结果
dsh-config-generations diff --profile web <id> [id]
                                               # 比较两份组合（默认与最新一份比较）
dsh-config-generations restore --profile web <id>
                                               # 把一份配置的输入文件写回
```

每次调用都必须带 `--profile <name>`。`<id>` 可以缩写为任意无歧义的前缀。

CLI 在 Harness home 下解析 profile：环境变量 `DSH_HOME` 已设置且非空时取它，否则取 `~/.dsh`。

## 什么是"一代"

一代记录的是决定一个 profile 插件树的三份**持久输入（durable inputs）**：

1. profile 清单——`<profile>/package.json`，具体说是其中的 `dsh.profile.bundles` 列表；
2. profile 补丁层——`<profile>/cordis.patch.yml`；
3. home 补丁层——`$DSH_HOME/cordis.patch.yml`，叠在每个 profile 自己的补丁层之上。

每条记录位于 `<profile>/config-generations/<id>.json`，`<id>` 是三份输入文本摘要的前 12 位十六进制字符。除输入外，记录还携带这些输入渲染出的组合结果、每个 bundle 层解析到的版本、以及针对该配置的每次启动结果。

**记录的是变更，不是启动。** 以未变化的配置再次启动，只会向已有记录追加一个新的启动结果，而不是新增一条记录。`recordedAt` 标记该配置首次出现的时间，永不移动；`lastSeenAt` 决定历史顺序。

### 恢复语义

恢复会把三份输入文件写回（该代记录为缺失的补丁层则删除），然后**通过与启动完全相同的组合路径重新组合 profile**，验证所记录的树是否仍可重现：

- 验证通过时，恢复的配置**在下次启动时生效**。运行中的树保留自己挂起的那份组合——在运行中的树自己的活跃 agent 之下替换其组合没有已定义的生命周期。
- 如果某个已记录 bundle 的已安装版本发生了移动（**漂移**），恢复会被**拒绝**，漂移的包会被点名，所有输入文件全部回滚。bundle 变化之后只替换输入文件，会组合出一棵不同的树，却看起来像是成功回到了先前的状态。
- settings 文档会被记录在代上，但**从不写回**：`dsh-settings-file` 以跨进程写者锁拥有它，会拒绝可能覆盖未被观察到的编辑的写入。把 settings 还原到某个已记录状态仍是手工编辑。

### 保留策略

历史保留最新的 50 代，外加最新一代曾激活成功的配置——无论它多旧。恢复需要的是最后一份已知可用的配置，而不是最近 50 次启动。

## 限制

- **恢复在下次启动时才生效**，从不在运行中的进程内生效。
- **与把该功能补丁进 dsh 核心的 fork 方案互斥。** 两者挂载同一个 `configGenerations` 服务与 RPC 面；请只对原版（stock）dsh 安装使用本插件。
- **Loopback 边界。** Web 面板通过一个以 `authority: 'loopback'` 注册的 Connection RPC 通道与服务通信——只应答同主机客户端，远程连接不可达。
- **运行期的补丁重载不新增一代。** `dsh` 运行期间做出的编辑只会在下次启动时被记录。
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
