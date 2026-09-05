# parse_worker JSON-RPC 协议规范

> 本文件定义 NestJS 网关与 Python parse_worker 之间的通信契约。
> Phase 2 实现的权威依据,任何一方变更需同步更新本文件。
>
> 关联:
> - [`PARSER_SPEC.md`](../parser/PARSER_SPEC.md) — parser.py 行为契约(只读基石)
> - [`record.schema.json`](record.schema.json) — `parse_image` 输出 record 的数据契约

## 1. 设计目标

- **传输层**:stdin/stdout,长驻进程,NestJS 通过 `child_process.spawn` 启动
- **消息层**:JSON-RPC 2.0(单行 JSON,换行分隔)
- **二进制层**:缩略图等字节流通过 length-prefixed 帧在同 stdout 传输,避免污染 JSON 流
- **复用性**:协议框架与 Phase 3 generate_worker 共享,仅方法清单不同
- **崩溃安全**:worker 任何异常都不能让 NestJS 卡死

## 2. 传输层

### 2.1 进程模型

```text
NestJS (parent)
   │
   │  child_process.spawn('python', ['-m', 'workflow_db.workflow_db.parse_worker'])
   │
   ▼
parse_worker (child)
   ├── stdin  : NestJS → worker  (JSON-RPC requests, line-delimited)
   ├── stdout : worker → NestJS  (JSON-RPC responses + binary frames, line-delimited)
   └── stderr : worker → NestJS  (structured logs, line-delimited JSON)
```

### 2.2 消息帧格式

所有 stdout 输出按行分隔(每行一条消息)。每行第一个字段标识类型:

| `type` | 含义 | 载荷 |
|---|---|---|
| `rpc` | JSON-RPC 2.0 响应 | 标准 JSON-RPC response object |
| `binary` | 二进制帧(缩略图) | `{ "type": "binary", "frame_id": "<id>", "length": <n>, "mime": "image/webp" }` 紧跟下一行是 `<length>` 字节的原始数据(不含换行) |
| `log` | 结构化日志 | `{ "type": "log", "level": "info", "msg": "...", "ts": "..." }` |
| `ready` | worker 就绪信号 | `{ "type": "ready", "version": "1.0", "methods": [...] }` |

### 2.3 二进制帧的精确传输规则

**关键设计**:`make_thumb` 返回字节,不能用 JSON 编码(base64 会膨胀 33% 且消耗大量 token)。

帧结构:

```text
Line N:   {"type":"binary","frame_id":"<id>","length":12345,"mime":"image/webp"}
Line N+1: <12345 bytes of raw binary, NOT followed by newline>
Line N+2: <newline separator>
Line N+3: <next message or empty>
```

**实现要点**:

- 二进制内容**可能包含字节 0x0A(换行)**,因此 NestJS 侧必须**按 `length` 字段读取**,不能按行读取
- 写入顺序:JSON 行 → 换行 → 二进制(精确 length 字节)→ 换行
- 读取顺序:解析 JSON 行 → 取 `length` → 精确读取 length 字节 → 读取并丢弃一个换行
- `frame_id` 用于关联对应的 `make_thumb` 请求(在响应 JSON 中引用)

## 3. JSON-RPC 2.0 消息格式

### 3.1 Request(NestJS → worker)

```json
{"jsonrpc":"2.0","id":"<string>","method":"<method_name>","params":{...}}
```

- `id`:字符串,唯一标识本次调用,用于关联响应
- `method`:见 §4 方法清单
- `params`:方法特定参数

### 3.2 Response — Success

```json
{"jsonrpc":"2.0","id":"<string>","result":{...}}
```

`result` 结构因方法而异,见 §4。

Record 中偶尔会包含 PIL 读取出的 EXIF/XMP 二进制 metadata。此类
`bytes` / `bytearray` / `memoryview` 值在 JSON 响应中编码为：

