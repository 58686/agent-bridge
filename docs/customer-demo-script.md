# 客户首轮演示脚本

这份文档用于**最快演示 agent-bridge 已经可用**。默认假设你在仓库根目录：

```bash
cd /d/data/spectrai-data/agent-bridge
```

## 演示路径 A：本地最小演示（不依赖真实外部 API）

适合：

- 客户第一次看产品
- 验证 CLI / API 主链路
- 快速证明 session 能工作

### 1. 安装并构建

```bash
npm install
npm run build
```

### 2. 用最小 project 跑 CLI

```bash
npm run cli -- --project projects/example/project.yaml --input "列出当前可用工具，并介绍你自己"
```

预期结果：

- 命令成功执行
- 输出项目介绍
- 输出 tool call 结果或可用工具说明

### 3. 启动 API 服务

```bash
npm run serve -- --project projects/example/project.yaml
```

如果你的 npm 参数透传在环境里不稳定，也可以直接用：

```bash
node dist/server-main.js --project projects/example/project.yaml
```

### 4. 健康检查

```bash
curl http://127.0.0.1:3000/health
```

### 5. 创建 session

```bash
curl -X POST http://127.0.0.1:3000/sessions
```

预期响应示例：

```json
{
  "sessionId": "..."
}
```

### 6. 运行一次 session

把 `<sessionId>` 替换成上一步返回值：

```bash
curl -H "Content-Type: application/json" \
  -X POST http://127.0.0.1:3000/sessions/<sessionId>/run \
  -d '{"input":"请介绍当前 Agent 的能力，并列出可用工具"}'
```

预期结果：

- 返回 `completed`
- 返回 `result.response`
- 如有工具调用，会返回 `toolCalls`

---

## 演示路径 B：OpenAI + API Connector

适合：

- 客户需要看真实模型接法
- 客户需要看 API 工具接入方式
- 需要演示 confirmation 流

### 1. 准备环境变量

复制模板：

```bash
cp .env.example .env
```

至少填写：

```env
OPENAI_API_KEY=your_openai_api_key_here
API_AUTH_ENABLED=true
API_AUTH_TOKENS=viewer-token:viewer-1:viewer,operator-token:operator-1:operator,approver-token:approver-1:approver
```

### 2. 准备 project 配置

基于：

- `projects/example/customer-openai-api.yaml`

你至少需要替换：

- `baseUrl`
- `auth.token` 或 `auth.apiKey`
- tools 映射

### 3. 启动 API 服务

```bash
node dist/server-main.js --project projects/example/customer-openai-api.yaml
```

### 4. 创建 session

```bash
curl -H "Authorization: Bearer operator-token" \
  -X POST http://127.0.0.1:3000/sessions
```

### 5. 提交一次可能触发高风险工具的 run

```bash
curl -H "Authorization: Bearer operator-token" \
  -H "Content-Type: application/json" \
  -X POST http://127.0.0.1:3000/sessions/<sessionId>/run \
  -d '{"input":"请为 TICKET-001 创建一条评论，内容是：客户已确认修复窗口"}'
```

可能出现两种结果：

#### 情况 1：直接完成

返回：

- `status: completed`

#### 情况 2：进入审批流

返回：

- `status: waiting_confirmation`
- `result.pendingConfirmation.id`

### 6. 如果进入审批流，先查看待确认项

```bash
curl -H "Authorization: Bearer viewer-token" \
  http://127.0.0.1:3000/sessions/<sessionId>/pending-confirmations
```

### 7. 执行 approve

把 `<confirmationId>` 替换成上一步返回值：

```bash
curl -H "Authorization: Bearer approver-token" \
  -H "Content-Type: application/json" \
  -X POST http://127.0.0.1:3000/confirmations/<confirmationId>/approve \
  -d '{"reason":"approved during customer demo"}'
```

预期结果：

- 返回 `completed` 或新一轮 `waiting_confirmation`
- 可以演示审批与恢复执行闭环

---

## 演示时建议重点强调的点

### 1. 不是只能聊天
要强调这是：

- 可接任意公司系统的 Agent runtime
- 不是单纯 prompt demo

### 2. 工具调用是有边界的
可以强调：

- 高风险工具支持确认门控
- 审批后可以继续执行
- 审计能区分 waiting / failed

### 3. 错误定位更快
可以强调：

- 启动期常见错误已结构化
- API 层错误已结构化
- 客户接入时更容易排查

---

## 演示失败时最先检查什么

### 服务起不来
优先检查：

- `npm run build` 是否通过
- project 路径是否正确
- `.env` 是否存在
- OpenAI key 是否正确

### run 失败
优先检查：

- `model.provider`
- API connector 的 `baseUrl`
- API connector 的鉴权 token
- tool 参数映射是否正确

### approve 失败
优先检查：

- 是否使用了 `approver` 角色 token
- confirmationId 是否来自最新一次 `waiting_confirmation`
- 该 confirmation 是否已被消费

---

## 建议的客户演示顺序

建议按这个顺序：

1. 先跑 CLI 最小演示
2. 再跑 API 健康检查
3. 再创建 session 并 run
4. 最后演示 confirmation → approve → 完成

这样成功率最高，也最容易讲清楚产品价值。
