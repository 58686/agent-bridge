# 错误码速查表

这份文档用于帮助接入方、交付同事和客户快速定位常见错误。

## 1. HTTP / Auth 相关

| 错误码 | 场景 | 说明 | 优先检查 |
| --- | --- | --- | --- |
| `AUTH_REQUIRED` | 缺少认证头或未认证访问受保护接口 | 当前请求需要认证 | 是否携带 `Authorization: Bearer <token>` |
| `AUTH_SCHEME_INVALID` | 认证头格式错误 | 目前仅支持 Bearer | 是否写成了非 `Bearer` 方案 |
| `AUTH_TOKEN_EMPTY` | Bearer token 为空 | 头存在但 token 为空 | `Authorization` 头是否完整 |
| `AUTH_TOKEN_INVALID` | token 无效 | token 不在允许列表中 | `API_AUTH_TOKENS` 是否正确配置 |
| `AUTH_FORBIDDEN` | 角色不足 | 当前 token 没有足够权限 | 是否用了正确角色的 token |
| `API_AUTH_TOKENS_MISSING` | 开启鉴权但未配置 token | 启动期配置错误 | `API_AUTH_ENABLED=true` 时是否提供了 `API_AUTH_TOKENS` |
| `API_AUTH_TOKENS_INVALID` | token 列表为空或无有效 token | 启动期配置错误 | `API_AUTH_TOKENS` 格式是否正确 |
| `API_AUTH_TOKEN_SPEC_INVALID` | 单个 token 规格不合法 | 必须是 `token:actorId:role` | token 字段是否缺失 |
| `API_AUTH_ROLE_INVALID` | role 无效 | role 只能是 `viewer` / `operator` / `approver` / `admin` | role 拼写是否正确 |

## 2. Project / Model 启动期错误

| 错误码 | 场景 | 说明 | 优先检查 |
| --- | --- | --- | --- |
| `PROJECT_CONFIG_UNSUPPORTED_FILE` | project 文件扩展名不支持 | 当前仅支持 `.yaml` / `.yml` / `.json` | `--project` 指向的文件是否正确 |
| `PROJECT_CONFIG_NOT_FOUND` | project 文件不存在 | 启动自检无法找到项目配置 | `--project` 路径是否正确 |
| `PROJECT_CONFIG_ENV_VAR_MISSING` | project 配置引用了未设置的环境变量 | `${ENV_VAR}` 插值失败，启动会中止 | `.env`、部署环境变量或 secret 注入是否完整 |
| `PROJECT_CONFIG_INVALID` | project 配置结构或安全策略不合法 | 启动期校验失败，响应 metadata.issues 会列出具体路径 | connector/tool 是否重复，API tool 字段是否完整，写接口是否开启 confirmation |
| `SERVER_PORT_INVALID` | 服务端口参数非法 | `--port` 不是 1-65535 的整数 | 启动命令里的端口值 |
| `SERVER_ARG_UNKNOWN` | 服务启动参数未知 | 命令行传入了不支持的参数 | 启动脚本和参数拼写 |
| `UNSUPPORTED_MODEL_PROVIDER` | 模型 provider 不支持 | 当前主要支持 `custom` / `openai` | `model.provider` 是否填错 |
| `OPENAI_API_KEY_MISSING` | OpenAI key 缺失 | 无法初始化 OpenAI 调用 | `.env`、`OPENAI_API_KEY`、`envApiKey` 是否正确 |
| `OPENAI_REQUEST_FAILED` | OpenAI 上游返回非 2xx | 上游请求失败 | key、baseUrl、模型名、网络连通性 |
| `OPENAI_RESPONSE_INVALID_JSON` | OpenAI 返回体不是合法 JSON | 上游响应异常 | 上游网关是否兼容 OpenAI 协议 |
| `OPENAI_RESPONSE_EMPTY_CHOICES` | OpenAI 返回没有 choices | 上游响应结构异常 | 模型响应格式是否正常 |

## 3. API Connector 相关

| 错误码 | 场景 | 说明 | 优先检查 |
| --- | --- | --- | --- |
| `API_CONNECTOR_BASE_URL_MISSING` | API connector 缺少 `config.baseUrl` | connector 配置不完整 | `connectors[].config.baseUrl` |
| `API_CONNECTOR_TOOLS_MISSING` | API connector 没有 tools | connector 配置不完整 | `connectors[].config.tools` 是否至少有 1 个接口 |
| `API_CONNECTOR_NOT_INITIALIZED` | connector 未初始化就执行 | 运行顺序异常或初始化失败 | connector 是否正常 initialize |

## 4. Session / Confirmation / Run 相关

| 错误码 | 场景 | 说明 | 优先检查 |
| --- | --- | --- | --- |
| `SESSION_NOT_FOUND` | 查询或操作不存在的 session | session 不存在 | sessionId 是否正确 |
| `SESSION_LAST_INPUT_MISSING` | 调用 resume 时缺少 lastInput | session 没有可恢复输入 | 是否先跑过 `run`，是否清空过历史 |
| `CONFIRMATION_NOT_FOUND` | approve/reject 的 confirmation 不存在 | requestId 已失效或错误 | confirmationId 是否来自最新待确认项 |
| `AGENT_ALREADY_RUNNING` | 同一 agent 重复运行 | 会话仍在执行中 | 是否对同一 session 并发 run/resume |

## 5. 通用 HTTP 层错误

| 错误码 | 场景 | 说明 | 优先检查 |
| --- | --- | --- | --- |
| `NOT_FOUND` | 路由不存在 | URL 路径错误 | 请求路径和方法是否正确 |
| `QUERY_SERVICE_NOT_CONFIGURED` | 查询服务未启用 | 当前实例未配置查询能力 | 持久化与 query service 是否正常装配 |
| `INTERNAL_ERROR` | 未分类内部错误 | 未被结构化收口的异常 | 结合日志、requestId、审计事件继续排查 |

## 6. `retryable` 字段

HTTP API 的结构化错误会包含 `error.retryable`：

- `true`：调用方可以在退避后重试，例如 `AGENT_ALREADY_RUNNING`、`OPENAI_REQUEST_FAILED`、`408`、`429` 或 `5xx` 错误
- `false`：重试通常无意义，需要修正参数、权限、sessionId、confirmationId 或配置

建议前端和网关优先用 `error.code` 做分支，再结合 `error.retryable` 决定是否自动重试。

## 7. 推荐排查顺序

如果客户现场报错，建议按下面顺序排查：

1. 先看 HTTP 状态码
2. 再看 `error.code`
3. 再看 `error.message`
4. 再结合 `requestId` 查日志或审计事件
5. 如果是 confirmation / tool execution 问题，再结合 `docs/api.md` 看状态流转

## 8. 推荐和客户同步的最短表述

可以直接这样说：

- 如果是配置问题，通常会返回明确错误码
- 如果是权限问题，先看 token 和 role
- 如果是审批问题，先看 confirmationId 是否还有效
- 如果是模型问题，先看 OpenAI key、baseUrl 和 provider
