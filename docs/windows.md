# Windows 预览

安装器、启动停止、配置持久化和桌面命名管道已实现。桌面聊天的双向消息尚缺真实 Windows 桌面验证，不标为完整支持。

## 开始

1. 安装 Node.js 20 或以上版本。独立团队另需 [Codex CLI](https://developers.openai.com/codex/cli/) 并完成自己的登录。
2. 桌面模式需要已安装、打开并登录的 [Codex Windows 桌面版](https://developers.openai.com/codex/app/windows/)，以及一个本机打开的聊天。
3. 按 README 运行 PowerShell 安装命令。安装目录默认是 `%LOCALAPPDATA%\OnePersonCompany`；没有 Node.js 时会提示，不会自动安装其他软件。
4. 双击安装目录里的 `启动公司.cmd`，在浏览器按引导建立自己的公司。

不需要管理员权限。支持 Windows PowerShell 5.1 和 PowerShell 7 的安装入口；脚本保存为带 BOM 的 UTF-8，适应中文文件夹。安装器用 `current.json` 指向版本，不依赖符号链接权限。

## 更新、端口和数据

再次运行安装命令会保留 `data/` 和已记录的端口。它先核对并停止自己的实例，再切换版本。端口属于其他公司时会拒绝覆盖。

需要其他目录或端口时，先下载安装器，再执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -InstallRoot 'D:\My Company' -Port 4320
```

`-ExecutionPolicy Bypass` 仅用于当前安装脚本进程，不修改系统或用户的长期执行策略。安装器不添加防火墙规则，不注册开机服务，不开放公网端口。

下载使用当前 PowerShell 的系统代理；存在 `HTTPS_PROXY` 时优先使用该变量。若网络报错，检查 GitHub 是否可访问后重试。

## Codex 的程序与桌面入口

独立团队会在 PATH 中寻找原生 `codex.exe`，或 npm 安装的 `@openai/codex/bin/codex.js`。JavaScript 入口通过 Node 直接启动，不经 shell 拼接参数。常见 npm 的 `codex.cmd` 会映射到对应 JavaScript 入口；自定义 `CODEX_BIN` 请指向 `.exe` 或 `.js`。

Windows 桌面默认入口是本机命名管道 `\\.\pipe\codex-ipc`。这与 Mac 的 Unix socket 不同，不要求 POSIX uid 或 chmod。程序只接受本机管道，仍检查 initialize、持有端、请求方法及事件版本；不会因管道存在就宣称目标聊天已连接。

Windows 原生运行和 WSL 使用各自的程序与路径。本入口面向原生 Windows，不把 WSL 的 Unix socket 当作 Windows 管道。

## 实际验证范围

Windows CI 在真实 Windows 执行环境检查：隔离回归、PowerShell 5.1/7 安装、中文和空格目录、首次零岗位引导、页面与服务接口、重复安装保留设置及端口、Codex CLI 发现、真实 App Server 初始化、启动器停止。不登录账号、不复制凭据、不发送模型任务。

已在 Windows Server 2025、Node.js 24.21.0、Codex CLI 0.162.1 的真实 Windows 执行环境通过上述检查，PowerShell 5.1 与 7 分别运行。已补充从公开 GitHub 下载源码和实际 CMD 启动停止，记录见 [Windows 公开下载与启动验证](https://github.com/Let-Lee/one-person-company/actions/runs/38695169514)；初次通过见 [实际 Windows 运行](https://github.com/Let-Lee/one-person-company/actions/runs/38692524440)。后续提交结果见 [Windows 安装与运行检查](https://github.com/Let-Lee/one-person-company/actions/workflows/windows.yml)。修复前的失败记录保留，不当作通过结果。

**仍未验证：Windows Codex 桌面应用中的真实聊天双向消息、桌面升级后的协议兼容，以及各用户账号的工具能力。** CI 的管道协议替身与 Mac 实测不能替代这项验证。只有真实连接到当前目标聊天的持有端，界面才会显示连接成功。

## 排查

- 双击 `检查公司.cmd`，分别看 Node.js、Codex CLI 与桌面入口。
- 找不到 CLI：确认 `codex --version` 在新终端能运行，或配置 `CODEX_BIN` 为原生程序或 JavaScript 入口。
- 桌面未连接：打开 Codex 和目标聊天，再到连接设置保存并检查；不要用“独立团队已连接”代替桌面连接结果。
- 端口占用：为当前安装指定其他端口；启动器会记住它，不会停止占用端口的其他程序。
- 更新失败：原数据仍在 `data/`；日志位于 `data/runtime/server.log`。
