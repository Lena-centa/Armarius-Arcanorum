# Remote Image Library v1

WorkflowDB 可以只从 MongoDB 读取图片元数据，而把图片字节保存在独立 HTTP
服务中。本协议用于“当前网关没有本地图片、图片也不由另一台 WorkflowDB 网关
托管”的场景。
远端条目会正常参与列表、搜索、recipe 聚合和统计缓存重建。

## 1. MongoDB 条目

远程图片仍放在现有批次文档的 `images[]` 中，但不要求
`file.resolved_path`。最小条目如下：

```json
{
  "file": {
    "filename": "a.png",
    "sha256": "a-stable-public-lookup-key"
  },
  "source": {
    "instance_id": "library-a",
    "base_url": "https://images.example.com",
    "protocol": "wfdb-image-library-v1",
    "asset_id": "album/a.png"
  }
}
```

可直接使用以下文件构建和校验数据：

- JSON Schema：[`remote-image-library-v1.schema.json`](contracts/remote-image-library-v1.schema.json)
- 完整 Mongo 批次示例：[`remote-image-library-v1.example.json`](contracts/remote-image-library-v1.example.json)

字段约束：

- `file.sha256` 是 WorkflowDB 的公开查找键，必须在图片集合中稳定。新建图片库
  推荐填真实文件内容 SHA-256；为兼容历史数据，不强制它必须是 64 位十六进制。
- `source.asset_id` 由图片库自行定义，是不透明标识；网关会把它编码成单个 URL
  path segment，因此可以包含 `/`、空格等字符。
- `source.base_url` 必须是可由 WorkflowDB 网关访问的 HTTP(S) origin。
  出于安全原因，其路径和 query 会被丢弃，例如
  `https://host/catalog` 最终只使用 `https://host`。
- 默认只代理 DNS 全部解析为公网单播地址的主机；环回、私网、链路本地、云元数据
  地址和混合公网/私网 DNS 结果均拒绝。局域网内的可信图片库或对端网关必须由
  管理员在 `WORKFLOW_DB_PROXY_ALLOW_HOSTS` 中列出精确主机/IP（可带端口，逗号
  分隔，不支持通配符）。数据库记录本身不能扩大这份白名单。
- 不要在 MongoDB 中保存临时签名 URL。签名、对象存储映射及权限逻辑应由图片库
  在收到 `asset_id` 后处理。

专用 Schema 校验的是单个 `images[]` entry。若由外部导入器直接写入
MongoDB,还需按完整示例组装 batch 文档并填写 `batch_key` / `recipe_key`;
写入后应调用 WorkflowDB 的 ingest/archive 链路或重建 recipe/stats 投影,
而不应只向 `images` collection 插入裸文档。

## 2. 图片库必须实现的 HTTP API

### 原图

```http
GET /v1/assets/{asset_id}
```

成功时返回 `2xx`、图片二进制和正确的 `Content-Type`。建议返回
`Cache-Control`；WorkflowDB 会将二者透传给浏览器。

### 缩略图

```http
GET /v1/assets/{asset_id}/thumbnail?w=360&h=360
```

`w`、`h` 可省略；传入时范围为 `64..1024`。服务可以即时生成，也可以从缓存
返回，响应不限定必须是 WebP，但必须使用正确的图片 `Content-Type`。

WorkflowDB 可能附带 `x-wfdb-passthrough: 1`。独立图片库可以忽略该请求头；
它主要用于阻止 WorkflowDB 网关之间形成循环代理。

非 `2xx`、重定向、非图片响应、超过 100 MiB、连接失败或 20 秒超时均被视为
资源不可用，网关最终返回 `404`。代理在请求前校验 DNS，并把连接固定到已校验
IP，避免 DNS 重绑定。图片库不可用不会影响 MongoDB 中的搜索、prompt、模型和
workflow 元数据。

## 3. 请求链路

```text
browser /api/thumb/:sha256
        -> WorkflowDB 从 MongoDB 定位 images[] entry
        -> 本地路径不存在
        -> source.protocol == wfdb-image-library-v1
        -> GET {base_url}/v1/assets/{asset_id}/thumbnail
        -> 流式返回浏览器
```

若 `source.protocol` 缺失，WorkflowDB 保持旧行为：把 `source.base_url` 当作另一台
WorkflowDB 网关，并请求其 `/api/image/:sha256` 或 `/api/thumb/:sha256`。

## 4. 当前边界

- v1 不在 MongoDB 中存放访问令牌。需要鉴权时，建议让图片库与 WorkflowDB
  位于可信网络，或在反向代理层按来源网络鉴权。
- 每条图片目前只有一个 `source`。多副本和自动故障转移需要后续引入
  `assets/replicas[]` 模型。
- parser 仍只解析本地/上传图片；远程条目由导入器或图片库同步程序按上述 Schema
  写入 MongoDB。这一设计刻意不修改冻结的 `parser.py` 字段语义。
