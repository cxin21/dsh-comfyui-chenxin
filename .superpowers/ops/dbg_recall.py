import sqlite3

db = sqlite3.connect(r'C:\Users\11245\.dsh\.agent-presets\comfyui-chenxin\assets\knowledge\anima-prompt-v1\tag-catalog.sqlite')
print('names with afu (canonical):', db.execute("SELECT COUNT(*) FROM names WHERE name_type='canonical' AND normalized_value LIKE '%afu%'").fetchone()[0])
print('serafuku row:', db.execute("SELECT r.record_id, r.prompt_form, r.usage_count FROM names n JOIN records r ON r.record_id=n.record_id WHERE n.name_type='canonical' AND n.normalized_value='serafuku'").fetchone())
# simulate the substring recall query for 'selafuku'
grams = ['sel', 'ela', 'laf', 'afu', 'fuk', 'uku']
where = ' OR '.join(["n.normalized_value LIKE ? ESCAPE '\\'"] * len(grams))
sql = f"SELECT r.prompt_form, r.usage_count FROM names n JOIN records r ON r.record_id=n.record_id WHERE n.name_type IN ('canonical','alias') AND ({where}) ORDER BY r.usage_count DESC LIMIT 10"
rows = db.execute(sql, [f'%{g}%' for g in grams]).fetchall()
print('recall top10:', rows)