```json
{
  "__type__": "bytes",
  "encoding": "base64",
  "length": 190,
  "data": "RXhpZgAASUkqA..."
}
```

`length` 是编码前字节数，`data` 可无损 Base64 解码。此规则只适用于 Record 内嵌
metadata；`make_thumb` 图片载荷仍使用 §2.3 的 length-prefixed 二进制帧。

### 3.3 Response — Error

```json
{"jsonrpc":"2.0","id":"<string>","error":{"code":<int>,"message":"<string>","data":{...}}}
```

### 3.4 错误码

| code | 含义 |
|---|---|
| `-32700` | Parse error(JSON 解析失败) |
| `-32600` | Invalid Request |
| `-32601` | Method not found |
| `-32602` | Invalid params |
| `-32603` | Internal error(未分类异常) |
| `-32000` | Image open failed(PARSER_SPEC §15.2 `ValueError`) |
| `-32001` | Image not found(路径不存在) |
| `-32002` | Thumbnail generation failed |
| `-32003` | Worker overloaded(并发上限) |

## 4. 方法清单

### 4.1 `parse_image`

**用途**:解析单张图片,返回完整 record dict。

**Params**:

```json
{
  "path": "<absolute or relative path string>",
  "scan_root": "<optional absolute path string>"
}
```

**Result**:

```json
{
  "record": <符合 record.schema.json 的 record 对象>,
  "warnings": ["<optional warning strings>"]
}
```

**行为契约**:

- 等价于直接调用 `parser.parse_image(Path(path), Path(scan_root) if scan_root else None)`
- 输出必须符合 [`record.schema.json`](record.schema.json)
- 行为细节参照 [`PARSER_SPEC.md`](../parser/PARSER_SPEC.md) §4
- 不允许触碰 Mongo(纯解析)

**错误码**:

- `-32000`:Image open failed(`parser.extract_image_metadata` 抛出 `ValueError`)
- `-32001`:`path` 不存在或不可读
- `-32602`:`path` 参数缺失或非字符串

### 4.2 `make_thumb`

**用途**:生成缩略图字节。

**Params**:

```json
{
  "resolved_path": "<absolute path string>",
  "w": <int, 64..1024>,
  "h": <int, 64..1024>
}
```

**Result**(响应 JSON):

```json
{
  "frame_id": "<string>",
  "length": <int>,
  "mime": "image/webp"
}
```

**紧接着**:二进制帧(见 §2.3)。

**行为契约**:

必须**严格复刻**历史 FastAPI `get_thumbnail` 行为(与上级兼容):

1. `PIL.Image.open(resolved_path)`
2. `ImageOps.exif_transpose(image)` — EXIF 方向矫正
3. `image.thumbnail((w, h), Image.Resampling.LANCZOS)` — LANCZOS 重采样
4. 模式规范化:`image.mode` 不在 `{"RGB", "RGBA"}` 时,转换为 `"RGBA"`(若含 alpha 通道)或 `"RGB"`
5. 保存为 WEBP:`format="WEBP"`, `quality=82`, `method=4`
6. 返回字节

**禁止项**:

- 不得修改任何参数(quality、method、resampling filter)
- 不得添加水印或元数据
- 不得调用 Mongo(无缓存层,缓存由 NestJS 侧管理)

**错误码**:

- `-32002`:Thumbnail generation failed(任何 PIL 异常)
- `-32001`:`resolved_path` 不存在
- `-32602`:参数校验失败(w/h 越界)

### 4.3 `ping`(健康检查)

**Params**:无(空对象 `{}`)

**Result**:

```json
{
  "pong": true,
  "version": "1.0",
  "uptime_sec": <float>
}
```

**用途**:NestJS supervisor 用于预热确认与心跳检测。

### 4.4 `enrich_record`

**用途**:对已有 Record 构建仅用于展示的补全视图。该方法不会修改输入
Record,也不参与扫描入库、`batch_key`、`recipe_key` 或统计索引。

