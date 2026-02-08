import json
import os

# Load repository configuration from repos.json if present; otherwise fall back
# to a small built-in default. Repos should be a list of objects with fields:
# { name, repo, pairs: [{head, base}, ...] }

def _load_from_json():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    json_path = os.path.join(script_dir, "repos.json")
    if os.path.exists(json_path):
        try:
            with open(json_path, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except Exception:
            return None
    return None


_from_json = _load_from_json()
if _from_json:
    repo_options = _from_json
else:
    repo_options = [
        
    ]
