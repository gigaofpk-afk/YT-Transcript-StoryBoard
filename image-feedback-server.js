const express = require('express');
const fs = require('fs');
const path = require('path');
const Tesseract = require('tesseract.js');
const ytsr = require('ytsr');
const YouTube = require('youtube-sr').default;
const youtubeSearchApi = require('youtube-search-api');

const app = express();
const PORT = 3001;

const INPUT_FOLDER = path.normalize('D:\\G Antigravity\\Sshot Image crop , sort to Tag and  direct links\\Input\\YouTube');
const FEEDBACK_FILE = path.join(__dirname, 'feedback.json');

app.use(express.json());

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'feedback.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// Helpers
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function findImagesRecursively(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      findImagesRecursively(fullPath, fileList);
    } else {
      const ext = path.extname(fullPath).toLowerCase();
      if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
        fileList.push({
          filename: file,
          fullPath: fullPath,
          folder: path.basename(dir)
        });
      }
    }
  }
  return fileList;
}

// Routes


app.get('/api/images/load', (req, res) => {
  try {
    const images = findImagesRecursively(INPUT_FOLDER);
    const shuffled = shuffleArray(images);
    res.json(shuffled);
  } catch (err) {
    console.error('Error loading images:', err);
    res.status(500).json({ error: 'Failed to load images' });
  }
});

app.get('/api/images/serve', (req, res) => {
  const imagePath = req.query.path;
  if (!imagePath) return res.status(400).send('Path is required');

  const normalizedPath = path.normalize(imagePath);
  if (!normalizedPath.startsWith(INPUT_FOLDER)) {
    return res.status(403).send('Forbidden: Path outside of input directory');
  }

  if (fs.existsSync(normalizedPath)) {
    res.sendFile(normalizedPath);
  } else {
    res.status(404).send('Image not found');
  }
});

const { execFile } = require('child_process');
const PYTHON_PATH = 'C:\\\\Users\\\\Uzair\\\\AppData\\\\Local\\\\hermes\\\\hermes-agent\\\\venv\\\\Scripts\\\\python.exe';

// Step 1 & 2 & 3: Multi-Language OCR and UI parser
function parseYouTubeScreenshot(ocrText) {
  const lines = ocrText.split('\n').map(l => l.trim()).filter(Boolean);
  let duration = '';
  let channel = '';
  let title = '';

  // Step 4 Helper: Extract Duration badge or status
  if (/upcoming/i.test(ocrText) || /scheduled for/i.test(ocrText)) {
    duration = 'Upcoming';
  } else {
    // Only match duration badge if it's not a scheduled time
    const durMatch = ocrText.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
    if (durMatch && !/scheduled/i.test(ocrText)) {
      duration = durMatch[1];
    }
  }

  // Step 1: Detect YouTube Markers
  const hasYouTubeMarkers = 
    /@[\w.-]+/.test(ocrText) ||
    /\bviews\b/i.test(ocrText) ||
    /\bsubscribe\b|\bjoin\b/i.test(ocrText) ||
    /\bscheduled\b/i.test(ocrText) ||
    /\b\d{1,2}:\d{2}\b/.test(ocrText) ||
    /notification on/i.test(ocrText);

  // Step 2 & 3: Extract Channel & Title
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];

    // Handle @handle channel format
    if (/@[\w.-]+/.test(l)) {
      const match = l.match(/@[\w.-]+/);
      if (match) channel = match[0];
      if (i > 0 && !title) {
        title = lines[i - 1];
        if (i > 1 && lines[i - 2].length > 10 && !/views/i.test(lines[i - 2])) {
          title = lines[i - 2] + ' ' + title;
        }
      }
    }
    // Handle standard 'Channel · Views · Date' row
    else if (/\bviews\b|\bscheduled\b/i.test(l)) {
      const parts = l.split(/[·•|*-]/).map(p => p.trim());
      if (parts.length > 0 && parts[0] && !channel) {
        channel = parts[0];
      }
      if (i > 0 && !title) {
        title = lines[i - 1];
        if (i > 1 && lines[i - 2].length > 15 && !/views/i.test(lines[i - 2])) {
          title = lines[i - 2] + ' ' + title;
        }
      }
    }
  }

  // Clean trailing ellipses from title if truncated by UI
  if (title) {
    title = title.replace(/\s*\.{2,}\s*$/, '').replace(/\s*…\s*$/, '').trim();
  }

  return { isYouTube: hasYouTubeMarkers, title, channel, duration };
}

