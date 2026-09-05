from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

# ---------------------------------------------------------------------------
# 统一环境配置来源:用户数据目录 .env(外置代码树,更新/重装不丢;
# 缺失时静默跳过 —— 文件生成由网关启动逻辑负责)。
# 数据目录解析规则与 TS 侧 nest_gateway/src/config/data-dir.ts 逐字段对齐:
#   WORKFLOW_DATA_DIR(进程环境,绝对路径,win32 接受 /mnt/x/... 形式)
#   → win32 %LOCALAPPDATA%\workflow_db
#   → $XDG_DATA_HOME/workflow_db(须绝对路径)
#   → ~/.local/share/workflow_db
# 环境变量优先级高于 .env(与 dotenv 语义一致)。
# ---------------------------------------------------------------------------

_WIN_MOUNT_RE = re.compile(r"^/mnt/([A-Za-z])/(.*)$")


def _normalize_win_path(value: str) -> str:
    """WSL 形式 /mnt/x/... → X:\\...(仅 Windows 原生解释器需要)。"""
    value = value.strip()
    if os.name != "nt":
        return value
    match = _WIN_MOUNT_RE.match(value)
    if not match:
        return value
    return f"{match.group(1).upper()}:\\{match.group(2).replace('/', chr(92))}"


def resolve_data_dir() -> Path:
    """解析用户数据目录绝对路径(ARMARIUS_DATA_DIR / WORKFLOW_DATA_DIR 优先;优先新目录并平滑回退旧目录)。"""
    configured = _normalize_win_path(
        os.environ.get("ARMARIUS_DATA_DIR", "") or os.environ.get("WORKFLOW_DATA_DIR", "")
    )
    if configured and os.path.isabs(configured):
        return Path(configured)
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or str(
            Path.home() / "AppData" / "Local"
        )
        p = Path(base) / "armarius_arcanorum"
        if not p.exists() and (Path(base) / "workflow_db").exists():
            return Path(base) / "workflow_db"
        return p
    xdg = os.environ.get("XDG_DATA_HOME", "").strip()
    base = Path(xdg) if (xdg and os.path.isabs(xdg)) else (Path.home() / ".local" / "share")
    p = base / "armarius_arcanorum"
    if not p.exists() and (base / "workflow_db").exists():
        return base / "workflow_db"
    return p


def _load_dotenv(data_dir: Path) -> None:
    env_file = data_dir / ".env"
    if not env_file.exists():
        return
    for raw in env_file.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key and key not in os.environ:
            os.environ[key] = value


_load_dotenv(resolve_data_dir())


@dataclass(slots=True)
class Settings:
    comfyui_base_url: str = os.getenv("COMFYUI_BASE_URL", "http://127.0.0.1:8188")


settings = Settings()
