import sys

content = open('d:/youtube-checker/server.js', 'r', encoding='utf-8').read()
with open('d:/youtube-checker/scratch_patch.py', 'r', encoding='utf-8') as f:
    full_script = f.read()

new_logic = full_script.split('"""')[1]

start_str = "app.post('/api/check-screenshot'"
end_str = "// ── Start"

idx1 = content.find(start_str)
idx2 = content.find(end_str, idx1)

if idx1 != -1 and idx2 != -1:
    new_content = content[:idx1] + new_logic + '\n' + content[idx2:]
    with open('d:/youtube-checker/server.js', 'w', encoding='utf-8') as out:
        out.write(new_content)
    print("Success")
else:
    print("Indices not found", idx1, idx2)
