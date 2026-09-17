import os, re, json

dsh = r'C:\Users\11245\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai'
pkgs = ['dsh-subagent', 'dsh-subagent-spawn-in-process', 'dsh-subagent-fork-in-process',
        'dsh-subagent-in-process-driver', 'dsh-tool-subagent', 'dsh-tool-subagent-control',
        'dsh-agent-presets', 'dsh-session', 'dsh-user-questions']

pat_provider = re.compile(r"providerName|registerSubagent|subagentProviders|'spawn'|\"spawn\"|'fork'|\"fork\"|forkInProcess|spawnInProcess")
pat_oneshot = re.compile(r"one.?shot|oneshot|single.?turn|noSession|skipSession|sessionInit|session_init")
pat_init = re.compile(r"团队资产|不注入任何|请回复要使用|会话初始化")

for pkg in pkgs:
    root = os.path.join(dsh, pkg, 'lib')
    if not os.path.isdir(root):
        print(f'-- {pkg}: no lib --')
        continue
    print(f'== {pkg} ==')
    for fn in sorted(os.listdir(root)):
        if not fn.endswith('.js'):
            continue
        p = os.path.join(root, fn)
        try:
            text = open(p, encoding='utf-8', errors='replace').read()
        except Exception:
            continue
        for name, pat in (('PROVIDER', pat_provider), ('ONESHOT/SESSION', pat_oneshot), ('INIT-TEXT', pat_init)):
            for m in pat.finditer(text):
                line_no = text[:m.start()].count('\n') + 1
                line = text.splitlines()[line_no - 1].strip()
                print(f'  {fn}:{line_no} [{name}] {line[:130]}')
