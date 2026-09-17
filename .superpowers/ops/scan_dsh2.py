import os, re

dsh = r'C:\Users\11245\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai'
targets = {
    'dsh-subagent-in-process-driver': re.compile(r'agentOptions|resolveChildAgentOptions|childAgent|agent\b.*preset|sessionInit|session_init|initAgent|teamAsset|团队资产|Agent 名称'),
    'dsh-subagent': re.compile(r'agentOptions|resolveChildAgentOptions|sessionInit|initAgent|teamAsset'),
    'dsh-agent': re.compile(r'sessionInit|session_init|initAgent|团队资产|请回复要使用|Agent 名称|teamAsset'),
    'dsh-agent-presets': re.compile(r'sessionInit|initAgent|团队资产|请回复要使用|Agent 名称|teamAsset'),
    'dsh-system-prompt': re.compile(r'sessionInit|initAgent|团队资产|请回复要使用'),
}
for pkg, pat in targets.items():
    root = os.path.join(dsh, pkg, 'lib')
    if not os.path.isdir(root):
        print(f'-- {pkg}: no lib --')
        continue
    hits = 0
    print(f'== {pkg} ==')
    for fn in sorted(os.listdir(root)):
        if not fn.endswith('.js'):
            continue
        p = os.path.join(root, fn)
        try:
            text = open(p, encoding='utf-8', errors='replace').read()
        except Exception:
            continue
        for m in pat.finditer(text):
            line_no = text[:m.start()].count('\n') + 1
            line = text.splitlines()[line_no - 1].strip()
            print(f'  {fn}:{line_no} {line[:140]}')
            hits += 1
            if hits > 25:
                break
        if hits > 25:
            break
