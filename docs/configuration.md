# 本机配置

通常只需双击启动，无须手动配置。以下变量只影响本次启动，不改写全局 Codex 设置。

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `PORT` | 本机端口 | `4318` |
| `CODEX_BIN` | 指定可执行的 Codex CLI | 优先使用 PATH 中的 Codex，再检查桌面版附带程序 |
| `CODEX_HOME` | 使用你自己已有的 Codex 配置目录 | 由 Codex 决定；本程序不复制账号凭据 |
| `CODEX_DESKTOP_SOCKET` | 自定义桌面本机入口 | Mac 为 `CODEX_HOME/ipc/ipc.sock` 或 `~/.codex/ipc/ipc.sock`；Windows 为本机管道 `\\.\pipe\codex-ipc` |
| `YEWANG_DATA_DIR` | 岗位、任务、会话与设置存放目录 | 源码目录的 `.data/`；一键安装会使用独立 `data/` |
| `YEWANG_RUNTIME_DIR` | 启动记录与服务日志 | 数据目录的 `runtime/` |
| `YEWANG_WORKSPACES_ROOT` | 独立任务的工作目录根目录 | 数据目录的 `workspaces/` |
| `YEWANG_MAX_CONCURRENT` | 独立运行的并发上限 | `3`；同一项目仍串行写入 |

变量使用历史兼容前缀，不需要创建名为“野望科技”的公司。桌面聊天的 ID、显示名称和入口也可以直接在“连接设置”填写，只保存在自己的数据目录。

`YEWANG_IMPORT_COMPANY=1` 和 `YEWANG_COMPANY_ROOT` 是可选的旧组织导入接口，默认关闭。新用户不需要它们；源码不会自动去项目外寻找公司资料。若使用已有组织数据，应由拥有者明确提供自己的目录和有效的本机路由。

不要将数据目录、`.env`、账号文件或本机聊天 ID 提交到公开仓库。不要使用隧道或反向代理把本机接口直接暴露到公网。
