# OpenClaw + 企业微信客户联系部署说明

这套方案适合下面的目标：

- 企业微信客户联系 / 客户群事件回调进入本机
- OpenClaw 作为“数字员工大脑”分析客户动态
- 给内部销售成员推送跟进建议
- 通过客户群发接口定期触达客户群
- 使用 frp 暴露企业微信回调地址到公网

## 当前本机状态

- OpenClaw CLI 已安装
- OpenClaw Gateway 已启动，监听 `127.0.0.1:18789`
- hooks 已启用
- `sales` 代理已创建
- `qwen-portal-auth` 免费模型插件已启用

## 一、免费模型

推荐先用 Qwen OAuth 免费层。

文档依据：仓库里的 [docs/providers/qwen.md](docs/providers/qwen.md)。

为 `sales` 代理登录免费模型：

```bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm use v22

openclaw models auth login --agent sales --provider qwen-portal --set-default
```

说明：

- 这是设备码登录流程
- 免费额度大约是每天 2000 次请求
- 登录完成后，`sales` 代理就能直接跑企业微信事件分析

如果你后面想切换成真正零外部费用的本地模型，可以改用 Ollama。对应说明见 [docs/providers/ollama.md](docs/providers/ollama.md)。

## 二、企业微信桥接服务

桥接服务文件：

- [scripts/wecom-openclaw-bridge.mjs](scripts/wecom-openclaw-bridge.mjs)
- [scripts/wecom-openclaw-bridge.env.example](scripts/wecom-openclaw-bridge.env.example)

它提供这几类能力：

- 接收企业微信加密回调，验签并解密
- 把事件送给 OpenClaw `sales` 代理分析
- 把 AI 建议回发给企业微信内部成员
- 创建客户群发任务
- 透传任意企业微信 `cgi-bin` API
- 接收 OpenClaw cron webhook，并转成客户群发任务

先复制环境变量模板到 `.env`，再填值：

```bash
cp scripts/wecom-openclaw-bridge.env.example .env
```

至少需要填这些值：

- `WECOM_CORP_ID`
- `WECOM_AGENT_ID`
- `WECOM_SECRET`
- `WECOM_TOKEN`
- `WECOM_AES_KEY`
- `BRIDGE_ADMIN_TOKEN`

然后启动桥接服务：

```bash
pnpm wecom:bridge
```

健康检查：

```bash
curl http://127.0.0.1:8787/healthz
```

## 三、frp 暴露回调

示例配置文件：

- [scripts/frpc.wecom-openclaw.example.toml](scripts/frpc.wecom-openclaw.example.toml)

你要做的是：

1. 准备一台运行 `frps` 的公网机器
2. 把示例文件改成你自己的域名、端口、token
3. 在本机运行 `frpc`

示例：

```bash
frpc -c scripts/frpc.wecom-openclaw.example.toml
```

企业微信自建应用回调地址填成：

```text
https://wecom-callback.example.com/wecom/callback
```

企业微信回调验证会走 `GET` 请求，桥接服务已经实现了 URL 验证逻辑。

## 四、企业微信侧推荐配置

建议使用：

- 客户联系
- 客户群
- 自建应用回调
- 可调用应用里挂上当前自建应用 secret

推荐让这套桥接服务承担两种职责：

1. 实时事件处理

- 新客户添加
- 客户消息
- 客户群变更
- 客户/群标签变化

2. 营销动作执行

- 给内部销售推送跟进建议
- 创建企业群发任务
- 查询客户列表
- 透传企业微信 API 做高级操作

注意：

- 客户联系场景下，很多外发动作不是“直接自动发给客户”，而是“创建群发任务给成员确认”
- 这正适合把 OpenClaw 用作策略引擎，而把真正发送动作交给企业微信合规能力

## 五、桥接服务接口

### 1. 企业微信回调入口

```text
GET/POST /wecom/callback
```

### 2. 给企业微信内部成员发应用消息