**Params**:

```json
{
  "record": <符合 record.schema.json 的 record 对象>,
  "raw_prompt": <optional API prompt object or JSON string>,
  "raw_workflow": <optional UI workflow object or JSON string>
}
```

未显式传入 `raw_prompt` / `raw_workflow` 时,从 `record.metadata` 读取。

**Result**:

```json
{
  "effective_record": <深拷贝后的展示 Record>,
  "provenance": {"<field path>": {"provider": "<name>", "confidence": 0.0}},
  "diagnostics": {
    "outcome": "enriched|unchanged|conflict_preserved|unavailable",
    "coverage_before": {},
    "coverage_after": {},
    "unknown_nodes": [],
    "conflicts": [],
    "warnings": []
  }
}
```

字段白名单、合并规则与第三方 adapter 契约见
[`ENRICHMENT.md`](../parser/ENRICHMENT.md)。`diagnostics` 与 `provenance` 不属于
Record schema,不得写入 Mongo Record。

**错误码**:

- `-32602`:`record` 缺失或不是对象

### 4.5 `suggest_tags`

**用途**:Danbooru tag 补全参考的组推荐(可选功能)。把一个 batch 的 prompt
tag 组作为**多输入**提交,基于 GNN 嵌入(`embed_gnn.npy`)做均值查询 + 组一致性
打分,返回单 tag 推荐与二元组推荐。由网关在扫描入库时调用(预计算落
`batch_tag_suggestions` 表),不参与解析主链路。

**Params**:

```json
{
  "prompts": ["<positive prompt 文本>", "..."],
  "batch_key": "<optional 批次键,仅溯源用>",
  "top_k": 10
}
```

worker 内部从 `prompts` 文本经**分词器**拆 tag(共享 `workflow_db.tag_suggest.split_tags`):
剥 A1111 `<lora:x:1>` 引用块 → 按逗号/换行切段 → 段级剥壳候选链(权重
`(x:1.2)`/强调 `{{x}}`/降权 `[x]`,词表验证优先,消歧括号 `(fate)` 保留)
→ 未命中时词表贪心最长匹配(空格连接的多 tag,如 `blonde hair blue eyes`);
GNN 资产缺失时降级为语法清洗(不拆括号、不贪心)。
命中词表(`vocab_sorted.npy`)的 tag <2 个时返回空结果(防噪)。

**Result**:

```json
{
  "enabled": true,
  "sources": ["<命中的输入 tag>", "..."],
  "tags": [{"name": "<tag>", "score": 0.68}, "..."],
  "groups": [{"tags": ["<tagA>", "<tagB>"], "score": 1.1}, "..."]
}
```

**降级**:GNN 资产缺失(`DANBOORU_ASSETS` 未配置/文件不存在)或 numpy 不可用
时返回 `{"enabled": false}` —— 调用方(网关 ingest 挂钩)据此跳过预计算,
不阻断扫描入库。

**错误码**:

- `-32602`:`prompts` 缺失或不是数组

## 5. Worker 启动握手

### 5.1 启动序列

```text
1. NestJS spawn worker
2. worker 加载 parser.py 等依赖
3. worker 输出 ready 消息到 stdout:
   {"type":"ready","version":"1.0","methods":["enrich_record","make_thumb","parse_image","ping","suggest_tags"]}
4. NestJS 收到 ready 后,标记 worker 可用,开始派发请求
5. 在 ready 之前派发的请求由 NestJS 排队(不写入 stdin)
```

### 5.2 超时

- worker 启动超时:**10 秒**(NestJS 侧配置项 `WORKER_SPAWN_TIMEOUT_MS`)
- 超时后 NestJS 杀进程并重启(最多 3 次,3 次失败则 worker 进入 `failed` 状态,NestJS 返回 503)

## 6. 并发与生命周期

### 6.1 单 worker 串行

