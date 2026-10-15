# 调用、会话与结果回传

这份说明对应当前源码的两个入口：独立团队的岗位会话，以及用户选定的 Codex 桌面聊天。普通使用只需在页面操作；下面的接口用于理解路由或接入自己的本机流程。

## 两种会话怎样绑定

| 标识 | 作用 | 从哪里获得 |
| --- | --- | --- |
| 岗位 key | 确定职责、默认参数与所选 Skill | “岗位”页面或 <code>GET /api/roles</code> |
| 本机会话 <code>ses_…</code> | 控制台保存的岗位对话记录 | “会话记录”或 <code>GET /api/sessions</code> |
| Codex <code>threadId</code> | 真正承载上下文的 Codex 会话 | 本机会话记录中的 <code>threadId</code> |
| 执行 <code>run_…</code> | 该会话的一次任务运行 | 提交任务后的返回值 |
| Codex <code>turnId</code> | 该次运行对应的 Codex 回合 | 运行开始后的任务详情 |
| 团队任务 <code>teamtask_…</code> | 把经理派单、员工执行、回报和验收串在一起 | “岗位协作”或 <code>GET /api/collaboration</code> |

独立团队的一位岗位对应自己的稳定协作会话。经理会话与员工会话不同，员工回报不会把员工上下文合并为经理上下文，而是向经理提供本轮需要处理的回报和文件信息。服务重启后按已保存的 Codex 会话 ID 恢复。

桌面模式直接保存你选择的原聊天 ID。它不是独立团队的 <code>ses_…</code>，也不会自动创建与桌面员工一一对应的岗位。

## 独立团队的完整调用

| 顺序 | 实际调用 | 宿主做什么 |
| --- | --- | --- |
| 1 用户提交 | 页面调用 <code>POST /api/runs</code> | 核对本机会话、去重请求、保存运行并入队 |
| 2 经理开始 | App Server <code>thread/resume</code>（必要时）及 <code>turn/start</code> | 使用经理已保存的 <code>threadId</code>，传入本次目标与 Skill |
| 3 经理派单 | <code>yewang_team</code>、<code>yewang_dispatch</code> | 从真实来源会话确认经理身份，只给本组已有稳定会话的员工派单 |
| 4 员工执行 | 员工会话的 <code>turn/start</code> | 在团队工作目录执行，记录命令、文件与工具事件 |
| 5 员工回报 | <code>yewang_report</code> | 保存结果和产物；完成回报核对实际文件，等该轮结束后投递经理收件箱 |
| 6 经理收到关键回报 | 收件箱事件创建经理原会话的下一轮 | 经理空闲且未暂停时处理；阻碍、需决定优先，普通进度不唤醒 |
| 7 核验与处理 | <code>yewang_inbox</code>、读取文件、<code>yewang_review</code> | 验收要求本轮成功核验动作且交付文件指纹未变；修正则重新投递员工 |
| 8 展示结果 | <code>GET /api/events</code> 与状态查询 | 对话显示经理回复，协作页显示交付和验收，任务页保留执行记录 |

内部工具由 App Server 通过 <code>item/tool/call</code> 请求宿主执行。宿主核对运行进程、真实会话、回合、岗位权限、团队与当前任务，不接受参数自填发送者身份。内部工具不是可直接调用的公共 HTTP 派单接口。

### 从页面发任务

1. 按引导建立经理和员工，明确岗位职责与团队工作文件夹。
2. 在“岗位”中配置成员的技能；保存后随下一轮使用。
3. 打开“交代任务”或经理固定对话，写明目标、可修改范围和交付标准。
4. 在“岗位协作”看派单、交付和收件箱；在“任务”看具体执行和审批。
5. 经理验收后，在同一经理对话中看最终回复，需要时打开交付文件。

团队任务的暂停、取消、续办在“岗位协作”操作。运行中断后记录与会话保留；暂停会阻止旧事件自动推动该任务，明确续办后使用新的执行批次继续。已取消或验收的团队任务需要新任务授权，不能靠旧回报重新启动。

### 本机 HTTP 示例

先完成引导，用下面的只读请求找到自己的经理本机会话：

```sh
curl http://127.0.0.1:4318/api/sessions
```

将 <code>ses_YOUR_MANAGER</code> 换成返回的经理 <code>id</code>。下面的提交会真正启动一项模型任务：

