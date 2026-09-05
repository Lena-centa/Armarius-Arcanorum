"""nodes_parse 公共基础：仓库根定位与 JSON IO。"""
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

DEFAULT_WORKDIR = REPO_ROOT / "temp" / "coverage_audit"


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def load_json(path: Path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, data) -> None:
    ensure_dir(path.parent)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1, sort_keys=True)


def log(msg: str) -> None:
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:
        # Windows may expose a CP950/legacy console even when artifacts are
        # UTF-8.  Audit completion must not be reported as a failure merely
        # because a progress message contains an unrepresentable character.
        encoding = getattr(sys.stdout, "encoding", None) or "utf-8"
        safe = str(msg).encode(encoding, errors="backslashreplace").decode(encoding)
        print(safe, flush=True)
