import sys

content = open('d:/youtube-checker/public/index.html', 'r', encoding='utf-8').read()

start_str = "function buildResultHTML(data, index, fromScreenshot) {"
end_str = "return html;\n}"

idx1 = content.find(start_str)
idx2 = content.find(end_str, idx1)

if idx1 == -1 or idx2 == -1:
    print("Cannot find buildResultHTML")
    sys.exit(1)
    
orig_func = content[idx1:idx2 + len(end_str)]

new_func = orig_func.replace("return html;", """
  let layoutHtml = '';
  if (data.inputImage) {
    layoutHtml += `
      <div style="display: flex; gap: 20px; flex-wrap: wrap;">
        <div style="flex: 1; min-width: 300px;">
          ${html}
        </div>
        <div style="flex-shrink: 0; width: 300px;">
          <div style="font-family:'Space Mono', monospace; font-size:.7rem; color:var(--muted); margin-bottom:8px;">INPUT IMAGE</div>
          <img src="${data.inputImage}" style="width: 100%; border-radius: 8px; border: 1px solid var(--border);" />
        </div>
      </div>
    `;
  } else {
    layoutHtml = html;
  }
  
  if (data.fileHash) {
    layoutHtml += `
      <div class="report-section" style="margin-top: 20px; padding: 16px; border: 1px solid var(--error); border-radius: var(--radius); background: rgba(255, 78, 106, 0.05);">
        <div style="font-family:'Space Mono', monospace; font-size:.75rem; color:var(--error); font-weight:bold; margin-bottom: 12px;">REPORT ERROR & RE-PROCESS</div>
        <div style="display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; font-size: 0.8rem; color: var(--text);">
          <label><input type="checkbox" id="rep_title_${data.fileHash}" value="Title" /> Title</label>
          <label><input type="checkbox" id="rep_dur_${data.fileHash}" value="Duration" /> Duration</label>
          <label><input type="checkbox" id="rep_thumb_${data.fileHash}" value="Thumbnail" /> Thumbnail</label>
          <label><input type="checkbox" id="rep_link_${data.fileHash}" value="Wrong Video Link" /> Wrong Video Link</label>
        </div>
        <div style="display: flex; gap: 10px; align-items: center;">
          <button class="btn" onclick="submitReport('${data.fileHash}', '${data.videoId}')" style="padding: 8px 16px; font-size: .75rem; background: var(--error); color: #fff;">
            Submit Report
          </button>
          <span id="rep_msg_${data.fileHash}" style="font-size: 0.75rem; color: var(--success); display: none;">Report submitted!</span>
        </div>
        <div style="margin-top: 16px; border-top: 1px dashed rgba(255, 255, 255, 0.1); padding-top: 16px;">
          <button class="btn full-width" onclick="reprocessScreenshot('${data.fileHash}', ${index}, ${fromScreenshot})" style="font-size: 1rem; padding: 16px; background: var(--accent); color: #000; justify-content: center;">
            Re Process
          </button>
          <span id="reproc_msg_${data.fileHash}" style="font-size: 0.75rem; color: var(--success); display: none;">Reprocessing...</span>
        </div>
      </div>
    `;
  }
  
  return layoutHtml;
""")

extra_scripts = """
async function submitReport(fileHash, videoId) {
  const issues = [];
  ['title', 'dur', 'thumb', 'link'].forEach(id => {
    const cb = document.getElementById(`rep_${id}_${fileHash}`);
    if (cb && cb.checked) issues.push(cb.value);
  });
  try {
    const res = await fetch('/api/report-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileHash, videoId, issues })
    });
    if (res.ok) {
      const msg = document.getElementById(`rep_msg_${fileHash}`);
      if (msg) {
        msg.style.display = 'inline-block';
        setTimeout(() => msg.style.display = 'none', 3000);
      }
    }
  } catch(e) {
    console.error(e);
  }
}

async function reprocessScreenshot(fileHash, index, fromScreenshot) {
  const msg = document.getElementById(`reproc_msg_${fileHash}`);
  if (msg) msg.style.display = 'inline-block';
  try {
    const res = await fetch('/api/reprocess-screenshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileHash })
    });
    const data = await res.json();
    if (data.valid || data.error) {
      if (currentResults && currentResults[index]) {
        currentResults[index] = data;
        renderBatchResults(currentResults, fromScreenshot);
      } else {
        renderBatchResults([data], fromScreenshot);
      }
    }
  } catch(e) {
    console.error(e);
    if (msg) {
      msg.textContent = 'Error: ' + e.message;
      msg.style.color = 'var(--error)';
    }
  }
}
"""

new_content = content[:idx1] + new_func + '\n' + extra_scripts + '\n' + content[idx2 + len(end_str):]
open('d:/youtube-checker/public/index.html', 'w', encoding='utf-8').write(new_content)
print("Success")