```sh
curl http://127.0.0.1:4318/api/runs \
  -H 'Content-Type: application/json' \
  -H 'x-yewang-workbench: 1' \
  --data '{"sessionId":"ses_YOUR_MANAGER","requestId":"welcome-example-001","prompt":"请给内容策划派单，只在团队工作目录编写 welcome.md，不超过180字；交付后读取文件验收，再告诉我结果。"}'
```

返回的 <code>id</code> 是本次 <code>run_…</code>。HTTP 成功或状态为排队只代表请求已保存，不代表员工已完成。查询执行与团队链路：

```sh
curl http://127.0.0.1:4318/api/runs/run_YOUR_RUN
curl http://127.0.0.1:4318/api/collaboration
curl -N http://127.0.0.1:4318/api/events
```

重试同一提交时保留相同 <code>requestId</code> 和相同内容；新任务使用新 ID。同一 ID 内容不同会拒绝，不用换 ID 绕过未明确的提交结果。

以上示例使用 Mac 终端的换行与引号写法。Windows 可用 <code>Invoke-RestMethod</code> 发送相同 JSON 和请求头。写接口检查本机 Host、请求头和存在时的 Origin。这里没有为公网客户端提供账号鉴权，保持默认本机使用。

## 桌面模式的完整调用

1. 页面保存聊天 ID，<code>PUT /api/desktop-connection</code> 核对设置。
2. 本机通道发现该聊天当前持有端，订阅并收到目标聊天状态后，才显示“已连接”。
3. 页面调用 <code>POST /api/desktop-manager/messages</code>，正文只有 <code>requestId</code> 和 <code>text</code>。
4. 连接适配器向这个持有端发出 <code>thread-follower-start-turn</code>，目标使用已保存的聊天 ID，设置为继承该聊天原配置。
5. 只处理匹配本机、目标聊天和持有端的 <code>thread-stream-state-changed</code> 事件，将本页所发消息对应的进度和回复回传页面。

消息 API 不接受临时 <code>threadId</code>、发送者身份或工具列表覆盖。已提交或状态未知的请求保留原记录，不静默重发。原桌面持有端继续拥有聊天，本连接不会同时建立第二个写入者。

这个入口能沿用原聊天已有的工具与 Skill。它不会把独立团队的 <code>yewang_dispatch</code> 自动注入桌面聊天；原经理怎样调员工取决于原聊天已有的能力与授权。其他桌面员工的任务详情、审批和停止续办继续在 Codex 管理。

本页只保存通过本页发送的消息及对应回复，不把订阅到的其他历史全部存入本机公司数据。解除绑定只断开订阅，不删除原聊天。具体步骤和版本范围见 [桌面连接](desktop-connection.md)。

## Skill 怎样提供，进度怎样展示

独立团队通过 Codex 的 <code>skills/list</code> 在运行目录发现技能，校验所选名称和路径；开始回合时，以结构化 <code>skill</code> 输入随任务传入。任务页根据 Codex 返回的输入事件记录“本轮已接收”，并保留当时文件指纹。

这证明 Skill 被提供并接收，实际效果仍要看命令、工具、产物与验收，不能仅凭技能名称断言执行成功。桌面模式则由原聊天决定技能与工具可用性。

独立运行的 App Server 通知包括回合状态、命令执行、文件变化和回复片段。本机服务把这些事件关联到 <code>threadId / turnId / runId</code>，保存记录并通过 SSE 刷新页面。桌面模式由目标聊天的状态订阅回传。刷新页面或查看进度不会另起一个模型解释执行情况。

## 哪些动作增加执行回合

- 发送任务、经理向员工派单、要求修正、明确续办，会在相应会话发起模型执行回合。
- 员工完成、遇到阻碍或需要决定后，关键回报在经理空闲且未暂停时触发一轮经理处理。
- 执行中“追加指令”更新当前回合，不创建新的固定会话；当前模型仍可能继续产生用量。
- 打开页面、读取状态、连接检查、空会话建立、Skill 选择本身不会启动模型执行回合。
- 暂停和停止向现有运行请求中断；不会为了显示状态额外调用模型。

[返回首页](../README.md) · [配置与排查](configuration.md) · [Windows 验证范围](windows.md)