```bash
curl -X POST http://127.0.0.1:8787/api/wecom/app-message \
  -H 'Authorization: Bearer REPLACE_ME' \
  -H 'Content-Type: application/json' \
  -d '{
    "touser": "zhangsan",
    "text": { "content": "OpenClaw 已启动" }
  }'
```

### 3. 创建客户群发任务

```bash
curl -X POST http://127.0.0.1:8787/api/wecom/group-message \
  -H 'Authorization: Bearer REPLACE_ME' \
  -H 'Content-Type: application/json' \
  -d '{
    "sender": "zhangsan",
    "chat_id_list": ["wrOgQhDgAAcwMTB7YmDkbeBsgT_AAAA"],
    "text": { "content": "各位客户朋友，今天给大家同步一条行业动态。" }
  }'
```

### 4. 查询某个成员的客户列表

```bash
curl -X POST http://127.0.0.1:8787/api/wecom/customers/list \
  -H 'Authorization: Bearer REPLACE_ME' \
  -H 'Content-Type: application/json' \
  -d '{ "userid": "zhangsan" }'
```

### 5. 透传任意企业微信 API

这个接口是为了覆盖更复杂的客户联系能力，比如客户群管理、客户继承、标签管理等：

```bash
curl -X POST http://127.0.0.1:8787/api/wecom/call \
  -H 'Authorization: Bearer REPLACE_ME' \
  -H 'Content-Type: application/json' \
  -d '{
    "path": "/cgi-bin/externalcontact/list",
    "method": "GET",
    "query": { "userid": "zhangsan" }
  }'
```

## 六、OpenClaw 定时客情维护

桥接服务已经实现了 OpenClaw cron webhook 落地到企业微信客户群发。

接口：

```text
POST /api/openclaw/cron-dispatch
```

推荐流程：

1. OpenClaw 定时生成今天要发给客户群的内容
2. cron 完成后把结果 POST 给桥接服务
3. 桥接服务调用企业微信 `externalcontact/add_msg_template`
4. 企业微信侧由成员确认群发并执行

建议的 cron 内容生成命令：

```bash
openclaw cron add \
  --name "Customer group nurture draft" \
  --cron "0 10 * * 2,4" \
  --session isolated \
  --agent sales \
  --message "请生成一段适合 B2B 客户群的维护消息。要求：120 字以内，专业、克制、带一个轻 CTA，不要过度营销。只输出最终文案。" \
  --no-deliver
```

如果你希望 cron 完成后自动把结果推给桥接服务，不要在 CLI 里找 `--webhook` 参数。当前版本请按 [docs/automation/cron-jobs.md](docs/automation/cron-jobs.md) 里的 `delivery.mode = "webhook"` 方式，在 Control UI 或 RPC 层把 `delivery.to` 配成：

```text
http://127.0.0.1:8787/api/openclaw/cron-dispatch?sender=zhangsan&chatIds=wrOgQhDgAAcwMTB7YmDkbeBsgT_AAAA
```

## 七、推荐运营编排

建议先做三条自动化：

1. 新客户进入

- 企业微信回调到桥接服务
- OpenClaw 判断客户来源、意图、优先级
- 自动给销售成员推送“首触达建议”

2. 客户群维护

- 每周 2 次 cron 生成群内容
- 桥接服务创建企业群发任务
- 由成员确认执行

3. 沉默客户唤醒

- 每周拉取成员客户列表
- 结合你的 CRM 标记沉默客户
- OpenClaw 输出“唤醒话术 + 是否建议拉群/转人工”

## 八、落地顺序

建议你按这个顺序执行：

1. 登录 `sales` 代理的 Qwen 免费模型
2. 配好 `.env` 并启动桥接服务
3. 用 frp 把 `8787` 暴露出去
4. 在企业微信后台配置回调 URL、Token、EncodingAESKey
5. 先测回调验签
6. 再测内部消息通知
7. 最后接客户群发 cron
