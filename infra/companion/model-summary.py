"""Project non-secret generation configuration from an operator-owned TOML file."""
import json
import math
import pathlib
import re
import sys
import tomllib


def summarize(config):
    def models(value):
        values = [value] if isinstance(value, str) else list(value) if isinstance(value, (list, dict)) else []
        return [v for v in values if isinstance(v, str) and len(v.encode('utf-16-le', errors='surrogatepass')) <= 512][:16]

    def finite_number(value):
        if type(value) in (int, float) and abs(value) <= sys.float_info.max and math.isfinite(value):
            return value
        return None

    def safe_integer(value):
        return value if type(value) is int and abs(value) <= 9007199254740991 else None

    tasks = []
    configured = config.get('tasks', {})
    if not isinstance(configured, dict):
        configured = {}
    for name in ('chat_companion', 'affinity_evaluation', 'affinity_summary', 'memory_extraction', 'character_insight_extraction', 'user_insight_extraction'):
        task = configured.get(name)
        if not isinstance(task, dict):
            continue
        tasks.append({
            'name': name, 'models': models(task.get('model')),
            'fallback': models(task.get('fallback')),
            'temperature': finite_number(task.get('temperature')),
            'maxTokens': safe_integer(task.get('max_tokens')),
        })
    chat = configured.get('chat_companion', {})
    tiers = chat.get('tiers', {}) if isinstance(chat, dict) else {}
    profiles = [name for name in tiers if isinstance(name, str) and re.fullmatch(r'[a-z0-9_]{1,32}', name)][:64] if isinstance(tiers, dict) else []
    return {'tasks': tasks, 'profiles': profiles}


if __name__ == '__main__':
    try:
        data = pathlib.Path(sys.argv[1]).read_bytes()
        if len(data) > 262144:
            raise ValueError()
        print(json.dumps(summarize(tomllib.loads(data.decode())), allow_nan=False))
    except Exception:
        raise SystemExit('Generation configuration unavailable') from None
