import sys, re

content = open('d:/youtube-checker/server.js', 'r', encoding='utf-8').read()

new_logic = """async function processScreenshotCore(filePath, fileExt, fileHash, isConfirmed) {
  const { data: { text } } = await Tesseract.recognize(filePath, 'eng', {
    logger: () => {},
    tessedit_pageseg_mode: '6',
  });
  if (!text || text.trim().length === 0) {
    return { valid: false, error: 'Could not extract any text from the image.' };
  }

  let videoId = null;
  let videoInfo = null;
  let extractedUrl = null;
  let autoConfirmed = false;

  const found = extractYouTubeFromText(text);
  if (found) {
    videoId = found.videoId;
    extractedUrl = found.url;
  } else {
    const { primary, secondary } = cleanOcrTextToQuery(text);
    const rawWords = text.replace(/[^\\w\\s']/g, ' ').split(/\\s+/).filter(w => w.length >= 5).slice(0, 8).join(' ');
    const queries = [...new Set([primary, secondary, rawWords])].filter(q => q.length > 4);
    
    const YTSearch = require('youtube-search-api');
    let bestVideo = null;
    let highestScore = 0;

    for (const q of queries) {
      try {
        let videos = [];
        const channelResults = await YTSearch.GetListByKeyword(q + ' channel', false, 5);
        let topChannel = null;
        if (channelResults && channelResults.items) {
           topChannel = channelResults.items.find(i => i.type === 'channel' || i.isChannel);
        }
        if (!topChannel) {
           const rawChannelResults = await YTSearch.GetListByKeyword(q, false, 5);
           if (rawChannelResults && rawChannelResults.items) {
              topChannel = rawChannelResults.items.find(i => i.type === 'channel' || i.isChannel);
           }
        }
        if (topChannel) {
           const channelName = topChannel.title || topChannel.channelTitle || q;
           const videoResults = await YTSearch.GetListByKeyword(`${channelName} ${q}`, false, 20);
           videos = (videoResults?.items || []).filter(i => i.type === 'video' || !i.type);
        }
        if (videos.length === 0) {
          const results = await YTSearch.GetListByKeyword(q, false, 20);
          videos = (results?.items || []).filter(i => i.type === 'video' || !i.type);
        }
        
        if (videos.length > 0) {
          const titles = videos.map(v => v.title || 'Untitled');
          const combinedTitles = titles.join(' |||SPLIT||| ');
          try {
            const { translate } = require('@vitalets/google-translate-api');
            const res = await translate(combinedTitles, { to: 'en' });
            const translatedTitles = res.text.split('|||SPLIT|||').map(t => t.trim());
            for (let i = 0; i < videos.length; i++) {
              videos[i].translatedTitle = translatedTitles[i] || titles[i];
            }
          } catch (err) {}
        }

        for (const video of videos) {
          const score = scoreVideoAgainstOcr(video, text);
          if (score > highestScore) { highestScore = score; bestVideo = video; }
        }
      } catch (searchErr) {}
    }

    if (bestVideo && highestScore >= 1) {
      videoId = bestVideo.id;
      videoInfo = {
        title: bestVideo.title,
        author: bestVideo.channelTitle || '',
        authorIcon: '',
        duration: bestVideo.length?.simpleText || '',
        thumbnail: `https://img.youtube.com/vi/${bestVideo.id}/hqdefault.jpg`
      };
      if (highestScore >= 8) autoConfirmed = true;
    }
  }

  if (!videoId) {
    return { valid: false, error: 'Could not identify any matching YouTube video from the screenshot.', extractedText: text.substring(0, 500) };
  }

  const history = getHistory();
  if (!videoInfo) videoInfo = history[videoId] || await fetchVideoInfo(videoId);

  if (videoInfo) {
    const textLower = text.toLowerCase();
    const authorMatch = videoInfo.author && textLower.includes(videoInfo.author.toLowerCase());
    const titleMatch = videoInfo.title && textLower.includes(videoInfo.title.toLowerCase());
    const durationMatch = videoInfo.duration && textLower.includes(videoInfo.duration);
    const hasStrongMatch = autoConfirmed || titleMatch || (authorMatch && durationMatch);
    if (!isConfirmed && !hasStrongMatch) {
      cacheScreenshot(videoId, filePath, fileExt);
      return { valid: true, requireConfirmation: true, videoId, videoInfo, extractedText: text.substring(0, 500) };
    }
  }

  cacheScreenshot(videoId, filePath, fileExt);
  const result = await runTranscriptCheck(videoId);
  
  if (fileHash) {
    const history = getHistory();
    if (!history.screenshots) history.screenshots = {};
    history.screenshots[fileHash] = videoId;
    saveHistory(history);
  }
  
  return { ...result, extractedUrl: extractedUrl || `https://www.youtube.com/watch?v=${videoId}`, extractedText: text.substring(0, 500), hasInputScreenshot: true };
}

app.post('/api/check-screenshot', upload.single('screenshot'), async (req, res) => {
  if (!req.file) return res.json({ valid: false, error: 'No image file received.' });
  const filePath = req.file.path;
  const fileExt  = path.extname(req.file.originalname).toLowerCase() || '.jpg';
  const cleanup  = () => { try { fs.unlinkSync(filePath); } catch {} };

  try {
    const crypto = require('crypto');
    const fileBuffer = fs.readFileSync(filePath);
    const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    
    const savedScreenshotsDir = path.join(__dirname, 'saved_screenshots');
    if (!fs.existsSync(savedScreenshotsDir)) fs.mkdirSync(savedScreenshotsDir, { recursive: true });
    const savedPath = path.join(savedScreenshotsDir, fileHash + fileExt);
    if (!fs.existsSync(savedPath)) fs.copyFileSync(filePath, savedPath);
    const inputImage = '/saved_screenshots/' + fileHash + fileExt;

    const history = getHistory();
    if (history.screenshots && history.screenshots[fileHash]) {
      const cachedVideoId = history.screenshots[fileHash];
      if (history[cachedVideoId]) {
        cleanup();
        return res.json({ ...history[cachedVideoId], extractedUrl: `https://www.youtube.com/watch?v=${cachedVideoId}`, fromCache: true, fileHash, inputImage });
      }
    }
    
    const result = await processScreenshotCore(filePath, fileExt, fileHash, req.body.confirmed === 'true');
    cleanup();
    if (result) {
      result.fileHash = fileHash;
      result.inputImage = inputImage;
    }
    return res.json(result);
  } catch (err) {
    cleanup();
    console.error('Screenshot OCR error:', err);
    return res.json({ valid: false, error: 'Failed to process image: ' + err.message });
  }
});

app.post('/api/report-error', express.json(), async (req, res) => {
  const { fileHash, videoId, issues } = req.body;
  if (!fileHash || !videoId) return res.status(400).json({ error: 'fileHash and videoId required' });
  const reportsFile = path.join(__dirname, 'reports.json');
  let reports = [];
  if (fs.existsSync(reportsFile)) {
    try { reports = JSON.parse(fs.readFileSync(reportsFile, 'utf8')); } catch(e) {}
  }
  reports.push({ fileHash, videoId, issues, reportedAt: new Date().toISOString() });
  fs.writeFileSync(reportsFile, JSON.stringify(reports, null, 2));
  res.json({ success: true });
});

app.post('/api/reprocess-screenshot', express.json(), async (req, res) => {
  const { fileHash } = req.body;
  if (!fileHash) return res.status(400).json({ error: 'fileHash required' });
  
  const history = getHistory();
  if (history.screenshots && history.screenshots[fileHash]) {
    delete history.screenshots[fileHash];
    saveHistory(history);
  }

  const savedScreenshotsDir = path.join(__dirname, 'saved_screenshots');
  const files = fs.existsSync(savedScreenshotsDir) ? fs.readdirSync(savedScreenshotsDir) : [];
  const fileName = files.find(f => f.startsWith(fileHash + '.'));
  if (!fileName) return res.status(404).json({ error: 'Screenshot not found.' });

  const filePath = path.join(savedScreenshotsDir, fileName);
  const fileExt = path.extname(fileName).toLowerCase();
  
  try {
    const result = await processScreenshotCore(filePath, fileExt, fileHash, false);
    if (result) {
      result.fileHash = fileHash;
      result.inputImage = '/saved_screenshots/' + fileName;
    }
    return res.json(result);
  } catch(err) {
    console.error('Reprocess error:', err);
    return res.json({ valid: false, error: 'Failed to reprocess image: ' + err.message });
  }
});
"""

pattern = re.compile(r"app\.post\('/api/check-screenshot'[\s\S]*?(?=\n// ── Start|if \(require\.main === module\))")
new_content = pattern.sub(new_logic, content)
open('d:/youtube-checker/server.js', 'w', encoding='utf-8').write(new_content)
print('Success')