**Phase 2 简化模型**:worker 内部串行处理请求,不引入 asyncio 或线程池。

理由:
- parser.py 是纯函数,无共享状态
- PIL 操作释放 GIL 后并发收益有限
- 串行模型避免并发 bug,降低 Phase 2 复杂度

如未来需要并发,通过 NestJS 启动多个 worker 实现(协议不变)。

### 6.2 请求超时

- `parse_image`:**30 秒**(单图解析)
- `enrich_record`:**10 秒**(纯内存展示补全)
- `suggest_tags`:**30 秒**(GNN 组推荐;资产冷加载 ~0.5s,热查询 ~20ms)
- `make_thumb`:**10 秒**(缩略图生成)
- `ping`:**2 秒**

超时后 NestJS 杀 worker 重启,当前 inflight 请求返回 500。

### 6.3 空闲回收

- worker 空闲 **5 分钟** 后,NestJS 发送 `shutdown` 通知(可选,Phase 2 可不实现)
- 收到 `shutdown` 后 worker 优雅退出(完成 inflight 请求后退出 0)

### 6.4 崩溃恢复

- worker 进程异常退出(非 0 退出码)
- NestJS 自动重启
- 重启期间的 inflight 请求返回 500(不重试,避免双写)
- 重启后需重新走 §5.1 握手

## 7. 日志协议

worker 写入 stderr 的每行必须是 JSON:

```json
{"type":"log","level":"info|warn|error","msg":"<string>","ts":"<ISO8601>","method":"<optional>","request_id":"<optional>"}
```

NestJS 侧负责收集并转发到日志系统。

> 注:`ts` 字段当前由 NestJS 侧在收到日志行时补打时间戳——
> `protocol.py` 的 `write_log()` 只显式发出 `type` / `level` / `msg`
> (及调用方附带的 `method` / `request_id` 等),并未在 worker 内设置 `ts`。
> 消费方不应依赖 worker 自带 `ts`,缺省时按"收到时刻"处理即可。

## 8. 版本与扩展

### 8.1 协议版本

当前版本:**1.0**

`ready` 消息中的 `version` 字段标识 worker 支持的协议版本。NestJS 侧校验版本,不匹配则不使用该 worker。

### 8.2 扩展点(Phase 3+)

- Phase 3 `generate_worker` 复用本协议框架,仅方法清单不同
- 未来可增加 `parse_workflow_only`(只解析 prompt 不解析图片)
- 协议版本递增规则:向后兼容的小修改用 `1.x`,破坏性修改用 `2.0`

## 9. 测试与验收

### 9.1 协议层单测(Python 侧)

- `test_protocol_frame.py`:验证二进制帧的 length-prefix 正确性
- `test_methods.py`:每个方法用 fixture 数据验证输出
- `test_handshake.py`:验证 ready 消息格式

### 9.2 协议层单测(NestJS 侧)

- `parse-worker.spec.ts`:mock worker 进程,验证 supervisor 行为
- `parse-worker.crash.spec.ts`:杀进程验证自愈

### 9.3 端到端验收

- fixtures 调 `parse_image`,与旧 FastAPI `/api/images` 输出 byte-equal(时间字段除外;fixtures 在开发仓库)
- fixtures 调 `make_thumb`,与旧 FastAPI `/api/thumb/{sha256}` 输出 byte-equal(同上)
- worker crash 测试:kill -9 后 NestJS 自动重启,inflight 请求返回 500

## 10. 不在本协议范围

- **Mongo 写入**:parse_worker 不碰 Mongo,所有写库由 NestJS 完成
- **缓存层**:缩略图缓存由 NestJS 侧管理,worker 每次都重新生成
- **批量解析**:Phase 2 不支持批量,每个 `parse_image` 调用处理一张图
- **进度回调**:Phase 2 不支持流式进度,单次请求单次响应
- **认证**:worker 与 NestJS 同机通信,无认证需求
