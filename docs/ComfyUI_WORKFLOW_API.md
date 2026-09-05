# ComfyUI Workflow API 

> 基于 ComfyUI 源码 `main.py`、`server.py`、`execution.py` 的核心分析  
> 版本: ComfyUI master (2026-04-30)

---

## 目录

1. [整体架构概览](#1-整体架构概览)
2. [系统启动流程](#2-系统启动流程)
3. [API 路由注册体系](#3-api-路由注册体系)
4. [Workflow JSON 结构规范](#4-workflow-json-结构规范)
5. [Workflow 注入/提交流程](#5-workflow-注入提交流程)
6. [Workflow 执行引擎](#6-workflow-执行引擎)
7. [关键 API 端点详解](#7-关键-api-端点详解)
8. [WebSocket 事件推送](#8-websocket-事件推送)
9. [FAQ 与常见问题](#9-faq-与常见问题)

---

## 1. 整体架构概览

ComfyUI 的服务端是一个**基于 aiohttp 的异步 Web 应用**，核心由三层组成：

```
┌─────────────────────────────────────────────────┐
│               main.py (入口)                      │
│  start_comfyui() → 初始化所有组件                   │
├─────────────────────────────────────────────────┤
│              server.py (API 层)                   │
│  PromptServer                                    │
│  ├── aiohttp web.Application (HTTP 路由)          │
│  ├── PromptQueue (工作流队列)                      │
│  ├── WebSocket (事件推送)                          │
│  └── add_routes() → 注册所有 API 端点              │
├─────────────────────────────────────────────────┤
│            execution.py (执行引擎)                  │
│  PromptExecutor                                   │
│  ├── validate_prompt() → 校验 + 拓扑排序           │
│  ├── execute() → 执行入口                          │
│  └── recursive_execute() → 按依赖链递归执行         │
├─────────────────────────────────────────────────┤
│           comfy/ (核心节点 + 模型)                  │
│  NODE_CLASS_MAPPINGS → 所有节点类注册表             │
└─────────────────────────────────────────────────┘
```

### 数据流：从 HTTP 请求到图像输出

```
Client                          Server
  │                               │
  │  POST /prompt (workflow JSON)  │
  │──────────────────────────────>│
  │                               │── validate_prompt() 校验
  │                               │── PromptQueue.put() 入队
  │  {"prompt_id": "xxx"}         │
  │<──────────────────────────────│
  │                               │
  │                               │── prompt_worker 线程消费
  │                               │── PromptExecutor.execute()
  │                               │   └── 按拓扑序逐节点执行
  │                               │   └── 模型推理 / 图像生成
  │                               │
  │  WebSocket "executing"        │
  │<──────────────────────────────│── 实时推送执行状态
  │  WebSocket "progress"         │
  │<──────────────────────────────│── 进度推送
  │  WebSocket "executed"         │
  │<──────────────────────────────│── 节点执行结果
  │                               │
  │  GET /history/{prompt_id}     │
  │──────────────────────────────>│
  │  {历史记录 + 输出文件路径}      │
  │<──────────────────────────────│
  │                               │
  │  GET /view?filename=...       │
  │──────────────────────────────>│
  │  <原始图像数据>                │
  │<──────────────────────────────│
```

---

## 2. 系统启动流程

### 2.1 `main.py` 启动链

```
main.py::start_comfyui()
  │
  ├── cleanup_temp()                  # 清空临时目录
  │
  ├── prompt_server = server.PromptServer(asyncio_loop)
  │   ├── aiohttp web app 创建
  │   ├── PromptQueue 初始化
  │   ├── WebSocket 注册
  │   └── Middleware 注册
  │
  ├── nodes.init_extra_nodes(...)      # 加载所有节点
  │   ├── NODE_CLASS_MAPPINGS 填充
  │   ├── 自定义节点加载
  │   └── API 节点初始化
  │
  ├── setup_database()                # 数据库初始化 (可选)
  │
  ├── prompt_server.add_routes()       # * 注册所有 API 路由
  │
  ├── hijack_progress(prompt_server)   # 劫持进度回调
  │
  ├── prompt_worker 线程启动           # * 后台消费队列
  │   └── execution.PromptExecutor()
  │
  └── await prompt_server.setup() + run()
```

### 2.2 `PromptServer` 初始化

```python
# server.py (简化)
class PromptServer:
    def __init__(self, loop):
        self.loop = loop
        self.messages = asyncio.Queue()
        self.number = 0
        self.prompt_queue = PromptQueue(self)
        self.last_prompt_id = None
        self.client_id = None
        self.sockets = dict()          # WebSocket 连接管理
        self.sockets_metadata = dict() # WebSocket 元数据
        self.web = web.Application()   # * 核心: aiohttp 应用
        self.supported_features = feature_flags.get_server_features()
```

---

## 3. API 路由注册体系

`add_routes()` 是路由注册的核心方法，在 `server.py` 中。它将所有 REST API 端点注册到 `self.web`（aiohttp Application）。

### 3.1 完整 API 路由表

```
Method  Path                             Handler                 
─────────────────────────────────────────────────────────────────
POST    /prompt                          post_prompt()           ← 提交工作流
POST    /queue                           post_queue()            ← 队列操作
POST    /upload/image                    upload_image()          
POST    /upload/mask                     upload_mask()           
POST    /free                           post_free()             
POST    /api/jobs                        post_jobs()             

GET     /prompt                          get_prompt()            ← 查询队列
GET     /queue                           get_queue()             
GET    /history                         get_history()           
GET    /history/{prompt_id}             get_history_by_id()     
GET    /object_info                     get_object_info()       ← 所有节点信息
GET    /object_info/{node_class}        get_object_info_node()  ← 特定节点
GET    /system_stats                    system_stats()          
GET    /features                        get_features()          
GET    /view                            view_image()            ← 查看/下载图片
GET    /view_metadata/{folder_name}     view_metadata()         
GET    /api/jobs                        get_jobs()              ← 任务列表 (DB)
GET    /ws                              websocket_handler()     ← WebSocket 连接

PUT    /queue/{prompt_id}/interrupt     interrupt()             
PUT    /queue/{prompt_id}/abandon       abandon()               

DELETE /history                         clear_history()         
DELETE /history/{prompt_id}             delete_history_entry()  
```

### 3.2 路由注册代码模式

```python
def add_routes(self):
    routes = web.RouteTableDef()

    @routes.post("/prompt")
    async def post_prompt(request):
        ...  # 详见第5章

    @routes.get("/object_info")
    async def get_object_info(request):
        # 返回所有节点的输入/输出类型信息
        out = {}
        for x in nodes.NODE_CLASS_MAPPINGS:
            out[x] = node_info(x)  # 动态反射节点类
        return web.json_response(out)

    # ... 更多路由 ...
    self.web.add_routes(routes)
```

---

## 4. Workflow JSON 结构规范

### 4.1 完整结构 (POST /prompt body)

```json
{
  "prompt": {                    // * 必需: 工作流节点定义
    "3": {                       // 节点 ID (字符串)
      "class_type": "KSampler",  // 节点类型 (注册在 NODE_CLASS_MAPPINGS 中的类名)
      "inputs": {                // 节点输入
        "seed": 42,
        "steps": 20,
        "cfg": 7.0,
        "sampler_name": "euler",
        "scheduler": "normal",
        "denoise": 1.0,
        "model": ["4", 0],       // * 连接: ["源节点ID", "源输出索引"]
        "positive": ["6", 0],
        "negative": ["7", 0],
        "latent_image": ["5", 0]
      }
    },
    "4": {
      "class_type": "CheckpointLoaderSimple",
      "inputs": {
        "ckpt_name": "sd_xl_base_1.0.safetensors"
      }
    },
    "6": { "class_type": "CLIPTextEncode", "inputs": { "text": "beautiful", "clip": ["4", 1] } },
    "7": { "class_type": "CLIPTextEncode", "inputs": { "text": "ugly", "clip": ["4", 1] } },
    "5": { "class_type": "EmptyLatentImage", "inputs": { "width": 1024, "height": 1024, "batch_size": 1 } },
    "8": {
      "class_type": "VAEDecode",
      "inputs": { "samples": ["3", 0], "vae": ["4", 2] }
    },
    "9": {
      "class_type": "SaveImage",
      "inputs": { "filename_prefix": "ComfyUI", "images": ["8", 0] }
    }
  },
  "workflow": {                  // * 可选: 前端 UI 布局信息
    "last_node_id": 9,
    "last_link_id": 15,
    "nodes": [/* 布局坐标等 */],
    "links": [/* 连接线信息 */],
    "groups": [],
    "config": {},
    "extra": {},
    "version": 0.4
  },
  "extra_data": {                // * 可选: 额外数据
    "extra_pnginfo": {
      "workflow": { /* 同上 workflow */ }
    }
  },
  "client_id": "uuid-string"     // * 可选: 客户端标识 (用于 WebSocket)
}
```

### 4.2 节点连接的两种表示

#### 4.2.1 内部连接 (prompt 中的链接语法)

```json
"inputs": {
  "model": ["4", 0]
  //        ↑    ↑
  //  源节点ID  输出端口索引 (从 0 开始)
}
```

#### 4.2.2 前端 UI 展现 (workflow 中的链接)

```json
"links": [
  [1, 4, 0, 3, 0, "model"],
  // ↑  ↑  ↑  ↑  ↑   ↑
  // ID 源节点 源端口 目标节点 目标端口 类型
  [2, 4, 1, 6, 0, "CLIP"],
  [3, 4, 2, 8, 1, "VAE"]
]
```

### 4.3 独立输入节点 (无依赖的源头)

没有 `["node_id", index]` 格式的输入，而是直接提供值：
- `"ckpt_name": "sd_xl_base_1.0.safetensors"`
- `"seed": 42`
- `"text": "beautiful"`

这些节点是 DAG 的**源节点**，无需等待其他节点即可执行。

### 4.4 节点信息反射 (GET /object_info)

每个节点的输入/输出定义是**动态反射**的，通过 `node_info()` 函数从节点类的 `INPUT_TYPES()` 和 `RETURN_TYPES` 获取：

```python
def node_info(node_class):
    obj_class = nodes.NODE_CLASS_MAPPINGS[node_class]
    info = {}
    info['input'] = obj_class.INPUT_TYPES()          # 输入定义
    info['input_order'] = {key: list(value.keys()) ...}
    info['output'] = obj_class.RETURN_TYPES           # 输出类型
    info['output_name'] = obj_class.RETURN_NAMES      # 输出名称
    info['name'] = node_class
    info['display_name'] = ...
    info['category'] = ...
    info['output_node'] = ...                         # 是否是输出节点
    return info
```

返回示例：
```json
{
  "KSampler": {
    "input": {
      "required": {
        "model": ["MODEL"],
        "positive": ["CONDITIONING"],
        "negative": ["CONDITIONING"],
        "latent_image": ["LATENT"],
        "seed": ["INT", {"default": 0, "min": 0, "max": 18446744073709552000}],
        "steps": ["INT", {"default": 20, "min": 1, "max": 10000}],
        "cfg": ["FLOAT", {"default": 8.0, "min": 0.0, "max": 100.0}],
        "sampler_name": ["KSAMPLER"],
        "scheduler": ["SCHEDULER"],
        "denoise": ["FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}]
      }
    },
    "output": ["LATENT"],
    "output_name": ["LATENT"],
    "name": "KSampler",
    "display_name": "KSampler",
    "output_node": false
  }
}
```

---

## 5. Workflow 注入/提交流程

这是 ComfyUI 最核心的机制：**外部 JSON → 校验 → 入队 → 执行**。

### 5.1 POST /prompt 处理链

```
Client POST /prompt
  │
  ▼
post_prompt(request)
  │
  ├── 解析 JSON body (json.loads)
  │     { "prompt": {...}, "workflow": {...}, "client_id": "...", "extra_data": {...} }
  │
  ├── 提取 prompt 部分 (JSON 中的节点定义)
  │
  ├── 提取 extra_data / client_id
  │
  ├── ▼ validate_prompt(prompt)
  │     │
  │     ├── 校验所有节点 class_type 是否存在
  │     │     → nodes.NODE_CLASS_MAPPINGS 中查找
  │     │     → 不存在则返回 400 {"error": ..., "node_errors": {...}}
  │     │
  │     ├── 校验节点输入类型匹配
  │     │     → validate_node_input() 检查连线类型是否正确
  │     │
  │     ├── 校验连接到的源节点是否都存在
  │     │     → 检查 ["node_id", index] 引用的节点是否存在
  │     │
  │     ├── 构建 DAG (有向无环图)
  │     │     → DynamicPrompt(prompt) 创建动态图
  │     │
  │     └── 返回拓扑排序的 ExecutionList
  │           → ExecutionList(dynprompt, output_cache, prompt_id)
  │           → 确定所有节点的执行顺序
  │
  ├── 生成 prompt_id (UUID)
  │
  ├── PromptQueue.put(item)
  │     item = (number, prompt_id, prompt, extra_data, execute_outputs, sensitive)
  │     → 放入 threading 同步队列
  │     → 通知 WebSocket "execution_start"
  │
  └── 返回 {"prompt_id": "xxx", "number": 1, "node_errors": {}}
```

### 5.2 核心代码 (server.py post_prompt)

```python
@routes.post("/prompt")
async def post_prompt(request):
    resp = await request.json()
    prompt = resp.get("prompt")
    # 提取 valid 的 prompt（去掉前端无用字段）
    valid_prompt = {k: v for k, v in prompt.items() if isinstance(k, str) and isinstance(v, dict)}

    # 校验
    try:
        valid, data = validate_prompt(valid_prompt)
    except Exception as e:
        return web.json_response({"error": ...}, status=400)

    # 入队
    prompt_id = str(uuid.uuid4())
    output = self.prompt_queue.put(
        (self.number, prompt_id, valid_prompt, extra_data, execute_outputs, sensitive)
    )
    return web.json_response({"prompt_id": prompt_id, "number": self.number, "node_errors": data[1]})
```

---

## 6. Workflow 执行引擎

### 6.1 prompt_worker 线程

在 `main.py` 中启动一个**独立后台线程**持续消费队列：

```python
threading.Thread(target=prompt_worker, daemon=True,
    args=(prompt_server.prompt_queue, prompt_server,)).start()
```

`prompt_worker()` 循环：
```
while True:
    queue_item = q.get(timeout=timeout)  # 阻塞等待
    if queue_item:
        item, item_id = queue_item
        prompt_id = item[1]
        e.execute(item[2], prompt_id, extra_data, item[4])
        # item[2] = 校验后的 prompt JSON
        q.task_done(item_id, e.history_result, status=...)
```

### 6.2 PromptExecutor.execute() 执行流程

```python
class PromptExecutor:
    def execute(self, prompt, prompt_id, extra_data, execute_outputs):
        # 1. 构建动态提示图
        dynprompt = DynamicPrompt(prompt)

        # 2. 构建执行列表 (拓扑排序)
        outputs_cache = BasicCache(dynprompt)
        self.cache = self._cache_class(dynprompt, outputs_cache)
        self.cache.set_prompt_id(prompt_id)
        execution_list = ExecutionList(dynprompt, outputs_cache, prompt_id)

        # 3. 初始化执行上下文
        self.current_node_context = CurrentNodeContext()

        # 4. 逐节点按拓扑序执行
        while execution_list not empty:
            node_id = execution_list.get_next_node()
            self.recursive_execute(..., node_id)

        # 5. 收集历史结果
        self.history_result = { ... outputs ... }
```

### 6.3 recursive_execute() 递归执行

```python
def recursive_execute(self, ...):
    # 1. 查找输出缓存
    if cached_outputs available:
        return cached_outputs

    # 2. 递归执行所有依赖节点
    #    例如 KSampler 依赖 model/positive/negative/latent_image
    #    → 先递归执行 CheckpointLoader → CLIPTextEncode → VAE → EmptyLatentImage
    for each dependent input link:
        dependent_node_id, output_index = input_link
        dependent_outputs = recursive_execute(dependent_node_id)

    # 3. 收集所有输入数据
    input_data_all = get_input_data(node["inputs"], class_def, node_id, outputs_cache)

    # 4. 调用节点函数执行
    output_data, output_ui = map_node_over_list(
        prompt_id, node_id, class_def, input_data_all
    )

    # 5. 缓存结果
    outputs_cache.set(node_id, output_data)

    # 6. 通过 WebSocket 推送结果
    self.server.send_sync("executed", { "node": node_id, "output": output_ui })

    return output_data
```

### 6.4 执行顺序示例

对于第 4.1 节的示例 Workflow，执行顺序是：

```
Step 1: Node 4 → CheckpointLoaderSimple
        (无依赖，直接执行，加载模型)
Step 2: Node 5 → EmptyLatentImage
        (无依赖，直接执行，创建空潜空间)
Step 3: Node 6 → CLIPTextEncode (positive)
        (依赖 Node 4 output[1] clip，等待 Step 1)
Step 4: Node 7 → CLIPTextEncode (negative)
        (依赖 Node 4 output[1] clip，等待 Step 1)
Step 5: Node 3 → KSampler
        (依赖 Node 4[0]/Node 6[0]/Node 7[0]/Node 5[0])
Step 6: Node 8 → VAEDecode
        (依赖 Node 3[0] latent + Node 4[2] vae)
Step 7: Node 9 → SaveImage
        (依赖 Node 8[0] image, 保存图像到 output 目录)
```

### 6.5 校验函数 validate_prompt()

```python
def validate_prompt(prompt):
    # 输入: 原始 prompt JSON
    # 输出: (is_valid, (dynamic_prompt, node_errors, error_info))
    
    errors = {}
    validated_prompt = {}

    for node_id, node_data in prompt.items():
        class_type = node_data.get("class_type")
        if class_type not in NODE_CLASS_MAPPINGS:
            errors[node_id] = {"class_type": "unknown"}
            continue

        # 校验输入
        class_def = NODE_CLASS_MAPPINGS[class_type]
        input_types = class_def.INPUT_TYPES()
        
        # 检查所有 required 输入是否提供
        # 检查输入类型是否匹配 (validate_node_input)
        # 检查连接的源节点是否存在

    # 构建 DynamicPrompt 并拓扑排序
    dynprompt = DynamicPrompt(validated_prompt)
    execution_list = ExecutionList(dynprompt, ...)

    return (len(errors) == 0, (dynprompt, errors, ...))
```

---

## 7. 关键 API 端点详解

### 7.1 提交工作流 POST /prompt

**Request:**
```json
{
  "prompt": {
    "3": { "class_type": "KSampler", "inputs": { ... } },
    "4": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "model.safetensors" } },
    ...
  }
}
```

**Response (200):**
```json
{
  "prompt_id": "550bfd42-1778-4e48-abea-eb8f0f71f123",
  "number": 3,
  "node_errors": {}
}
```

**Response (400 - 校验失败):**
```json
{
  "error": {
    "type": "invalid_prompt",
    "message": "Prompt has errors",
    "details": "Node 999 has unknown class_type 'NonExistentNode'"
  },
  "node_errors": {
    "999": {
      "class_type": "NonExistentNode",
      "errors": { ... }
    }
  }
}
```

**Response (500 - 执行异常):**
```json
{
  "error": {
    "type": "execution_error",
    "message": "Error occurred when executing NodeName",
    "details": "RuntimeError: CUDA out of memory"
  }
}
```

### 7.2 查询队列 GET /prompt

```json
{
  "exec_info": {
    "queue_remaining": 5,
    "queue_running": 1
  }
}
```

### 7.3 查询队列详情 GET /queue

```json
{
  "queue_running": [
    ["prompt_id", 3, { ...prompt_json... }, { ...extra_data... }, ...]
  ],
  "queue_pending": [
    ["prompt_id2", 4, { ...prompt_json... }, { ...extra_data... }, ...]
  ]
}
```

### 7.4 查询历史 GET /history 和 GET /history/{prompt_id}

```json
{
  "prompt_id": {
    "prompt": { ...prompt_json... },
    "outputs": {
      "9": {        // SaveImage 节点的输出
        "images": [
          {
            "filename": "ComfyUI_00001_.png",
            "subfolder": "",
            "type": "output"
          }
        ]
      }
    },
    "status": {
      "status_str": "success",
      "completed": true,
      "messages": []
    }
  }
}
```

### 7.5 查看/下载图像 GET /view

```
GET /view?filename=ComfyUI_00001_.png&type=output&subfolder=&format=webp&channel=rgba
  → 返回图像二进制数据
```

参数：
- `filename`: 文件名
- `type`: `output` / `input` / `temp`
- `subfolder`: 子文件夹
- `format`: `webp` (默认) / `jpeg` / `png` — 预览格式
- `channel`: `rgba` / `rgb` / `a` — 颜色通道

### 7.6 上传图像 POST /upload/image

**Request:** `multipart/form-data`
```
image: <binary>
type: input
subfolder: ""
overwrite: false
name: my_image.png
```

**Response:**
```json
{
  "name": "my_image.png",
  "subfolder": "",
  "type": "input"
}
```

### 7.7 中断执行 PUT /queue/{prompt_id}/interrupt

触发 `comfy.model_management.interrupt_current_processing()`，停止当前正在运行的任务。

### 7.8 获取系统状态 GET /system_stats

```json
{
  "system": {
    "os": "win32",
    "ram_total": 34276446208,
    "ram_free": 12345678901,
    "comfyui_version": "0.3.28",
    "python_version": "3.12.7",
    "pytorch_version": "2.6.0+cu124"
  },
  "devices": [
    {
      "name": "NVIDIA GeForce RTX 4090",
      "type": "cuda",
      "index": 0,
      "vram_total": 25769803776,
      "vram_free": 12345678901
    }
  ]
}
```

### 7.9 获取节点信息 GET /object_info

返回所有注册节点的输入/输出/类别定义。**这是客户端构建 UI 的最重要接口**。

### 7.10 获取 workflow 模板列表 GET /workflow_templates

**功能**: 扫描所有自定义节点 (`custom_nodes/`) 中的 `example_workflows/`、`examples/`、`workflow/` 等目录，返回可用的示例 workflow 模板列表。

**来源**: `app/custom_node_manager.py`

**Response:**
```json
{
  "ComfyUI-TestExtension1": ["workflow1", "workflow2"],
  "ComfyUI-MyNodes": ["tutorial_v1", "tutorial_v2"]
}
```

每个模板文件可通过 `GET /api/workflow_templates/{模块名}/{文件名}` 获取原始 JSON 内容（静态文件服务）。

### 7.11 获取执行任务列表 GET /api/jobs

**功能**: 列出所有已提交的 workflow 执行记录，支持过滤、排序、分页。这是**最接近「查询 workflow 列表」的端点**。

**Query Parameters:**
| 参数 | 类型 | 说明 |
|------|------|------|
| `status` | string | 过滤状态（逗号分隔）: `pending`, `in_progress`, `completed`, `failed` |
| `workflow_id` | string | 按 workflow ID 过滤（需提交时在 `extra_data` 中指定） |
| `sort_by` | string | 排序字段: `created_at`(默认), `execution_duration` |
| `sort_order` | string | 排序方向: `asc`, `desc`(默认) |
| `limit` | int | 返回条数上限（正整数） |
| `offset` | int | 偏移量（非负整数，默认 0） |

**Response:**
```json
[
  {
    "prompt_id": "550bfd42-...",
    "status": {
      "status_str": "success",
      "completed": true,
      "messages": [["execution_success", ""]]
    },
    "workflow_id": "my-workflow-001",
    "workflow": {
      "prompt": { /* 完整的 prompt JSON */ },
      "execution_status": { ... }
    },
    "create_time": 1714482000,
    "execution_duration": 12.345,
    "outputs": {
      "9": {
        "images": [{ "filename": "ComfyUI_00001_.png", ... }]
      }
    }
  }
]
```

**`workflow_id` 的来源**: 在 `POST /prompt` 提交时，通过 `extra_data` 传递：

```json
{
  "prompt": { ... },
  "extra_data": {
    "extra_pnginfo": {
      "workflow": { "id": "my-workflow-001" }
    }
  }
}
```

Server 端 `comfy_execution/jobs.py` 中的 `_extract_job_metadata()` 会从 `extra_data.extra_pnginfo.workflow.id` 提取此 ID。

### 7.12 队列操作 POST /queue

```json
// 删除队列中的任务
{ "delete": ["prompt_id_1", "prompt_id_2"] }
// 清空队列
{ "clear": true }
```

---

## 8. WebSocket 事件推送

### 8.1 连接

```
ws://localhost:8188/ws?client_id=uuid-string
```

### 8.2 事件类型

| 事件类型 | 方向 | 说明 |
|---------|------|------|
| `execution_start` | Server → Client | 某个 prompt 开始执行 |
| `executing` | Server → Client | 当前正在执行的节点 ID |
| `executed` | Server → Client | 某个节点执行完成，包含输出 UI 数据 |
| `progress` | Server → Client | 采样进度 (value / max) |
| `execution_cached` | Server → Client | 哪些节点使用了缓存 |
| `status` | Server → Client | 队列状态更新 (queue_remaining) |
| `preview` (Binary) | Server → Client | 潜空间预览图 (二进制) |

### 8.3 WebSocket 消息格式

**文本消息：**
```json
{
  "type": "executed",
  "data": {
    "node": "3",
    "display_node": "3",
    "output": {
      "images": [{ "filename": "...", "subfolder": "", "type": "temp" }],
      "prompt_id": "xxx"
    },
    "prompt_id": "xxx"
  }
}
```

**二进制消息：**
- 前 8 字节: `BinaryEventTypes` 类型 (小端序 uint64)
- 后续字节: 图像数据 (WebP 格式)

### 8.4 客户端交互时序

```
Client                              Server
  │                                    │
  │─── WebSocket Connect ──────────────>│
  │                                    │
  │─── POST /prompt ──────────────────>│  ← JSON prompt
  │<── {"prompt_id": "abc"} ──────────│
  │                                    │
  │<── {"type": "execution_start",     │  ← 开始执行
  │       "data": {"prompt_id": "abc"}}│
  │<── {"type": "executing",           │  ← 当前执行节点 4
  │       "data": {"node": "4"}}      │
  │<── {"type": "executed",            │  ← 节点 4 完成
  │       "data": {"node": "4", ...}} │
  │<── {"type": "executing",           │  ← 当前执行节点 5
  │       "data": {"node": "5"}}      │
  │<── {"type": "executed", ...}       │  ← 节点 5 完成
  │    ...                              │
  │<── {"type": "executing",           │  ← 正在执行 KSampler
  │       "data": {"node": "3"}}      │
  │<── {"type": "progress",            │  ← 采样进度 5/20
  │       "data": {"value": 5,         │
  │                 "max": 20}}         │
  │<── ...binary... (潜空间预览)        │
  │<── {"type": "progress", "value":}  │  ← 采样进度 10/20
  │    ...                              │
  │<── {"type": "executed", ...}       │  ← KSampler 完成
  │<── {"type": "executing",           │  ← 正在执行 VAEDecode
  │       "data": {"node": "8"}}      │
  │<── {"type": "executed", ...}       │  ← VAEDecode 完成
  │<── {"type": "executing",           │  ← 正在执行 SaveImage
  │       "data": {"node": "9"}}      │
  │<── {"type": "executed", ...}       │  ← 所有节点完成
  │<── {"type": "executing",           │  ← 标记执行结束
  │       "data": {"node": null}}      │
```

---

## 9. FAQ 与常见问题

### Q1: Workflow JSON 中最少需要哪些字段？

最少只需要 `prompt` 字段，包含节点定义。`workflow` 和 `extra_data` 都是可选的（UI 布局信息）。

```json
{ "prompt": { "1": { "class_type": "...", "inputs": {...} } } }
```

### Q2: 如何通过 API 提交工作流并获取结果？

```
1. POST /prompt 提交 workflow JSON → 得到 prompt_id
2. 通过 WebSocket 监听执行进度
3. 执行完成后 GET /history/{prompt_id} → 得到输出文件列表
4. GET /view?filename=xxx 下载输出图像
```

### Q3: 如何判断一个节点是"输出节点"（会保存文件）？

在 `GET /object_info` 中，节点如有 `"output_node": true`，则它是输出节点（如 SaveImage、PreviewImage）。

### Q4: 工作流执行的错误如何处理？

- 校验阶段错误 (400): 节点类型不存在、输入缺失、类型不匹配
- 执行阶段错误 (500): 模型加载失败、CUDA OOM、节点代码异常
- 错误会通过 WebSocket 推送 `execution_error` 事件

### Q5: 如何复用之前节点的缓存结果？

ComfyUI 支持多种缓存模式：
- `CacheType.CLASSIC`: 默认，基于 IS_CHANGED 判断
- `CacheType.LRU`: LRU 缓存
- `CacheType.RAM_PRESSURE`: 基于内存压力自动清除
- `CacheType.NONE`: 禁止缓存

通过命令行参数 `--cache-lru N`、`--cache-ram N`、`--cache-none` 控制。

### Q6: 如何将工作流嵌入到另一个系统中？

核心思路：直接用 API 提交 JSON，跳过前端 UI。
```python
import requests, json

workflow = {
    "3": { "class_type": "KSampler", "inputs": {...} },
    "4": { "class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "model.safetensors"} },
    # ... 完整 workflow ...
}

resp = requests.post("http://localhost:8188/prompt", json={"prompt": workflow})
prompt_id = resp.json()["prompt_id"]
```


### Q7: 前端 UI 是如何保存/加载 workflow 的？用的是专用 API 吗？

**没有专用的 workflow 管理 API。** 前端实际上使用的是 **通用文件 CRUD API** (`/userdata`) 来读写 workflow JSON 文件。

#### 架构背景

ComfyUI 的前端是一个 **独立的 npm 包** (`comfyui-frontend-package`)，作为静态资源由后端 Serve。前端没有自己的后端服务，所有数据持久化都依赖 ComfyUI 后端的通用文件接口。

#### 核心 API：`/userdata` 通用文件操作

注册于 `app/user_manager.py` 的 `UserManager.add_routes()`：

| 方法 | 路径 | 前端用途 |
|------|------|---------|
| `GET` | `/userdata?dir=workflows` | **列出所有已保存的 workflow 文件** |
| `GET` | `/userdata/{path}` | **读取某个 workflow JSON** |
| `POST` | `/userdata/{path}` | **保存/覆盖 workflow** |
| `DELETE` | `/userdata/{path}` | **删除 workflow** |
| `POST` | `/userdata/{file}/move/{dest}` | **重命名/移动 workflow** |

#### 文件存储路径

所有文件存储在服务端的用户目录中：

```
ComfyUI/user/{user_id}/
└── workflows/
    ├── text_to_image.json
    ├── portrait_generator.json
    ├── img2img_v2.json
    └── my_subfolder/
        └── complex_workflow.json
```

- 默认 `user_id` = `default`
- 存储目录 = `ComfyUI/user/default/workflows/`
- 多用户模式 (`--multi-user`) 下按每个 `user_id` 隔离

#### 交互流程

```
用户点击 Save
    │
    ▼
前端从画布(Canvas)提取:
  1. prompt 部分 → 节点连接逻辑
  2. workflow 部分 → UI 布局信息 (节点位置/大小/颜色)
  3. extra_data → 附加数据
    │
    ▼
POST /userdata/workflows/my_workflow.json?overwrite=true
  Body: 完整的 workflow JSON (prompt + workflow + extra_data)
    │
    ▼
后端写到: user/default/workflows/my_workflow.json

---

用户点击 Load → 打开加载弹窗
    │
    ▼
GET /userdata?dir=workflows
    │
    ▼
后端枚举目录，返回文件名列表:
["text_to_image.json", "portrait_generator.json", ...]
    │
    ▼
前端渲染列表，用户点击一项
    │
    ▼
GET /userdata/workflows/text_to_image.json
    │
    ▼
后端返回完整 JSON →
  前端提取 workflow.workflow 部分还原画布布局
  前端提取 workflow.prompt 部分作为执行图
```

#### 为什么说「没有原生 Workflow 列表 API」？

1. **`/userdata` 是通用文件接口**
   它不关心你存的是 workflow、笔记还是配置文件，只是抽象地提供文件读写。如果你存一个 `notes/ideas.txt`，`/userdata?dir=notes` 也能列出来。

2. **`workflows/` 目录只是前端惯例**
   前端代码约定把所有 workflow 放在 `workflows/` 子目录下，这是**业务层约定**，不是后端的强制规则。后端对目录名称没有任何特殊处理。

3. **没有 workflow 元数据层**
   你不能通过 API 查询：
   - workflow 的名称（只能从文件名推测）
   - workflow 的描述/标签/缩略图
   - workflow 的创建时间/修改时间
   - workflow 使用的模型列表
   
   所有元信息都**隐含在 JSON 文件内容中**，需要读取整个文件才能获取。

4. **对第三方 API 调用者的影响**

| 场景 | 前端做法 | 第三方 API 调用者做法 |
|------|---------|-------------------|
| 保存 workflow | `POST /userdata/workflows/xxx.json` | 自行在外部保存 workflow JSON |
| 加载 workflow | `GET /userdata/workflows/xxx.json` | 读取本地文件，然后 `POST /prompt` |
| 列出 workflow | `GET /userdata?dir=workflows` | **也能用**，但只返回文件名，无元数据 |
| 删除 workflow | `DELETE /userdata/workflows/xxx.json` | 同样能用 |

**结论**：ComfyUI 前端的 workflow 管理功能本质上是 **前端约定 + 通用文件存储** 的组合，不是后端暴露的语义化 API。对于需要 RESTful 集成 ComfyUI 的第三方系统，`/userdata` 可用但不够语义化，建议在中间层自行管理 workflow 元数据。

---

## 附录: 代码位置索引

| 功能 | 文件 | 关键函数/类 |
|------|------|------------|
| 系统入口 | `main.py` | `start_comfyui()`, `prompt_worker()` |
| API 服务器 | `server.py` | `PromptServer`, `add_routes()`, `post_prompt()` |
| 执行引擎 | `execution.py` | `PromptExecutor`, `validate_prompt()`, `recursive_execute()` |
| 图拓扑排序 | `comfy_execution/graph.py` | `DynamicPrompt`, `ExecutionList`, `get_input_info()` |
| 节点注册表 | `nodes.py` | `NODE_CLASS_MAPPINGS`, `init_extra_nodes()` |
| 节点校验 | `comfy_execution/validation.py` | `validate_node_input()` |
| 队列管理 | `execution.py` | `PromptQueue` |
| WebSocket | `server.py` | `websocket_handler()`, `send_sync()` |
| 工作流 DB API | `server.py` | `get_jobs()`, `post_jobs()` |

---

> **文档版本**: v1.0 | **生成日期**: 2026-04-30  
> 基于 ComfyUI 源码深度分析