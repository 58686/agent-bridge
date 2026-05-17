# 客户接入最小清单

这份清单面向**第一次接入 agent-bridge 的客户或内测同事**，目标是在最短时间内完成一次可运行、可联调、可排错的最小接入。

## 1. 最小准备项

开始前请确认：

- 已安装 Node.js 18+
- 已拿到项目代码
- 已准备一个可用模型配置：
  - 本地联调可先用 `custom / mock-model`
  - 真实模型联调可用 `openai`
- 如果要调用公司内部 API，已拿到：
  - `baseUrl`
  - 鉴权方式（`bearer` / `apiKey`）
  - 至少 1 个可用接口

## 2. 安装与构建

```bash
cd /d/data/spectrai-data/agent-bridge
npm install
npm run build
```

## 3. 准备环境变量

复制：

```bash
cp .env.example .env
```

然后按需填写。

### 3.1 使用 OpenAI 模型时至少要配

```env
OPENAI_API_KEY=your_openai_api_key_here
```

### 3.2 开启 HTTP API 鉴权时至少要配

```env
API_AUTH_ENABLED=true
API_AUTH_TOKENS=viewer-token:viewer-1:viewer,operator-token:operator-1:operator,approver-token:approver-1:approver
```

说明：

- `viewer`：只读接口
- `operator`：可创建 session、执行 run/resume/clear-history
- `approver`：可执行 approve/reject
- `admin`：全权限

## 4. 选择一个最小 project 配置

### 方案 A：先跑最小演示配置

文件：

- `projects/example/project.yaml`

适合：

- 验证 CLI / API 服务是否能启动
- 验证 session 基本链路
- 不依赖真实外部服务

### 方案 B：对接公司 REST API

文件：

- `projects/example/company-api.yaml`

你至少要替换：

- `connectors[0].config.baseUrl`
- `connectors[0].config.auth`
- `connectors[0].config.tools`

## 5. 首次联调推荐顺序

### 步骤 1：先验证 CLI 能跑通

```bash
npm run cli -- --project projects/example/project.yaml --input "列出当前可用工具"
```

如果这里失败，优先排查：

- Node 版本
- 依赖安装
- project 文件路径
- model provider 配置

### 步骤 2：启动 HTTP API

```bash
npm run serve
```

或：

```bash
node dist/server-main.js
```

### 步骤 3：先测健康检查

```bash
curl http://127.0.0.1:3000/health
```

### 步骤 4：如果开启鉴权，再测带 token 的请求

```bash
curl -H "Authorization: Bearer operator-token" \
  -H "Content-Type: application/json" \
  -X POST http://127.0.0.1:3000/sessions
```

### 步骤 5：再测一次 run

```bash
curl -H "Authorization: Bearer operator-token" \
  -H "Content-Type: application/json" \
  -X POST http://127.0.0.1:3000/sessions/<sessionId>/run \
  -d '{"input":"请列出当前可用工具"}'
```

## 6. 客户最常见错误与排查方式

### `PROJECT_CONFIG_UNSUPPORTED_FILE`
说明：传入的 project 文件不是 YAML / JSON。

优先检查：

- 文件扩展名是否为 `.yaml` / `.yml` / `.json`
- 启动命令里的 `--project` 是否指向了错误文件

### `UNSUPPORTED_MODEL_PROVIDER`
说明：`model.provider` 当前不受支持。

优先检查：

- 是否写成了错误 provider 名称
- 当前项目是否只应使用 `custom` 或 `openai`

### `OPENAI_API_KEY_MISSING`
说明：OpenAI key 未配置成功。

优先检查：

- `.env` 是否存在
- `OPENAI_API_KEY` 是否填写
- `model.envApiKey` 指向的变量名是否正确

### `API_CONNECTOR_BASE_URL_MISSING`
说明：API connector 缺少 `config.baseUrl`。

优先检查：

- connector 配置层级是否正确
- `baseUrl` 是否被写到了错误位置

### `API_CONNECTOR_TOOLS_MISSING`
说明：API connector 没有配置任何 tool。

优先检查：

- `config.tools` 是否存在
- tools 数组里是否至少有一个可用接口映射

### `API_AUTH_TOKENS_MISSING`
说明：开启了鉴权，但没有配置 token。

优先检查：

- `API_AUTH_ENABLED=true` 时是否同时提供了 `API_AUTH_TOKENS`

### `CONFIRMATION_NOT_FOUND`
说明：调用 approve/reject 时，请求的 confirmation 已不存在或 requestId 错误。

优先检查：

- requestId 是否来自当前最新一次 `waiting_confirmation`
- confirmation 是否已经被其他调用消费

### `SESSION_LAST_INPUT_MISSING`
说明：调用 `resume` 时 session 没有可恢复的最后输入。

优先检查：

- 该 session 是否真的跑过 `run`
- 是否先清空了历史

## 7. 推荐交付姿势

如果客户很急，建议分两阶段：

### 第一阶段：先交付“可运行最小版”

目标：

- 能启动
- 能 run
- 能看到工具调用
- 能完成最小审批流

建议：

- 优先使用最少的 tools
- 先用 mock-model 或稳定的 OpenAI 配置
- 先接一个读接口，再接写接口

### 第二阶段：再扩到真实业务流

目标：

- 接更多工具
- 打通审批系统
- 接审计/网关/前端

## 8. 相关文档

- API 详细说明：`docs/api.md`
- 客户首轮演示脚本：`docs/customer-demo-script.md`
- 内测上线检查表：`docs/deployment-checklist.md`
- 错误码速查表：`docs/error-codes.md`
- 示例 project：`projects/example/project.yaml`
- 示例 API connector：`projects/example/company-api.yaml`
- OpenAI + API 最小交付示例：`projects/example/customer-openai-api.yaml`
