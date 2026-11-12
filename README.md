# dsh-bash-win

在 Windows 上为 DeepSeek Harness(DSH)提供 **Git Bash** 与 **WSL2** 两个 bash 工具的
Cordis 插件。

## 这个项目解决什么

- DSH 在 Windows 上**禁用了官方 bash 工具**(只有 pwsh)
  
本插件通过 `ctx.subprocess` 直接 spawn `bash.exe` / `wsl.exe`，绕开受限令牌层，
把 Git Bash 或者 WSL2 带进 DSH，并**自建有效沙箱**(WSL 内 bwrap)与**审批请求**。

## 安全模型

| 维度 | 机制 | 说明 |
| --- | --- | --- |
| **默认执行** | 无沙箱，全权限 | `git_bash` / `wsl_bash` 默认直接跑，可读写任意路径(绕开沙箱的代价) |
| **沙箱** | WSL 内 bwrap(`sandbox: true`) | 系统目录只读、workspace 可写、`/mnt/c` 其余只读;越界写入被拒并报 `[sandbox: file access denied under workspace-write mode]` |
| **审批** | `ctx.approval` | `require_approval: true` 执行前弹窗;升权请求(`sandbox_permissions` + `justification`)弹窗;`ask` 策略弹窗、`never` 自动拒绝 |

关键概念:

- **操作路径本身不触发审批**——沙箱对越界的处理是"拒绝"(报错，不弹窗);
- **审批只出现在三处**:受限会话下的 `git_bash` 强制闸门、显式批准模式(`require_approval`)和越界后的升权请求;
- **升权阶梯**:`workspace-write`(bwrap 受限)→ `danger-full-access`(去掉 bwrap)，
  走官方 `approveEscalation` 流程，必须严格加宽且经用户批准。

## 工具

| 工具 | 后端 | UI 标题 | 能力 |
| --- | --- | --- | --- |
| `git_bash` | 本地 Git Bash(MSYS2) | Git Bash | 批准模式(`require_approval`)、后台任务;**无 `sandbox` 参数**(Win 受限令牌下 Cygwin 起不来，沙箱只在 wsl_bash) |
| `wsl_bash` | WSL2(Linux) | WSL Bash | **bwrap 真沙箱**(`sandbox: true`)、升权审批(`sandbox_permissions` + `justification`)、后台任务 |

共性能力:

- 前台执行:**每条命令都注册成 job**(与官方 bash/pwsh 同一套运行时):
  运行期间 Web 端的后台任务面板可展开实时看输出、可两击停止;
  `timeoutMs` 到期不再杀进程,而是**升格**为后台任务,把 job id 交回模型
  (返回 `kind: promoted`,并附上已产出的输出;没有 job runtime 或
  `promoteOnTimeout: false` 时退回旧行为:超时终止整个进程树)。超时口径与官方一致:
  不传 = 120000ms,超过 600000ms 封顶,传 0 或负数直接报错,而不是"无限等"
- job 注册带 `toolCall: { callId, rootCallId }`，作业面板能与工具调用对齐
- 人类停止:用户从面板停止时,模型会收到完成通知与 `[stopped: cancelled by the user]`
- 取消:调用被中止时抛 `HarnessError(TOOL_ABORTED, name: 'AbortError')`，与官方工具同一套
- 后台任务:`run_in_background: true` 立刻返回 job id,配合 `job_output` / `job_kill`
  (非零退出码如实上报，kill 分类为 `killed`)
- 结果 schema:与官方 shell 工具同一套判别式 union——`background` / `promoted` /
  `foreground`，前台分支里 `stdout` / `stderr` 是 `{ text, truncated, spillPath? }`，
  沙箱事实放 `sandbox: { mode, denied, enforcement? }`
- 输出收集:内存上限 256 KiB，超限截断并落 spill 文件
- 文本格式与官方 shell 工具同一套:stdout → `[stderr]` 段 → 状态标记;退出码 0
  不打印标记，非零打印 `[exit code: N]`，信号打印 `[killed by signal: …]`，
  空输出写 `(no output)`，截断提示为 `[output truncated; full output: …]`；
  升格回执为 `[still running after Nms; moved to background job <id>]`
- 系统提示:注册 `tool:git_bash`(TOOL_BASH 槽) / `tool:wsl_bash`(TOOL_PWSH 槽)，
  与官方 bash→pwsh 的顺序一致；内容对齐官方（检查 `[exit code: N]`、Windows 被杀 = 1 按中断处理）
- 配置开关:`enableRunInBackground`(默认 true，关掉后不暴露 `run_in_background`)、
  `promoteOnTimeout`(默认 true，关掉后超时直接杀)
- Web 终端卡片:终端图标、可展开输出、退出码状态，与内置 bash/pwsh 卡片一致;
  命令从模型参数(`block.argsRaw`)实时读取，**运行中即可见**，参数仍在流式生成时也会逐步显示;
  升格卡片显示 `moved to background: <job id>`，人类停止显示 `stopped: <原因>`

## 支持与限制

### Git Bash(`git_bash`)

