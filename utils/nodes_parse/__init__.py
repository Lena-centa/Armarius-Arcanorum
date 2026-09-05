"""ComfyUI 生态节点定义解析工具库。

支撑节点覆盖度审计：生态索引解析、扩展源码 AST 提取
（NODE_CLASS_MAPPINGS / INPUT_TYPES / RETURN_TYPES）、函数体行为指纹等，
为 parser 受控扩展提供数据依据（docs/parser/KNOWN_GAPS.md §1.4）。

纯开发者离线工具，不随应用发布；只读扩展源码做静态分析，
不执行任何第三方扩展代码。
"""
