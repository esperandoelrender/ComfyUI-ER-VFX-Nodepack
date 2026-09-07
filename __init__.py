"""ER VFX Nodepack — film-grade VFX tools for ComfyUI.

Aggregator: every ``er_*`` sub-package in this folder defines its own
NODE_CLASS_MAPPINGS / NODE_DISPLAY_NAME_MAPPINGS; this module collects them
into a single custom node entry with one shared ``web/`` directory.
"""
import importlib
from pathlib import Path

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

_root = Path(__file__).parent
for pkg in sorted(p.name for p in _root.iterdir()
                  if p.is_dir() and p.name.startswith("er_") and (p / "__init__.py").exists()):
    mod = importlib.import_module(f".{pkg}", __name__)
    NODE_CLASS_MAPPINGS.update(getattr(mod, "NODE_CLASS_MAPPINGS", {}))
    NODE_DISPLAY_NAME_MAPPINGS.update(getattr(mod, "NODE_DISPLAY_NAME_MAPPINGS", {}))

WEB_DIRECTORY = "./web"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