- 自动探测安装位置:`C:\Program Files\Git\bin\bash.exe`、
  `C:\Program Files\Git\usr\bin\bash.exe`、`C:\Program Files (x86)\Git\bin\bash.exe`
- MSYS2 完整语义(管道、重定向、Unix 风格命令)，Windows/Unix 路径混用
- 每次调用全新进程，状态不跨调用；相对 `workdir` 按会话工作目录解析
- **无文件沙箱**:受限令牌下 Cygwin 无法启动，因此 `git_bash` **不提供 `sandbox`
  参数**，默认以完整权限运行；需要沙箱时用 `wsl_bash` 的 bwrap
- **权限**:会话权限不是完全权限(danger-full-access)时，每次调用都先请求批准；
  拒绝、取消或审批服务缺失都会直接不执行
- 适合:需要 Windows 侧工具、msys 语义、或"全权限 + 人工批准把关"的场景

### WSL2(`wsl_bash`)

- 自动探测 `C:\Windows\System32\wsl.exe`;发行版默认 `Ubuntu`(可指定)
- `--cd` 自动转换 Windows 路径(`C:\Users\...` → `/mnt/c/Users/...`)，也可直接传 Linux 路径
- 真 Linux 环境:apt、gcc、python 等，Linux 退出码语义;以 WSL 默认用户身份运行
- VM 未启动时首次调用有数秒冷启动延迟(可用 `timeoutMs` 控制等待)
- 默认无沙箱(ext4 不受 Windows ACL 约束，Windows 侧沙箱管不住它)
- `sandbox: true` 时在 WSL 内用 **bwrap** 包装命令:系统目录(`/usr` `/lib`
  `/bin` `/etc` 等)只读、`/tmp` 临时可写、workspace 可写、`/mnt/c` 其余只读;
  要求发行版已安装 `bubblewrap`(`apt install bubblewrap`)
- 实现细节:bwrap 参数**逐个传递**(避免 wsl.exe 的 Windows→Linux 参数字符串
  序列化损坏引号);命令经 base64 编码传递(避免引号注入)

## 程序检测与配置

定位优先级:插件 `config` > 环境变量 > 自动探测。

```yaml
# cordis.patch.yml
- insert:
    - id: tool-bashx
      name: '@zimzaza4/dsh-bash-win'
      config:
        bashPath: 'C:\Program Files\Git\bin\bash.exe'  # 自定义 Git Bash
        wslPath: 'C:\Windows\System32\wsl.exe'  # 自定义 WSL
        wslDistro: 'Debian'                     # 默认发行版
        enableRunInBackground: true             # false = 不暴露 run_in_background
        promoteOnTimeout: true                  # false = 超时直接杀，不升格后台
```

环境变量:`DSH_BASHX_BASH_PATH` / `DSH_BASHX_WSL_PATH` / `DSH_BASHX_WSL_DISTRO`。

## 测试

不依赖宿主安装的两组测试:

```sh
node test/bashx-contract.test.mjs   # host 契约:参数面/schema/marker/升格/配置/abort/workdir/沙箱事实
node toolview-check.mjs             # Web 终端卡片渲染
```

`test/stubs/` 用 loader hook 把 `@deepseek-ai/dsh-tools`、`dsh-sandbox`、`dsh-llm`
映射成本地桩，所以直接跑源码即可。

## 安装

插件已发布到 npm。通过 DSH 官方 `dsh plugin` 命令安装进 **profile**(`dsh web`
对应 `web` profile)。

### 从 npm 安装(推荐)

```sh
dsh plugin --profile web add @zimzaza4/dsh-bash-win
```

装完**重启 `dsh web`** 生效。包内 `cordis.patch.yml`(经 `dsh.bundle.patch`
声明)自动挂载插件行，重启后即可在对话中使用 `git_bash` / `wsl_bash`。

### 从本地目录安装(开发调试)

```sh
dsh plugin --profile web add link:/path/to/dsh-bash-win
```

(Windows 上写成 `link:D:/path/to/dsh-bash-win`。)

`link:` 仅适用于本机开发目录;装完同样需要重启 `dsh web`。

### 验证

- 重启后新会话中应出现 `git_bash` / `wsl_bash` 两个工具;
- 或用 `dsh --profile web --dump-config` 确认插件配置层已挂载;
- 若工具未出现，多半是安装后没有重启 `dsh web`。

### 卸载

```sh
dsh plugin --profile web remove @zimzaza4/dsh-bash-win
```

然后重启 `dsh web`。

### 注意事项

- **改代码后必须重启 DSH**——本插件的 HMR 热加载在此部署中不可靠，重启是唯一
  可靠加载路径;
- 通过 UI 卸载插件会删除 profile 的 `cordis.patch.yml`;重新安装时重建该文件即可

## 依赖

- `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-sandbox`、`@deepseek-ai/dsh-llm`(peer，宿主提供)
- 运行时服务:`tools` / `systemPrompt`(硬依赖);`subprocess` / `fs` / `timer` /
  `jobs` / `approval` / `sandbox` / `sandboxPolicy`(可选 `ctx.get`)
- 本机程序(按需):Git for Windows、WSL + 发行版;沙箱模式另需发行版内 `bubblewrap`

## License

MIT
