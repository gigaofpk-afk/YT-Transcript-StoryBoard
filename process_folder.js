const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const fetch = require('node-fetch');

const INPUT_DIR = process.env.INPUT_DIR || './input';
const OUTPUT_DIR = process.env.OUTPUT_DIR || './output';
const TARGET_LANG = process.env.TARGET_LANG || 'original';
const HISTORY_FILE = path.join(OUTPUT_DIR, 'processed_links.txt');

// Ensure directories exist
if (!fs.existsSync(INPUT_DIR)) fs.mkdirSync(INPUT_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, '', 'utf8');

const processedIds = new Set(fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').map(l => l.trim()).filter(Boolean));

async function processFolder() {
  console.log(`Starting Batch Processing...`);
  console.log(`Input: ${INPUT_DIR}`);
  console.log(`Output: ${OUTPUT_DIR}`);
  
  const files = fs.readdirSync(INPUT_DIR).filter(f => /\.(png|jpe?g|webp)$/i.test(f));
  console.log(`Found ${files.length} screenshots to process.`);

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const filePath = path.join(INPUT_DIR, file);
    console.log(`\n[${i+1}/${files.length}] Processing: ${file}`);
    
    try {
      // 1. OCR & Search
      const fd = new FormData();
      fd.append('screenshot', fs.createReadStream(filePath));
      
      const checkRes = await fetch('http://127.0.0.1:3000/api/check-screenshot', {
        method: 'POST',
        body: fd
      });
      
      const checkData = await checkRes.json();
      
      if (!checkData.valid || !checkData.videoId) {
        console.log(`  -> ❌ Failed to find a matching video: ${checkData.error || 'Unknown error'}`);
        continue;
      }
      
      const videoId = checkData.videoId;
      console.log(`  -> ✓ Found Video: ${checkData.videoInfo.title} (${videoId})`);
      
      // 2. Avoid Duplicates
      if (processedIds.has(videoId)) {
        console.log(`  -> ⏭️ Skipping: Video already processed (found in processed_links.txt)`);
        continue;
      }
      
      // 3. Generate Master ZIP
      console.log(`  -> 📥 Generating and saving Master ZIP...`);
      const dlRes = await fetch('http://127.0.0.1:3000/api/download-zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoId: videoId,
          lang: 'auto',
          targetLang: TARGET_LANG,
          destPath: OUTPUT_DIR
        })
      });
      
      const dlData = await dlRes.json();
      if (dlData.success) {
        console.log(`  -> ✓ Success! Saved to: ${dlData.path}`);
        processedIds.add(videoId);
        fs.appendFileSync(HISTORY_FILE, videoId + '\n', 'utf8');
      } else {
        console.log(`  -> ❌ Failed to save ZIP: ${dlData.error}`);
      }
      
    } catch (err) {
      console.log(`  -> ❌ Error processing ${file}: ${err.message}`);
    }
  }
  
  console.log(`\n🎉 Batch processing complete!`);
}

// Start processing (give the server 2 seconds to boot if it was just started)
setTimeout(processFolder, 2000);
