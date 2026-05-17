# 内测上线检查表

这份清单用于把 agent-bridge 从“代码可运行”推进到“可以安全进入内测”。默认假设你在仓库根目录：

```bash
cd /d/data/spectrai-data/agent-bridge
```

## 1. 构建与测试

发布前至少执行：

```bash
npm install
npm run build
npm run test:run
```

通过标准：

- `npm run build` 成功
- 全量测试通过
- 没有新增未解释的失败或跳过项

## 2. Project 配置检查

确认本次上线使用的 `project` 文件已经检查过：

- `model.provider` 正确
- `connectors` 已配置完整
- 高风险工具是否启用 `requireConfirmation`
- 如果使用 `openai`，`envApiKey` 或 `apiKey` 已正确提供
- 如果使用 `api` connector，`baseUrl`、鉴权和 tools 映射都已填写

建议上线前至少手工执行一次：

```bash
npm run cli -- --project <your-project.yaml> --input "列出当前可用工具"
```

## 3. 环境变量检查

建议基于 `.env.example` 准备 `.env`。

至少确认：

- `OPENAI_API_KEY`（如使用 OpenAI）
- `API_AUTH_ENABLED`
- `API_AUTH_TOKENS`

如果开启 HTTP API 鉴权：

- 至少准备 `viewer`、`operator`、`approver` 三类 token
- 不要把测试 token 直接带入客户环境
- 建议为不同环境使用不同 token 集合

## 4. 持久化与恢复检查

确认 SQLite 与审计文件目录可写。

默认路径：

- SQLite：`.agent-data/agent-bridge.sqlite`
- Audit：`.agent-data/audit.log`

上线前建议验证：

- 服务首次启动能自动创建目录与文件
- 重启服务后 session 仍可查询
- pending confirmation 重启后仍可恢复
- approve / reject / resume 链路正常

## 5. 最小权限检查

如果要进入内测，建议默认开启 API 鉴权：

```env
API_AUTH_ENABLED=true
```

至少确认：

- `viewer` 只能看，不能 run / approve
- `operator` 可以创建 session、run、resume
- `approver` 可以 approve / reject
- 高风险工具不会绕过 confirmation 直接执行

## 6. 审计与排障检查

确认以下内容可用：

- 控制台结构化 audit 输出可见
- `audit.log` 正常写入
- 出错时响应体包含 `error.code`
- 能通过 `requestId`、sessionId、confirmationId 回放关键问题

推荐重点看：

- `waiting_confirmation`
- `approve`
- `reject`
- `resume`
- `tool_execution_failed`

## 7. HTTP 服务检查

启动服务：

```bash
node dist/server-main.js --project <your-project.yaml>
```

至少验证这些接口：

- `GET /health`
- `POST /sessions`
- `POST /sessions/:id/run`
- `GET /sessions/:id/pending-confirmations`
- `POST /confirmations/:id/approve`
- `POST /sessions/:id/resume`

## 8. 推荐内测验收场景

建议至少走完下面 4 条：

1. **直接完成场景**
   - 创建 session
   - run 一次普通问题
   - 返回 `completed`

2. **审批中断场景**
   - run 一次高风险工具请求
   - 返回 `waiting_confirmation`
   - 能查到 pending confirmation

3. **批准恢复场景**
   - approve 指定 confirmation
   - 执行继续推进
   - 最终完成或再次进入下一次 confirmation

4. **跨重启恢复场景**
   - 制造一个 pending confirmation
   - 重启服务
   - 再查 pending confirmation
   - approve / resume 仍可工作

## 9. 回滚与止血建议

如果内测现场出现问题，优先按这个顺序处理：

1. 看 HTTP 状态码和 `error.code`
2. 查 `audit.log`
3. 查对应 session 的 `messages` / `state-summary` / `pending-confirmations`
4. 确认 project、env 和 token 是否和目标环境一致
5. 必要时回退到最小 project 配置先恢复可用性

## 10. 相关文档

- API 文档：`docs/api.md`
- 客户接入清单：`docs/customer-onboarding.md`
- 客户演示脚本：`docs/customer-demo-script.md`
- 错误码速查：`docs/error-codes.md`