// Visual Matcher Invoker (Python OpenCV SIFT + Duration filter)
function runVisualMatcher(screenshotPath, candidates, duration) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      screenshotPath,
      candidates,
      duration
    });

    execFile(PYTHON_PATH, [path.join(__dirname, 'visual_matcher.py'), payload], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err || !stdout) {
        console.error('Visual matcher error:', stderr || err?.message);
        return resolve([]);
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch (parseErr) {
        console.error('Failed to parse visual matcher output:', parseErr);
        resolve([]);
      }
    });
  });
}

app.post('/api/images/process', async (req, res) => {
  const { imagePath, remarks } = req.body;
  if (!imagePath || !fs.existsSync(imagePath)) {
    return res.status(400).json({ success: false, error: 'Valid imagePath is required' });
  }

  try {
    console.log(`[Step 1] Starting Multi-Language OCR for: ${imagePath}`);
    if (remarks) {
      console.log(`[User Guidance / Remarks]: "${remarks}"`);
    }
    
    // Multi-language OCR worker
    const worker = await Tesseract.createWorker(['eng', 'ara', 'hin']);
    const { data: { text } } = await worker.recognize(imagePath);
    await worker.terminate();

    console.log('--- OCR Result ---');
    console.log(text.trim());
    console.log('------------------');

    // Parse according to YouTube mobile UI layout
    const parsed = parseYouTubeScreenshot(text);
    console.log(`[Extracted] Title: "${parsed.title}", Channel: "${parsed.channel}", Duration: "${parsed.duration}", IsYouTube: ${parsed.isYouTube}`);

    if (!parsed.isYouTube && !parsed.title && !remarks) {
      return res.json({
        success: false,
        ocrText: text,
        extracted: parsed,
        error: 'Step 1 Failed: Image does not appear to be a YouTube screenshot.'
      });
    }

    // Step 2 & 3: Construct Search Query incorporating user guidance/remarks if provided
    let query = parsed.title || '';
    if (parsed.channel && !query.toLowerCase().includes(parsed.channel.toLowerCase())) {
      query = `${query} ${parsed.channel}`.trim();
    }

    // If user provided remarks/guidance, use it to guide or augment the search
    if (remarks && remarks.trim()) {
      const trimmedRemarks = remarks.trim();
      // If remarks look like a full title or specific keywords, prioritize or combine them
      if (trimmedRemarks.startsWith('http') || trimmedRemarks.includes('youtube.com') || trimmedRemarks.includes('youtu.be')) {
        query = trimmedRemarks;
      } else {
        query = `${trimmedRemarks} ${parsed.channel || ''}`.trim();
      }
    }

    console.log(`[Search] Query: "${query}"`);

    let rawCandidates = [];
    try {
      const searchRes = await youtubeSearchApi.GetListByKeyword(query, false, 10);
      if (searchRes && searchRes.items) {
        rawCandidates = searchRes.items
          .filter(item => item.type === 'video' && item.id)
          .map(item => ({
            id: item.id,
            title: item.title,
            channel: item.channelTitle || '',
            duration: item.length ? item.length.simpleText : '',
            thumbnail: `https://img.youtube.com/vi/${item.id}/hqdefault.jpg`,
            url: `https://www.youtube.com/watch?v=${item.id}`
          }));
      }
    } catch (searchErr) {
      console.error('youtube-search-api error:', searchErr.message);
    }

    // Fallback search with title only if channel search produced 0 results
    if (rawCandidates.length === 0 && parsed.title) {
      try {
        const searchRes = await youtubeSearchApi.GetListByKeyword(parsed.title, false, 10);
        if (searchRes && searchRes.items) {
          rawCandidates = searchRes.items
            .filter(item => item.type === 'video' && item.id)
            .map(item => ({
              id: item.id,
              title: item.title,
              channel: item.channelTitle || '',
              duration: item.length ? item.length.simpleText : '',
              thumbnail: `https://img.youtube.com/vi/${item.id}/hqdefault.jpg`,
              url: `https://www.youtube.com/watch?v=${item.id}`
            }));
        }
      } catch (err) {}
    }

    if (rawCandidates.length === 0) {
      return res.json({
        success: false,
        ocrText: text,
        extracted: parsed,
        error: 'No candidate videos found on YouTube.'
      });
    }

    console.log(`[Step 4 & 5] Running Duration filter & SIFT Visual matching on ${rawCandidates.length} candidates...`);
    const matchScores = await runVisualMatcher(imagePath, rawCandidates, parsed.duration);

    // Merge visual scores with video metadata
    const scoredVideos = rawCandidates.map(c => {
      const scoreObj = matchScores.find(s => s.id === c.id) || {
        visualMatches: 0,
        visualScore: 0,
        durationPassed: true,
        combinedScore: 50
      };
      return {
        ...c,
        ...scoreObj
      };
    });

    // Sort by combined score (70% visual / person thumbnail weight + 30% duration filter)
    scoredVideos.sort((a, b) => b.combinedScore - a.combinedScore);

    const bestMatch = scoredVideos[0];
    console.log(`[Selected Best Match] ID: ${bestMatch.id}, Title: "${bestMatch.title}", Score: ${bestMatch.combinedScore}% (Visual: ${bestMatch.visualScore}%, Duration Passed: ${bestMatch.durationPassed})`);

    res.json({
      success: true,
      ocrText: text,
      extracted: parsed,
      found: bestMatch,
      allCandidates: scoredVideos.slice(0, 5)
    });

  } catch (error) {
    console.error('Processing error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/feedback', (req, res) => {
  try {
    const feedbackData = req.body;
    let feedbacks = [];
    if (fs.existsSync(FEEDBACK_FILE)) {
      feedbacks = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8'));
    }
    
    // Add timestamp
    feedbackData.timestamp = new Date().toISOString();
    feedbacks.push(feedbackData);
    
    fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(feedbacks, null, 2));
    res.json({ success: true });
  } catch (err) {
    console.error('Error saving feedback:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/feedback/stats', (req, res) => {
  try {
    if (!fs.existsSync(FEEDBACK_FILE)) {
      return res.json({
        total: 0, good: 0, bad: 0, accuracy: 0,
        fieldAccuracy: { title: 100, duration: 100, thumbnail: 100, channel: 100 }
      });
    }

    const feedbacks = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8'));
    const total = feedbacks.length;
    let good = 0;
    const wrongCounts = { title: 0, duration: 0, thumbnail: 0, channel: 0 };

    feedbacks.forEach(fb => {
      if (fb.response === 'good') {
        good++;
      } else {
        if (fb.wrongFields && Array.isArray(fb.wrongFields)) {
          fb.wrongFields.forEach(field => {
            if (wrongCounts[field] !== undefined) {
              wrongCounts[field]++;
            }
          });
        }
      }
    });

    const bad = total - good;
    const accuracy = total > 0 ? (good / total) * 100 : 0;
    
    const fieldAccuracy = {
      title: total > 0 ? ((total - wrongCounts.title) / total) * 100 : 100,
      duration: total > 0 ? ((total - wrongCounts.duration) / total) * 100 : 100,
      thumbnail: total > 0 ? ((total - wrongCounts.thumbnail) / total) * 100 : 100,
      channel: total > 0 ? ((total - wrongCounts.channel) / total) * 100 : 100
    };

    res.json({
      total,
      good,
      bad,
      accuracy,
      fieldAccuracy
    });
  } catch (err) {
    console.error('Error calculating stats:', err);
    res.status(500).json({ error: 'Failed to calculate stats' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
