const express = require('express');
const { initCloudGuards, checkCloudPathGuard } = require('./cloud_manager');
initCloudGuards();
const { initGDrive, uploadToGDrive } = require('./gdrive_manager');
initGDrive();
const path = require('path');
const fs = require('fs');
const https = require('https');
const zlib = require('zlib');
const multer = require('multer');
const Tesseract = require('tesseract.js');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure uploads dir exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// ── Screenshot cache (keeps uploaded file briefly for ZIP inclusion) ──────────
// Map<videoId, { filePath, ext, savedAt }>
const screenshotCache = new Map();
const SCREENSHOT_TTL_MS = 30 * 60 * 1000; // 30 minutes

function cacheScreenshot(videoId, filePath, ext) {
  // If a previous entry exists for this videoId, delete the old file first
  const existing = screenshotCache.get(videoId);
  if (existing && existing.filePath !== filePath) {
    try { fs.unlinkSync(existing.filePath); } catch {}
  }
  screenshotCache.set(videoId, { filePath, ext, savedAt: Date.now() });
}

function consumeScreenshot(videoId) {
  const entry = screenshotCache.get(videoId);
  if (!entry) return null;
  // Check TTL
  if (Date.now() - entry.savedAt > SCREENSHOT_TTL_MS) {
    try { fs.unlinkSync(entry.filePath); } catch {}
    screenshotCache.delete(videoId);
    return null;
  }
  // Read and delete
  try {
    const buf = fs.readFileSync(entry.filePath);
    fs.unlinkSync(entry.filePath);
    screenshotCache.delete(videoId);
    return { buf, ext: entry.ext };
  } catch {
    screenshotCache.delete(videoId);
    return null;
  }
}

// Periodic TTL cleanup every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [videoId, entry] of screenshotCache.entries()) {
    if (now - entry.savedAt > SCREENSHOT_TTL_MS) {
      try { fs.unlinkSync(entry.filePath); } catch {}
      screenshotCache.delete(videoId);
    }
  }
}, 10 * 60 * 1000).unref();

// ── History / Cache ───────────────────────────────────────────────────────────
const historyFile = path.join(__dirname, 'history.json');
function getHistory() {
  if (fs.existsSync(historyFile)) {
    try { return JSON.parse(fs.readFileSync(historyFile, 'utf8')); } catch(e) { return {}; }
  }
  return {};
}
function saveHistory(history) {
  fs.writeFileSync(historyFile, JSON.stringify(history, null, 2)); uploadToGDrive("history.json");
}

// ── Multer config ─────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const fileFilter = (req, file, cb) => {
  cb(null, ['image/png','image/jpeg','image/jpg','image/webp'].includes(file.mimetype));
};
const upload = multer({ storage, fileFilter, limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json({ limit: '500mb' })); app.use(express.urlencoded({ limit: '500mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/saved_screenshots', express.static(path.join(__dirname, 'saved_screenshots')));

// ── URL helpers ───────────────────────────────────────────────────────────────
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/v\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) { const m = url.match(p); if (m) return m[1]; }
  return null;
}

function isValidYouTubeUrl(url) {
  try {
    const u = new URL(url);
    return ['www.youtube.com','youtube.com','youtu.be','m.youtube.com'].includes(u.hostname);
  } catch { return false; }
}

function extractPlaylistId(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get('list');
  } catch { return null; }
}

function extractYouTubeFromText(text) {
  const urlPatterns = [
    /https?:\/\/(?:www\.)?youtube\.com\/watch\?[^\s"'<>]*v=([a-zA-Z0-9_-]{11})[^\s"'<>]*/,
    /https?:\/\/youtu\.be\/([a-zA-Z0-9_-]{11})[^\s"'<>]*/,
    /https?:\/\/(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})[^\s"'<>]*/,
    /https?:\/\/(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})[^\s"'<>]*/,
  ];
  for (const pat of urlPatterns) {
    const m = text.match(pat);
    if (m) return { url: m[0], videoId: m[1] };
  }
  const partialPatterns = [
    /(?:youtube\.com\/watch\?[^\s"'<>]*v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /\bID:\s*([a-zA-Z0-9_-]{11})\b/i
  ];
  for (const pat of partialPatterns) {
    const m = text.match(pat);
    if (m) return { url: `https://www.youtube.com/watch?v=${m[1]}`, videoId: m[1] };
  }
  return null;
}

// ── Video info (oEmbed + youtube-search-api fallback) ─────────────────────────
async function fetchVideoInfo(videoId) {
  let title = '';
  let author = '';
  let duration = '';
  let description = '';
  let thumbnail = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

  // Primary: youtube-search-api to get duration and description
  try {
    const YTSearch = require('youtube-search-api');
    const results = await YTSearch.GetListByKeyword(videoId, false, 1);
    const item = results?.items?.[0];
    if (item && item.id === videoId) {
      title = item.title;
      author = item.channelTitle || '';
      duration = item.length?.simpleText || '';
      
      // Try to get description for chapters
      try {
        const details = await YTSearch.GetVideoDetails(videoId);
        if (details && details.description) {
           description = details.description;
        }
      } catch (e) {}
    }
  } catch (err) {}

  // Fallback: oEmbed if primary failed or didn't get title
  if (!title) {
    try {
      const fetch = require('node-fetch');
      const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
      if (res.ok) {
        const data = await res.json();
        title = data.title;
        author = data.author_name;
      }
    } catch (err) {}
  }

  if (!title) return null; // Video really not found
  
  // Parse Chapters
  const chapters = [];
  if (description) {
      const lines = description.split('\n');
      const timeRegex = /(?:([0-5]?\d):)?([0-5]?\d):([0-5]\d)/;
      for (const line of lines) {
          const match = line.match(timeRegex);
          if (match) {
              const timeStr = match[0];
              const titlePart = line.replace(timeStr, '').replace(/^[\s\-\:]+/, '').trim();
              if (titlePart.length > 2) {
                  chapters.push({ time: timeStr, title: titlePart });
              }
          }
      }
  }

  return {
    title,
    author,
    authorIcon: thumbnail, 
    duration,
    thumbnail,
    chapters
  };
}

//  Transcript check 


  //  Transcript check 
async function runTranscriptCheck(videoId) {
  const history = getHistory();
  if (history[videoId]) return history[videoId];

  const videoInfo = await fetchVideoInfo(videoId);
  if (!videoInfo) {
    return { valid: true, videoId, videoFound: false, error: 'Video not found or private/unavailable.', transcriptAvailable: false, languages: [] };
  }

  let transcriptAvailable = false;
  let languages = [];
  let transcriptError = null;

  try {
    const { YoutubeTranscript } = require('youtube-transcript');
    const transcripts = await YoutubeTranscript.fetchTranscript(videoId);
    if (transcripts && transcripts.length > 0) {
      transcriptAvailable = true;
      const langCodes = [
        { code: 'en', name: 'English' }, { code: 'es', name: 'Spanish' }, { code: 'fr', name: 'French' },
        { code: 'de', name: 'German' }, { code: 'pt', name: 'Portuguese' }, { code: 'ja', name: 'Japanese' },
        { code: 'zh-Hans', name: 'Chinese (Simplified)' }, { code: 'ar', name: 'Arabic' },
        { code: 'hi', name: 'Hindi' }, { code: 'ru', name: 'Russian' }, { code: 'ko', name: 'Korean' },
        { code: 'it', name: 'Italian' }, { code: 'tr', name: 'Turkish' }, { code: 'ur', name: 'Urdu' },
      ];
      const availableLangs = [];
      const checks = langCodes.map(async (lang) => {
        try {
          const t = await YoutubeTranscript.fetchTranscript(videoId, { lang: lang.code });
          if (t && t.length > 0) availableLangs.push(lang);
        } catch {}
      });
      await Promise.all(checks);
      languages = availableLangs.length > 0 ? availableLangs : [{ code: 'auto', name: 'Auto-detected' }];
    }
  } catch (err) {
    transcriptAvailable = false;
    if (err.message?.includes('disabled')) transcriptError = 'Transcripts are disabled for this video.';
    else if (err.message?.includes('not found')) transcriptError = 'Video not found.';
    else transcriptError = 'No transcripts/captions available for this video.';
  }

  const result = {
    valid: true, videoId, videoFound: true,
    title: videoInfo.title, author: videoInfo.author,
    thumbnail: videoInfo.thumbnail, authorIcon: videoInfo.authorIcon,
    duration: videoInfo.duration, transcriptAvailable, languages, chapters: videoInfo.chapters || [],
    transcriptError: transcriptError || null
  };
  history[videoId] = result;
  saveHistory(history);
  return result;
}

// ── Translation (Google Translate API via '@vitalets/google-translate-api') ────
async function translateText(entries, targetLang) {
  if (!targetLang || targetLang === 'original') return entries;
  try {
    const { translate } = require('@vitalets/google-translate-api');
    
    const BATCH_SIZE = 25;
    const SEPARATOR = ' ||| ';
    const translated = [];

    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      const combined = batch.map(e => e.text.replace(/\|\|\|/g, '...')).join(SEPARATOR);
      
      try {
        const res = await translate(combined, { to: targetLang });
        const translatedText = res.text;
        const parts = translatedText.split(SEPARATOR);
        
        for (let j = 0; j < batch.length; j++) {
          translated.push({ 
            ...batch[j], 
            text: (parts[j] || batch[j].text).trim() 
          });
        }
        
        if (i + BATCH_SIZE < entries.length) {
          await new Promise(r => setTimeout(r, 150));
        }
      } catch (batchErr) {
        console.error('Batch translation failed:', batchErr.message);
        batch.forEach(e => translated.push(e));
      }
    }
    return translated;
  } catch (err) {
    console.error('Translation setup error:', err.message);
    return entries;
  }
}

// ── SRT timestamp helper ──────────────────────────────────────────────────────
function msToSrtTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const milliseconds = Math.round(ms % 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')},${String(milliseconds).padStart(3,'0')}`;
}

// ── Build content helpers ─────────────────────────────────────────────────────

function getSeconds(entry, index) {
  return (entry.offset != null ? entry.offset : (entry.start != null ? entry.start * 1000 : index * 4000)) / 1000;
}
function formatTimestamp(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `[${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}]`;
  return `[${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}]`;
}
function parseChapTime(tStr) {
  const p = tStr.split(':').map(Number).reverse();
  return (p[0]||0) + (p[1]||0)*60 + (p[2]||0)*3600;
}
function formatEntriesWithChapters(entries, chapters) {
  const result = [];
  let chapIdx = 0;
  const parsedChaps = (chapters || []).map(c => ({...c, secs: parseChapTime(c.time)}));
  
  entries.forEach((e, i) => {
    const secs = getSeconds(e, i);
    // check if we crossed a chapter
    while (chapIdx < parsedChaps.length && secs >= parsedChaps[chapIdx].secs) {
      result.push({ isChapter: true, title: parsedChaps[chapIdx].title, time: parsedChaps[chapIdx].time });
      chapIdx++;
    }
    result.push({ isChapter: false, text: `${formatTimestamp(secs)} ${e.text}` });
  });
  return result;
}

function buildTxt(entries, chapters) {
  const fmt = formatEntriesWithChapters(entries, chapters);
  return fmt.map(f => f.isChapter ? `\n=== ${f.title} (${f.time}) ===\n` : f.text).join('\n');
}

function buildMd(title, author, videoUrl, langLabel, entries, chapters) {
  const fmt = formatEntriesWithChapters(entries, chapters);
  const lines = [
    `# ${title}`,
    ``,
    `**Channel:** ${author}`,
    `**URL:** ${videoUrl}`,
    `**Language:** ${langLabel}`,
    `**Generated:** ${new Date().toUTCString()}`,
    ``,
    `---`,
    ``,
    `## Transcript`,
    ``
  ];
  fmt.forEach(f => {
    if (f.isChapter) lines.push(`\n### ${f.title} (${f.time})\n`);
    else lines.push(f.text);
  });
  return lines.join('\n');
}


function buildSrt(entries) {
  let srt = '';
  entries.forEach((entry, index) => {
    const start = entry.offset != null ? entry.offset : (entry.start != null ? entry.start * 1000 : index * 4000);
    const dur = entry.duration != null ? entry.duration : 4000;
    srt += `${index + 1}\n${msToSrtTime(start)} --> ${msToSrtTime(start + dur)}\n${entry.text.trim()}\n\n`;
  });
  return srt;
}
async function buildDocx(title, author, videoUrl, langLabel, entries, chapters) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
  // Format without timestamps
  const parsedChaps = (chapters || []).map(c => ({...c, secs: parseChapTime(c.time)}));
  let chapIdx = 0;
  
  const children = [
    new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ children: [new TextRun({ text: `Channel: ${author}`, bold: true })] }),
    new Paragraph({ children: [new TextRun({ text: `URL: ${videoUrl}`, color: '0563C1' })] }),
    new Paragraph({ children: [new TextRun({ text: `Language: ${langLabel}`, italics: true })] }),
    new Paragraph({ text: '' }),
    new Paragraph({ children: [new TextRun({ text: '-'.repeat(60), color: 'AAAAAA' })] }),
    new Paragraph({ text: '' })
  ];

  entries.forEach((e, i) => {
    const secs = getSeconds(e, i);
    while (chapIdx < parsedChaps.length && secs >= parsedChaps[chapIdx].secs) {
      children.push(new Paragraph({ text: `${parsedChaps[chapIdx].title}`, heading: HeadingLevel.HEADING_2 }));
      chapIdx++;
    }
    children.push(new Paragraph({ children: [new TextRun(e.text)] })); // No timestamp prefixed
  });
  
  const doc = new Document({
    creator: author, title: title, description: `Transcript: ${title}`,
    sections: [{ children }]
  });
  return Packer.toBuffer(doc);
}
async function buildPdf(title, author, videoUrl, langLabel, entries, chapters) {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ margin: 55, size: 'A4' });
    const chunks = [];
    pdf.on('data', c => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    // Header
    pdf.fontSize(18).font('Helvetica-Bold').text(title, { align: 'left' });
    pdf.moveDown(0.4);
    pdf.fontSize(10).font('Helvetica')
      .fillColor('#555555').text(`Channel: ${author}`)
      .text(`URL: ${videoUrl}`)
      .text(`Language: ${langLabel}`)
      .text(`Generated: ${new Date().toUTCString()}`);
    pdf.moveDown(0.5);
    pdf.moveTo(55, pdf.y).lineTo(540, pdf.y).strokeColor('#CCCCCC').stroke();
    pdf.moveDown(0.7);

    // Transcript lines
    pdf.fillColor('#222222').fontSize(10).font('Helvetica');
    entries.forEach(entry => {
      if (pdf.y > 760) pdf.addPage();
      pdf.text(entry.text, { align: 'left', lineGap: 2 });
    });

    pdf.end();
  });
}

// ── Gemini STT Transcription Helpers ──────────────────────────────────────────
const { exec } = require('child_process');

async function ensureYtdlp() {
  const localExe = path.join(__dirname, 'yt-dlp.exe');
  if (fs.existsSync(localExe)) {
    return localExe;
  }
  
  return new Promise((resolve) => {
    exec('yt-dlp --version', async (error) => {
      if (!error) {
        resolve('yt-dlp');
      } else {
        console.log('Downloading yt-dlp.exe...');
        try {
          const fetch = require('node-fetch');
          const res = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe');
          if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
          const buffer = await res.buffer();
          fs.writeFileSync(localExe, buffer);
          console.log('yt-dlp.exe downloaded successfully.');
          resolve(localExe);
        } catch (downloadErr) {
          console.error('Failed to download yt-dlp.exe:', downloadErr.message);
          resolve(null);
        }
      }
    });
  });
}

async function downloadYoutubeAudio(videoId) {
  const ytdlpPath = await ensureYtdlp();
  if (!ytdlpPath) throw new Error('yt-dlp is not available and could not be downloaded.');

  const outputPath = path.join(__dirname, 'uploads', `audio_${videoId}.m4a`);
  
  if (!fs.existsSync(path.join(__dirname, 'uploads'))) {
    fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
  }

  if (fs.existsSync(outputPath)) {
    try { fs.unlinkSync(outputPath); } catch {}
  }

  return new Promise((resolve, reject) => {
    const cmd = `"${ytdlpPath}" -f 140 -o "${outputPath}" "https://www.youtube.com/watch?v=${videoId}"`;
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`yt-dlp failed: ${stderr || error.message}`));
      } else {
        resolve(outputPath);
      }
    });
  });
}

async function uploadAudioToGemini(filePath, mimeType, apiKey) {
  const stats = fs.statSync(filePath);
  const fileSize = stats.size;

  const initUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`;
  const fetch = require('node-fetch');
  const initRes = await fetch(initUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': fileSize.toString(),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      file: { display_name: path.basename(filePath) }
    })
  });

  if (!initRes.ok) {
    throw new Error(`Failed to initialize Gemini file upload: ${initRes.status} ${await initRes.text()}`);
  }

  const uploadUrl = initRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new Error('Upload URL not received from Gemini.');
  }

  const fileStream = fs.createReadStream(filePath);
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': fileSize.toString(),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize'
    },
    body: fileStream
  });

  if (!uploadRes.ok) {
    throw new Error(`Gemini byte upload failed: ${uploadRes.status} ${await uploadRes.text()}`);
  }

  const uploadInfo = await uploadRes.json();
  return uploadInfo.file.uri;
}

async function transcribeAudioWithGemini(fileUri, mimeType, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const fetch = require('node-fetch');
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Transcribe this audio file. Output the transcription as a chronological list of segments with timestamps in [MM:SS] format if possible, followed by the text. E.g. [00:12] Welcome back to our channel.' },
            { file_data: { file_uri: fileUri, mime_type: mimeType } }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`Gemini transcription model failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('Gemini returned an empty transcription response.');
  }
  return text;
}

async function deleteFileFromGemini(fileUri, apiKey) {
  try {
    const fileId = fileUri.split('/').pop();
    const url = `https://generativelanguage.googleapis.com/v1beta/files/${fileId}?key=${apiKey}`;
    const fetch = require('node-fetch');
    await fetch(url, { method: 'DELETE' });
  } catch (err) {
    console.error('Failed to clean up Gemini file:', err.message);
  }
}

function parseGeminiTranscriptToEntries(rawText) {
  const lines = rawText.split('\n');
  const entries = [];
  const timeRegex = /(?:\[)?(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\])?/;

  let lastTimeMs = 0;
  
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    
    const match = trimmed.match(timeRegex);
    let text = trimmed;
    let startMs = lastTimeMs;
    
    if (match) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const hour = match[3] ? parseInt(match[3], 10) : 0;
      
      startMs = ((hour * 3600) + (min * 60) + sec) * 1000;
      lastTimeMs = startMs;
      
      text = trimmed.replace(match[0], '').trim();
      text = text.replace(/^[:\-\s\u2013\u2014]+/, '').trim();
    }
    
    if (text) {
      entries.push({
        text,
        start: startMs / 1000,
        duration: 4000,
        offset: startMs
      });
    }
  });

  for (let i = 0; i < entries.length - 1; i++) {
    entries[i].duration = (entries[i+1].start - entries[i].start) * 1000;
  }
  
  return entries;
}

// ── Fetch transcript entries ──────────────────────────────────────────────────
async function fetchTranscriptEntries(videoId, lang) {
  if (lang === 'gemini') {
    const history = getHistory();
    if (history[videoId] && history[videoId].geminiTranscript) {
      return history[videoId].geminiTranscript;
    }
  }
  const { YoutubeTranscript } = require('youtube-transcript');
  try {
    return await YoutubeTranscript.fetchTranscript(videoId, lang && lang !== 'auto' ? { lang } : {});
  } catch {
    return await YoutubeTranscript.fetchTranscript(videoId);
  }
}

// ── Storyboard Spec Scraper & Helpers ─────────────────────────────────────────
async function fetchStoryboardSpec(videoId) {
  try {
    const fetch = require('node-fetch');
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9'
    };
    const res = await fetch(url, { headers });
    const html = await res.text();
    
    const playerResponseMatch = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});/);
    let playerResponse = null;
    if (playerResponseMatch) {
      try {
        playerResponse = JSON.parse(playerResponseMatch[1]);
      } catch {}
    }
    
    if (!playerResponse) {
      const rawMatch = html.match(/"playerStoryboardSpecRenderer":\s*(\{.+\})/);
      if (rawMatch) {
        try {
          playerResponse = { storyboards: JSON.parse(rawMatch[1]) };
        } catch {}
      }
    }
    
    const storyboards = playerResponse?.storyboards;
    const renderer = storyboards?.playerStoryboardSpecRenderer || storyboards?.playerLiveStoryboardSpecRenderer;
    return renderer?.spec || null;
  } catch (err) {
    console.error('Failed to fetch storyboard spec:', err.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// API ROUTES
// ════════════════════════════════════════════════════════════════════════════════

// ── Fetch Storyboards Spec ────────────────────────────────────────────────────
app.get('/api/storyboards', async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ error: 'videoId is required.' });
  
  try {
    const spec = await fetchStoryboardSpec(videoId);
    if (!spec) {
      return res.status(404).json({ error: 'Storyboard spec not found for this video.' });
    }
    
    const parts = spec.split('|');
    const baseUrlTemplate = parts[0];
    const levels = [];
    for (let i = 1; i < parts.length; i++) {
      const seg = parts[i].split('#');
      if (seg.length < 8) continue;
      
      const w = parseInt(seg[0], 10);
      const h = parseInt(seg[1], 10);
      const count = parseInt(seg[2], 10);
      const cols = parseInt(seg[3], 10);
      const rows = parseInt(seg[4], 10);
      const interval = parseInt(seg[5], 10);
      const prefix = seg[6]; 
      const token = seg[7]; 
      levels.push({ originalLevel: i - 1, w, h, count, cols, rows, interval, prefix, token });
    }
    
    res.json({ baseUrlTemplate, levels });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Storyboard Image CORS Proxy ───────────────────────────────────────────────
app.get('/api/storyboard-proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('url is required.');
  
  try {
    const fetch = require('node-fetch');
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      return res.status(response.status).send(`Failed to fetch storyboard image: ${response.statusText}`);
    }

    res.setHeader('Content-Type', response.headers.get('content-type') || 'image/webp');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    response.body.pipe(res);
  } catch (err) {
    res.status(500).send(err.message);
  }
});


// ── Transcribe using Gemini API ────────────────────────────────────────────────
app.post('/api/transcribe-gemini', async (req, res) => {
  const { videoId, apiKey } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId is required.' });
  if (!apiKey) return res.status(400).json({ error: 'Gemini API key is required.' });

  let audioPath = null;
  let fileUri = null;

  try {
    const videoInfo = await fetchVideoInfo(videoId);
    if (!videoInfo) {
      return res.status(404).json({ error: 'Video not found or unavailable.' });
    }

    audioPath = await downloadYoutubeAudio(videoId);

    const mimeType = 'audio/mp4'; 
    fileUri = await uploadAudioToGemini(audioPath, mimeType, apiKey);

    const rawText = await transcribeAudioWithGemini(fileUri, mimeType, apiKey);

    const entries = parseGeminiTranscriptToEntries(rawText);
    if (entries.length === 0) {
      throw new Error('Could not parse any transcript segments from model response.');
    }

    const history = getHistory();
    history[videoId] = {
      valid: true,
      videoId,
      videoFound: true,
      title: videoInfo.title,
      author: videoInfo.author,
      thumbnail: videoInfo.thumbnail,
      authorIcon: videoInfo.authorIcon || '',
      duration: videoInfo.duration || '',
      transcriptAvailable: true,
      languages: [{ code: 'gemini', name: 'Gemini STT (English/Auto)' }],
      geminiTranscript: entries,
      transcriptError: null
    };
    saveHistory(history);

    res.json(history[videoId]);
  } catch (err) {
    console.error('Gemini STT Error:', err);
    res.status(500).json({ error: 'Transcription failed: ' + err.message });
  } finally {
    if (audioPath && fs.existsSync(audioPath)) {
      try { fs.unlinkSync(audioPath); } catch {}
    }
    if (fileUri) {
      await deleteFileFromGemini(fileUri, apiKey);
    }
  }
});

// ── Single URL check ──────────────────────────────────────────────────────────
app.post('/api/check', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') return res.json({ valid: false, error: 'No URL provided.' });
  const trimmed = url.trim();
  if (!isValidYouTubeUrl(trimmed)) return res.json({ valid: false, error: 'Not a valid YouTube URL.' });
  const videoId = extractVideoId(trimmed);
  if (!videoId) return res.json({ valid: false, error: 'Could not extract video ID from URL.' });
  return res.json(await runTranscriptCheck(videoId));
});

// ── Batch URL check ───────────────────────────────────────────────────────────
app.post('/api/check-batch', async (req, res) => {
  const { urls } = req.body;
  if (!Array.isArray(urls) || urls.length === 0) return res.json({ error: 'No URLs provided.' });
  
  // Load Balancing: Process 5 at a time to prevent overloading API
  const CHUNK = 5;
  const allResults = [];

  for (let i = 0; i < urls.length; i += CHUNK) {
    const chunk = urls.slice(i, i + CHUNK);
    const chunkResults = await Promise.allSettled(
      chunk.map(async (rawUrl) => {
        const url = (rawUrl || '').trim();
        if (!url) return null;
        if (!isValidYouTubeUrl(url)) return { url, valid: false, error: 'Not a valid YouTube URL.' };
        const videoId = extractVideoId(url);
        if (!videoId) return { url, valid: false, error: 'Could not extract video ID.' };
        return { url, ...(await runTranscriptCheck(videoId)) };
      })
    );
    allResults.push(...chunkResults);
    if (i + CHUNK < urls.length) {
      await new Promise(r => setTimeout(r, 500)); // Sleep between chunks
    }
  }

  res.json(allResults.map(r => r.status === 'fulfilled' ? r.value : { valid: false, error: r.reason?.message }).filter(Boolean));
});

// ── InnerTube playlist fetcher (unlimited, paginated) ────────────────────────
function deepFind(obj, key, results = []) {
  if (!obj || typeof obj !== 'object') return results;
  if (Object.prototype.hasOwnProperty.call(obj, key)) results.push(obj[key]);
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') deepFind(v, key, results);
  }
  return results;
}

async function innerTubeBrowse(body) {
  return new Promise((resolve, reject) => {
    const postData = Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname: 'www.youtube.com',
      path: '/youtubei/v1/browse',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': postData.length,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://www.youtube.com',
        'Referer': 'https://www.youtube.com/',
        'X-Youtube-Client-Name': '1',
        'X-Youtube-Client-Version': '2.20260626.01.00',
      }
    }, r => {
      const chunks = [];
      r.on('data', d => chunks.push(d));
      r.on('end', () => {
        try {
          resolve({ status: r.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

const INNERTUBE_CTX = { client: { clientName: 'WEB', clientVersion: '2.20260626.01.00', hl: 'en', gl: 'US' } };

async function fetchPlaylistAllVideos(listId) {
  const allVideos = [];
  let continuationToken = null;
  let title = 'Unknown Playlist';
  let author = '';
  let thumbnail = '';
  let estimatedCount = 0;
  let page = 0;

  do {
    let body;
    if (page === 0) {
      body = { context: INNERTUBE_CTX, browseId: 'VL' + listId };
    } else {
      body = { context: INNERTUBE_CTX, continuation: continuationToken };
    }

    const { status, data } = await innerTubeBrowse(body);
    if (status !== 200) throw new Error(`InnerTube returned status ${status}`);

    // Extract header info on first page
    if (page === 0) {
      const headers = deepFind(data, 'playlistHeaderRenderer');
      if (headers[0]) {
        title = headers[0].title?.simpleText ||
                headers[0].title?.runs?.[0]?.text || title;
        const countRuns = headers[0].numVideosText?.runs;
        if (countRuns) estimatedCount = parseInt(countRuns[0]?.text?.replace(/[^0-9]/g, '')) || 0;
      }
      const metas = deepFind(data, 'playlistMetadataRenderer');
      if (metas[0] && title === 'Unknown Playlist') {
        title = metas[0].title || title;
      }
      // Channel thumbnail
      const thumbs = deepFind(data, 'thumbnailViewModel');
      if (thumbs[0]) thumbnail = thumbs[0].image?.sources?.[0]?.url || '';
    }

    // Extract videos from lockupViewModel (new format) or playlistVideoRenderer (old format)
    const str = JSON.stringify(data);
    const videoIdRe = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
    const lockups = deepFind(data, 'lockupViewModel');

    if (lockups.length > 0) {
      for (const lockup of lockups) {
        const lockupStr = JSON.stringify(lockup);
        const vidMatch = lockupStr.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
        if (!vidMatch) continue;
        const videoId = vidMatch[1];
        if (allVideos.find(v => v.videoId === videoId)) continue; // dedup

        // Extract title from metadata
        const titleContent = lockup.metadata?.lockupMetadataViewModel?.title?.content ||
                             lockup.metadata?.lockupMetadataViewModel?.title?.runs?.[0]?.text || '';
        // Duration from overlay
        let duration = '';
        const durMatch = lockupStr.match(/"text":"(\d+:\d{2}(?::\d{2})?)"/);  
        if (durMatch) duration = durMatch[1];

        allVideos.push({
          videoId,
          title: titleContent || `Video ${videoId}`,
          duration,
          url: `https://www.youtube.com/watch?v=${videoId}`
        });
      }
    } else {
      // Fallback: playlistVideoRenderer (old format)
      const videoRenderers = deepFind(data, 'playlistVideoRenderer');
      for (const v of videoRenderers) {
        if (!v.videoId) continue;
        if (allVideos.find(x => x.videoId === v.videoId)) continue;
        allVideos.push({
          videoId: v.videoId,
          title: v.title?.runs?.[0]?.text || `Video ${v.videoId}`,
          duration: v.lengthText?.simpleText || '',
          url: `https://www.youtube.com/watch?v=${v.videoId}`
        });
      }
    }

    // Find continuation token
    const conts = deepFind(data, 'continuationCommand');
    const nextToken = conts.find(c => c.token);
    continuationToken = nextToken?.token || null;
    page++;

    // Safety limit: max 200 pages (20,000 videos)
    if (page > 200) break;

    // Small delay to be polite
    if (continuationToken) await new Promise(r => setTimeout(r, 150));
  } while (continuationToken);

  return { title, author, thumbnail, estimatedCount: estimatedCount || allVideos.length, videos: allVideos };
}

// ── Playlist info ─────────────────────────────────────────────────────────────
app.post('/api/playlist-info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required.' });

  const listId = extractPlaylistId(url);
  if (!listId) return res.status(400).json({ error: 'No playlist ID found in URL.' });

  try {
    const playlist = await fetchPlaylistAllVideos(listId);
    res.json({
      playlistId: listId,
      title: playlist.title,
      author: playlist.author,
      thumbnail: playlist.thumbnail,
      videoCount: playlist.estimatedCount,
      videos: playlist.videos
    });
  } catch (err) {
    console.error('Playlist error:', err.message);
    res.status(500).json({ error: 'Failed to fetch playlist: ' + err.message });
  }
});

// ── History ───────────────────────────────────────────────────────────────────
app.get('/api/history', (req, res) => {
  const history = getHistory();
  const items = Object.keys(history)
    .filter(k => k !== 'screenshots')
    .map(k => history[k]);
  res.json(items);
});

// ── Download transcript (single format) ──────────────────────────────────────
app.post('/api/download-transcript', async (req, res) => {
  const { videoId, lang, format, targetLang } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId is required.' });
  if (!['txt', 'srt', 'md', 'docx'].includes(format)) return res.status(400).json({ error: 'format must be txt, srt, md or docx.' });

  try {
    const history = getHistory();
    let cached = history[videoId];
    if (!cached) {
      cached = await runTranscriptCheck(videoId);
    }
    const title = cached.title || `Video_${videoId}`;
    const author = cached.author || '';
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    
    const safeTitle = title.replace(/[^a-zA-Z0-9 _\-]/g, '').replace(/\s+/g, '_').substring(0, 60);

    const effectiveTarget = targetLang || 'original';

    if (effectiveTarget === 'all') {
      const JSZip = require('jszip');
      const zip = new JSZip();
      const availableLangs = (cached.languages && cached.languages.length > 0)
        ? cached.languages
        : [{ code: 'original', name: 'Original' }];

      const fetchPromises = availableLangs.map(async (l) => {
        try {
          var langCode = l.code === 'original' ? 'auto' : l.code;
          const entries = await fetchTranscriptEntries(videoId, langCode);
          if (entries && entries.length > 0) {
            const langSuffix = l.code;
            const langLabel = l.name;
            if (format === 'txt') {
              zip.file(`${safeTitle}_${langSuffix}.${format}`, buildTxt(entries));
            } else if (format === 'srt') {
              zip.file(`${safeTitle}_${langSuffix}.${format}`, buildSrt(entries));
            } else if (format === 'md') {
              zip.file(`${safeTitle}_${langSuffix}.${format}`, buildMd(title, author, videoUrl, langLabel, entries));
            } else if (format === 'docx') {
              zip.file(`${safeTitle}_${langSuffix}.${format}`, await buildDocx(title, author, videoUrl, langLabel, entries, cached.chapters || []));
            }
          }
        } catch (err) {
          console.error(`Failed to fetch ${l.code} for video ${videoId}:`, err.message);
        }
      });
      await Promise.all(fetchPromises);

      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="Video_${safeTitle}_All_Languages_${format.toUpperCase()}.zip"`);
      return res.send(zipBuffer);
    }

    let entries = await fetchTranscriptEntries(videoId, lang);
    if (!entries || entries.length === 0) return res.status(404).json({ error: 'No transcript found for this video.' });

    if (effectiveTarget !== 'original') entries = await translateText(entries, effectiveTarget);

    const langLabel = effectiveTarget === 'original' ? 'Original (no translation)' : effectiveTarget.toUpperCase();
    const langLabelName = effectiveTarget === 'original' ? 'Original' : effectiveTarget.toUpperCase();
    const filename = `Video_${safeTitle}_${langLabelName}.${format}`;

    if (format === 'txt') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(buildTxt(entries));
    }
    if (format === 'srt') {
      res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(buildSrt(entries));
    }
    if (format === 'md') {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(buildMd(title, author, videoUrl, langLabel, entries));
    }
    if (format === 'docx') {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(await buildDocx(title, author, videoUrl, langLabel, entries, cached.chapters || []));
    }
  } catch (err) {
    console.error('Download transcript error:', err);
    return res.status(500).json({ error: 'Failed to fetch transcript: ' + err.message });
  }
});

// ── Download ZIP (txt + srt + docx + pdf + thumbnail + metadata) ─────────────
app.post('/api/download-zip', async (req, res) => {
  const { videoId, lang, targetLang, destPath } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId is required.' });

  try {
    const JSZip = require('jszip');
    const fetch = require('node-fetch');

    const history = getHistory();
    let cached = history[videoId];
    if (!cached) {
      cached = await runTranscriptCheck(videoId);
    }
    const title = cached.title || `Video_${videoId}`;
    const author = cached.author || '';
    const authorIcon = cached.authorIcon || '';
    const thumbnailUrl = cached.thumbnail || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const safeTitle = title.replace(/[^a-zA-Z0-9 _\-]/g, '').replace(/\s+/g, '_').substring(0, 55);

    const effectiveTarget = targetLang || 'original';

    // Fetch thumbnail image
    let thumbnailBuffer = null;
    try {
      const thumbRes = await fetch(thumbnailUrl);
      if (thumbRes.ok) thumbnailBuffer = await thumbRes.buffer();
    } catch {}

    const zip = new JSZip();
    const folder = zip.folder(safeTitle);
      


    if (effectiveTarget === 'all') {
      const availableLangs = (cached.languages && cached.languages.length > 0)
        ? cached.languages
        : [{ code: 'original', name: 'Original' }];

      let totalCaptionsCount = 0;
      for (const l of availableLangs) {
        try {
          var langCode = l.code === 'original' ? 'auto' : l.code;
          let entries = await fetchTranscriptEntries(videoId, langCode);
          if (!entries || entries.length === 0) continue;

          totalCaptionsCount += entries.length;
          const langLabel = l.name;
          const langSuffix = l.code;

          const [txtContent, srtContent, mdContent, docxBuffer, pdfBuffer] = await Promise.all([
            Promise.resolve(buildTxt(entries, cached.chapters || [])),
            Promise.resolve(buildSrt(entries)),
            Promise.resolve(buildMd(title, author, videoUrl, langLabel, entries, cached.chapters || [])),
            buildDocx(title, author, videoUrl, langLabel, entries, cached.chapters || []),
            buildPdf(title, author, videoUrl, langLabel, entries, cached.chapters || []),
          ]);

          const langFolder = folder.folder(langLabel);
          langFolder.file(`${safeTitle}_${langSuffix}.txt`, txtContent);
          langFolder.file(`${safeTitle}_${langSuffix}.srt`, srtContent);
          langFolder.file(`${safeTitle}_${langSuffix}.md`, mdContent);
          langFolder.file(`${safeTitle}_${langSuffix}.docx`, docxBuffer);
          langFolder.file(`${safeTitle}_${langSuffix}.pdf`, pdfBuffer);
        } catch (err) {
          console.error(`Failed to build formats for ${l.code} of ${videoId}:`, err.message);
        }
      }

      const metadata = {
        videoId,
        title,
        channel: author,
        channelIcon: authorIcon,
        videoUrl,
        thumbnail: thumbnailUrl,
        transcriptLanguage: 'ALL AVAILABLE LANGUAGES',
        captionCount: totalCaptionsCount,
        generatedAt: new Date().toISOString(),
        exportDate: new Date().toISOString(),
  chapters: cached?.chapters || history[videoId]?.chapters || []
};

  const aiChunksExp = {
    videoId, title, chapters: cached?.chapters || history[videoId]?.chapters || [],
    chunks: entries.map((e,i) => ({ start: getSeconds(e,i), text: e.text }))
  };
  try {
     // If folder exists (download-zip route)
     if (typeof folder !== 'undefined') folder.file(safeTitle + '_ai_chunks.json', JSON.stringify(aiChunksExp, null, 2));
     // If langFolder exists (batch zip route)
     else if (typeof langFolder !== 'undefined') langFolder.file(`${safeTitle}_${langSuffix}_ai_chunks.json`, JSON.stringify(aiChunksExp, null, 2));
     // If zip exists (batch single route)
     else if (typeof zip !== 'undefined') zip.file(`${safeTitle}_${langSuffix}_ai_chunks.json`, JSON.stringify(aiChunksExp, null, 2));
  } catch(e) {}

      folder.file('metadata.json', JSON.stringify(metadata, null, 2));
      if (thumbnailBuffer) folder.file('thumbnail.jpg', thumbnailBuffer);
      const cachedShot = consumeScreenshot(videoId);
      if (cachedShot) folder.file(`input_screenshot${cachedShot.ext}`, cachedShot.buf);

      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.zip"`);
      return res.send(zipBuffer);
    }

    // Fetch transcript
    let entries = await fetchTranscriptEntries(videoId, lang);
    if (!entries || entries.length === 0) return res.status(404).json({ error: 'No transcript found for this video.' });

    if (effectiveTarget !== 'original') entries = await translateText(entries, effectiveTarget);

    const langSuffix = effectiveTarget === 'original' ? 'orig' : effectiveTarget;
    const langLabel = effectiveTarget === 'original' ? 'Original (no translation)' : effectiveTarget.toUpperCase();

    // Generate all formats in parallel
    const [txtContent, srtContent, mdContent, docxBuffer, pdfBuffer] = await Promise.all([
      Promise.resolve(buildTxt(entries, cached.chapters || [])),
      Promise.resolve(buildSrt(entries)),
      Promise.resolve(buildMd(title, author, videoUrl, langLabel, entries, cached.chapters || [])),
      buildDocx(title, author, videoUrl, langLabel, entries, cached.chapters || []),
      buildPdf(title, author, videoUrl, langLabel, entries, cached.chapters || []),
    ]);

    const metadata = {
      videoId,
      title,
      channel: author,
      channelIcon: authorIcon,
      videoUrl,
      thumbnail: thumbnailUrl,
      transcriptLanguage: langLabel,
      captionCount: entries.length,
      generatedAt: new Date().toISOString(),
        exportDate: new Date().toISOString(),
  chapters: cached?.chapters || history[videoId]?.chapters || []
};

  const aiChunksExp = {
    videoId, title, chapters: cached?.chapters || history[videoId]?.chapters || [],
    chunks: entries.map((e,i) => ({ start: getSeconds(e,i), text: e.text }))
  };
  try {
     // If folder exists (download-zip route)
     if (typeof folder !== 'undefined') folder.file(safeTitle + '_ai_chunks.json', JSON.stringify(aiChunksExp, null, 2));
     // If langFolder exists (batch zip route)
     else if (typeof langFolder !== 'undefined') langFolder.file(`${safeTitle}_${langSuffix}_ai_chunks.json`, JSON.stringify(aiChunksExp, null, 2));
     // If zip exists (batch single route)
     else if (typeof zip !== 'undefined') zip.file(`${safeTitle}_${langSuffix}_ai_chunks.json`, JSON.stringify(aiChunksExp, null, 2));
  } catch(e) {}


    folder.file(`${safeTitle}_${langSuffix}.txt`,  txtContent);
    folder.file(`${safeTitle}_${langSuffix}.srt`,  srtContent);
    folder.file(`${safeTitle}_${langSuffix}.md`,   mdContent);
    folder.file(`${safeTitle}_${langSuffix}.docx`, docxBuffer);
    folder.file(`${safeTitle}_${langSuffix}.pdf`,  pdfBuffer);
    folder.file('metadata.json', JSON.stringify(metadata, null, 2));
    if (thumbnailBuffer) folder.file('thumbnail.jpg', thumbnailBuffer);
    // Include the user's uploaded screenshot if it was used to find this video
    const cachedShot = consumeScreenshot(videoId);
    if (cachedShot) folder.file(`input_screenshot${cachedShot.ext}`, cachedShot.buf);

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });

    const langLabelName = effectiveTarget === 'original' ? 'Original' : effectiveTarget.toUpperCase();
    const filename = `${safeTitle}.zip`;
    
    if (destPath) {
      const fs = require('fs');
      const path = require('path');
      if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
      const fullPath = path.join(destPath, filename);
      fs.writeFileSync(fullPath, zipBuffer);
      return res.json({ success: true, path: fullPath });
    }
    
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(zipBuffer);
  } catch (err) {
    console.error('ZIP download error:', err);
    res.status(500).json({ error: 'Failed to create ZIP: ' + err.message });
  }
});

// ── Download Batch Helper ────────────────────────────────────────────────────
function buildLogsText(logEntries, title, isPlaylist, targetLang) {
  const lines = [
    `==================================================`,
    ` YouTube Transcript Checker - Download Logs & Summary`,
    `==================================================`,
    `Generated on   : ${new Date().toUTCString()}`,
    `Type           : ${isPlaylist ? 'Playlist' : 'Batch Links'}`,
    `Name/Title     : ${title || 'N/A'}`,
    `Target Language: ${targetLang === 'original' ? 'Original' : (targetLang === 'all' ? 'All Available' : targetLang.toUpperCase())}`,
    ``,
    `--------------------------------------------------`,
    ` Processing Summary`,
    `--------------------------------------------------`,
  ];

  let successCount = 0;
  let failedCount = 0;

  logEntries.forEach((entry, i) => {
    if (!entry) return;
    if (entry.status === 'SUCCESS') successCount++;
    else failedCount++;

    lines.push(`[${i + 1}] Video ID : ${entry.videoId}`);
    lines.push(`    Title    : ${entry.title || 'N/A'}`);
    lines.push(`    Status   : ${entry.status}`);
    if (entry.status === 'SUCCESS') {
      lines.push(`    Languages: ${entry.sourceLang || 'N/A'}`);
      lines.push(`    Details  : ${entry.details}`);
    } else {
      lines.push(`    Reason   : ${entry.error || 'Unknown error'}`);
    }
    lines.push(``);
  });

  lines.push(`--------------------------------------------------`);
  lines.push(`Total Processed: ${logEntries.length}`);
  lines.push(`Success        : ${successCount}`);
  lines.push(`Failed         : ${failedCount}`);
  lines.push(`==================================================`);

  return lines.join('\n');
}

// ── Download Batch (ZIP of txt/srt files, or folders of all formats) ─────────
app.post('/api/download-batch', async (req, res) => {
  try { if (req.body.destPath) checkCloudPathGuard(req.body.destPath); } catch(e) { return res.status(400).json({ error: e.message }); }
  const { items, format, targetLang, isPlaylist, playlistTitle } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items array is required and must not be empty.' });
  }
  if (!['txt', 'srt', 'md', 'docx', 'zip'].includes(format)) {
    return res.status(400).json({ error: 'format must be txt, srt, md, docx, or zip.' });
  }

  try {
    const JSZip = require('jszip');
    const fetch = require('node-fetch');
    const zip = new JSZip();

    const effectiveTarget = targetLang || 'original';
    const history = getHistory();

    const logEntries = new Array(items.length);
    const playlistMetadata = new Array(items.length);
    const allThumbnailsFolder = format === 'zip' ? zip.folder('All_Thumbnails') : null;

    const fetchPromises = items.map(async (item, idx) => {
      const { videoId, lang } = item;
      if (!videoId) return;

      try {
        let cached = history[videoId];
        if (!cached) cached = await runTranscriptCheck(videoId);

        const title = cached.title || `Video_${videoId}`;
        const author = cached.author || '';
        const authorIcon = cached.authorIcon || '';
        const thumbnailUrl = cached.thumbnail || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const safeTitle = title.replace(/[^a-zA-Z0-9 _\-]/g, '').replace(/\s+/g, '_').substring(0, 55);

        // Fetch thumbnail image
        let thumbnailBuffer = null;
        try {
          const thumbRes = await fetch(thumbnailUrl);
          if (thumbRes.ok) thumbnailBuffer = await thumbRes.buffer();
        } catch {}

        if (thumbnailBuffer && allThumbnailsFolder) {
          allThumbnailsFolder.file(`${safeTitle}.jpg`, thumbnailBuffer);
        }

        if (effectiveTarget === 'all') {
          const availableLangs = (cached.languages && cached.languages.length > 0)
            ? cached.languages
            : [{ code: 'original', name: 'Original' }];

          if (format === 'zip') {
            const subFolder = zip.folder(safeTitle);
            let totalCaptionsCount = 0;

            for (const l of availableLangs) {
              try {
                var langCode = l.code === 'original' ? 'auto' : l.code;
                let entries = await fetchTranscriptEntries(videoId, langCode);
                if (!entries || entries.length === 0) continue;

                totalCaptionsCount += entries.length;
                const langLabel = l.name;
                const langSuffix = l.code;

                const [txtContent, srtContent, mdContent, docxBuffer, pdfBuffer] = await Promise.all([
                  Promise.resolve(buildTxt(entries, cached.chapters || [])),
                  Promise.resolve(buildSrt(entries)),
                  Promise.resolve(buildMd(title, author, videoUrl, langLabel, entries, cached.chapters || [])),
                  buildDocx(title, author, videoUrl, langLabel, entries, cached.chapters || []),
                  buildPdf(title, author, videoUrl, langLabel, entries, cached.chapters || []),
                ]);

                const langFolder = subFolder.folder(langLabel);
                

                langFolder.file(`${safeTitle}_${langSuffix}.txt`,  txtContent);
                langFolder.file(`${safeTitle}_${langSuffix}.srt`,  srtContent);
                langFolder.file(`${safeTitle}_${langSuffix}.md`,   mdContent);
                langFolder.file(`${safeTitle}_${langSuffix}.docx`, docxBuffer);
                langFolder.file(`${safeTitle}_${langSuffix}.pdf`,  pdfBuffer);
              } catch (err) {
                console.error(`Failed to build batch format for ${l.code} of ${videoId}:`, err.message);
              }
            }

            const metadata = {
              videoId,
              title,
              channel: author,
              channelIcon: authorIcon,
              videoUrl,
              thumbnail: thumbnailUrl,
              transcriptLanguage: 'ALL AVAILABLE LANGUAGES',
              captionCount: totalCaptionsCount,
              generatedAt: new Date().toISOString(),
        exportDate: new Date().toISOString(),
  chapters: cached?.chapters || history[videoId]?.chapters || []
};

  const aiChunksExp = {
    videoId, title, chapters: cached?.chapters || history[videoId]?.chapters || [],
    chunks: entries.map((e,i) => ({ start: getSeconds(e,i), text: e.text }))
  };
  try {
     // If folder exists (download-zip route)
     if (typeof folder !== 'undefined') folder.file(safeTitle + '_ai_chunks.json', JSON.stringify(aiChunksExp, null, 2));
     // If langFolder exists (batch zip route)
     else if (typeof langFolder !== 'undefined') langFolder.file(`${safeTitle}_${langSuffix}_ai_chunks.json`, JSON.stringify(aiChunksExp, null, 2));
     // If zip exists (batch single route)
     else if (typeof zip !== 'undefined') zip.file(`${safeTitle}_${langSuffix}_ai_chunks.json`, JSON.stringify(aiChunksExp, null, 2));
  } catch(e) {}

            subFolder.file('metadata.json', JSON.stringify(metadata, null, 2));

            if (thumbnailBuffer) subFolder.file('thumbnail.jpg', thumbnailBuffer);

            const batchShot = consumeScreenshot(videoId);
            if (batchShot) subFolder.file(`input_screenshot${batchShot.ext}`, batchShot.buf);

            logEntries[idx] = {
              videoId,
              title,
              status: 'SUCCESS',
              sourceLang: availableLangs.map(l => l.name).join(', '),
              details: 'All formats ZIP (all available languages)'
            };
            playlistMetadata[idx] = {
              videoId,
              title,
              channel: author,
              videoUrl,
              thumbnail: thumbnailUrl,
              status: 'SUCCESS'
            };
          } else {
            let successLangs = [];
            for (const l of availableLangs) {
              try {
                var langCode = l.code === 'original' ? 'auto' : l.code;
                const entries = await fetchTranscriptEntries(videoId, langCode);
                if (entries && entries.length > 0) {
                  successLangs.push(l.name);
                  const langSuffix = l.code;
                  const langLabel = l.name;
                  if (format === 'txt') {
                    zip.file(`${safeTitle}_${langSuffix}.txt`, buildTxt(entries));
                  } else if (format === 'srt') {
                    zip.file(`${safeTitle}_${langSuffix}.srt`, buildSrt(entries));
                  } else if (format === 'md') {
                    zip.file(`${safeTitle}_${langSuffix}.md`, buildMd(title, author, videoUrl, langLabel, entries));
                  } else if (format === 'docx') {
                    zip.file(`${safeTitle
                    
}_${langSuffix}.docx`, await buildDocx(title, author, videoUrl, langLabel, entries, cached.chapters || []));
                  }
                }
              } catch (err) {
                console.error(`Failed to fetch batch transcript ${l.code} for ${videoId}:`, err.message);
              }
            }
            if (successLangs.length > 0) {
              logEntries[idx] = {
                videoId,
                title,
                status: 'SUCCESS',
                sourceLang: successLangs.join(', '),
                details: `All available languages in format: ${format.toUpperCase()}`
              };
              playlistMetadata[idx] = {
                videoId,
                title,
                channel: author,
                videoUrl,
                thumbnail: thumbnailUrl,
                status: 'SUCCESS'
              };
            } else {
              throw new Error('No transcripts available for any language.');
            }
          }
          return;
        }

        // Fetch transcript entries
        let entries = await fetchTranscriptEntries(videoId, lang);
        if (!entries || entries.length === 0) throw new Error('No transcripts found for this video.');

        if (effectiveTarget !== 'original') {
          entries = await translateText(entries, effectiveTarget);
        }

        const langSuffix = effectiveTarget === 'original' ? 'orig' : effectiveTarget;
        const langLabel = effectiveTarget === 'original' ? 'Original (no translation)' : effectiveTarget.toUpperCase();

        if (format === 'txt') {
          const txtContent = buildTxt(entries);
          zip.file(`${safeTitle}_${langSuffix}.txt`, txtContent);
        } else if (format === 'srt') {
          const srtContent = buildSrt(entries);
          zip.file(`${safeTitle}_${langSuffix}.srt`, srtContent);
        } else if (format === 'md') {
          const mdContent = buildMd(title, author, videoUrl, langLabel, entries);
          zip.file(`${safeTitle}_${langSuffix}.md`, mdContent);
        } else if (format === 'docx') {
          const docxContent = await buildDocx(title, author, videoUrl, langLabel, entries, cached.chapters || []);
          zip.file(`${safeTitle}_${langSuffix}.docx`, docxContent);
        } else if (format === 'zip') {
          // Build txt, srt, md, docx, pdf
          const [txtContent, srtContent, mdContent, docxBuffer, pdfBuffer] = await Promise.all([
            Promise.resolve(buildTxt(entries, cached.chapters || [])),
            Promise.resolve(buildSrt(entries)),
            Promise.resolve(buildMd(title, author, videoUrl, langLabel, entries, cached.chapters || [])),
            buildDocx(title, author, videoUrl, langLabel, entries, cached.chapters || []),
            buildPdf(title, author, videoUrl, langLabel, entries, cached.chapters || []),
          ]);

          const metadata = {
            videoId,
            title,
            channel: author,
            channelIcon: authorIcon,
            videoUrl,
            thumbnail: thumbnailUrl,
            transcriptLanguage: langLabel,
            captionCount: entries.length,
            generatedAt: new Date().toISOString(),
        exportDate: new Date().toISOString(),
  chapters: cached?.chapters || history[videoId]?.chapters || []
};

  const aiChunksExp = {
    videoId, title, chapters: cached?.chapters || history[videoId]?.chapters || [],
    chunks: entries.map((e,i) => ({ start: getSeconds(e,i), text: e.text }))
  };
  try {
     // If folder exists (download-zip route)
     if (typeof folder !== 'undefined') folder.file(safeTitle + '_ai_chunks.json', JSON.stringify(aiChunksExp, null, 2));
     // If langFolder exists (batch zip route)
     else if (typeof langFolder !== 'undefined') langFolder.file(`${safeTitle}_${langSuffix}_ai_chunks.json`, JSON.stringify(aiChunksExp, null, 2));
     // If zip exists (batch single route)
     else if (typeof zip !== 'undefined') zip.file(`${safeTitle}_${langSuffix}_ai_chunks.json`, JSON.stringify(aiChunksExp, null, 2));
  } catch(e) {}


          const subFolder = zip.folder(safeTitle);
          subFolder.file(`${safeTitle}_${langSuffix}.txt`,  txtContent);
          subFolder.file(`${safeTitle}_${langSuffix}.srt`,  srtContent);
          subFolder.file(`${safeTitle}_${langSuffix}.md`,   mdContent);
          subFolder.file(`${safeTitle}_${langSuffix}.docx`, docxBuffer);
          subFolder.file(`${safeTitle}_${langSuffix}.pdf`,  pdfBuffer);
          subFolder.file('metadata.json', JSON.stringify(metadata, null, 2));
          if (thumbnailBuffer) subFolder.file('thumbnail.jpg', thumbnailBuffer);
          // Include user's screenshot if this video was found via screenshot upload
          const batchShot = consumeScreenshot(videoId);
          if (batchShot) subFolder.file(`input_screenshot${batchShot.ext}`, batchShot.buf);
        }

        logEntries[idx] = {
          videoId,
          title,
          status: 'SUCCESS',
          sourceLang: langLabel,
          details: format === 'zip' ? 'All formats single ZIP' : `Format: ${format.toUpperCase()}`
        };
        playlistMetadata[idx] = {
          videoId,
          title,
          channel: author,
          videoUrl,
          thumbnail: thumbnailUrl,
          status: 'SUCCESS'
        };
      } catch (itemErr) {
        console.error(`Error processing video ${videoId} in batch:`, itemErr.message);
        logEntries[idx] = {
          videoId,
          status: 'FAILED',
          error: itemErr.message
        };
        playlistMetadata[idx] = {
          videoId,
          status: 'FAILED',
          error: itemErr.message
        };
      }
    });

    await Promise.all(fetchPromises);

    // Save download summary logs
    const logsContent = buildLogsText(logEntries, playlistTitle || 'Batch Export', isPlaylist, targetLang);
    zip.file('download_summary_logs.txt', logsContent);

    // Save metadata json file
    const masterMetadata = {
      title: playlistTitle || 'Batch Export',
      type: isPlaylist ? 'playlist' : 'batch',
      exportedAt: new Date().toISOString(),
      targetLanguage: targetLang,
      format,
      totalVideos: items.length,
      successCount: logEntries.filter(e => e && e.status === 'SUCCESS').length,
      failedCount: logEntries.filter(e => e && e.status === 'FAILED').length,
      videos: playlistMetadata.filter(Boolean)
    };
    zip.file('playlist_metadata.json', JSON.stringify(masterMetadata, null, 2));

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    
    const langLabelName = effectiveTarget === 'original' ? 'Original' : (effectiveTarget === 'all' ? 'All_Languages' : effectiveTarget.toUpperCase());
    const formatLabelName = format === 'zip' ? 'All_Formats_Master' : format.toUpperCase();
    
    let zipFilename;
    if (isPlaylist) {
      const safeTitleName = (playlistTitle || 'Playlist').replace(/[^a-zA-Z0-9 _\-]/g, '').replace(/\s+/g, '_').substring(0, 50);
      zipFilename = `Playlist_${safeTitleName}_${langLabelName}_${formatLabelName}.zip`;
    } else if (items.length === 1) {
      const firstValid = playlistMetadata.find(m => m && m.title);
      if (firstValid) {
        const safeSingleTitle = firstValid.title.replace(/[^a-zA-Z0-9 _\-]/g, '').replace(/\s+/g, '_').substring(0, 50);
        zipFilename = `${safeSingleTitle}.zip`;
      } else {
        zipFilename = `Unknown.zip`;
      }
    } else {
      const now = new Date();
      const datePart = now.toISOString().split('T')[0];
      const timePart = String(now.getHours()).padStart(2, '0') + '-' + String(now.getMinutes()).padStart(2, '0') + '-' + String(now.getSeconds()).padStart(2, '0');
      zipFilename = `Combine_Download_${datePart}_${timePart}.zip`;
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);
    res.send(zipBuffer);
  } catch (err) {
    console.error('Batch ZIP download error:', err);
    res.status(500).json({ error: 'Failed to create batch ZIP: ' + err.message });
  }
});

// ── OCR text cleaner ─────────────────────────────────────────────────────────
// Returns { primary, secondary } where:
//   primary  = mixed-case lines (video title / channel name area below thumbnail)
//   secondary = all-caps lines (thumbnail artwork text — large bold text on image)
// We search with primary first; fall back to secondary if primary fails.
function cleanOcrTextToQuery(rawText) {
  if (!rawText) return { primary: '', secondary: '' };

  const noise = (line) => line
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/gi, '')
    .replace(/\b\d[\.\d]*[kKmM]?\s+views?\b/gi, '')
    .replace(/\b\d+\s+(day|week|month|year|hour|min)s?\s+ago\b/gi, '')
    .replace(/\b\d{1,3}%\b/g, '')
    .replace(/\b(?:Sponsored|Ad|Install|Visit site|Ask about this video|LTE|5G|4G|AM|PM|Volte)\b/gi, '')
    .replace(/[^\w\s'"\-:.!?,&]/g, ' ')
    .replace(/\s+/g, ' ').trim();

  const lines = rawText.split(/[\r\n]+/);
  const allCapsLines   = [];
  const mixedCaseLines = [];

  for (const line of lines) {
    if (/(?:Sponsored|Visit site|Install|Ask about this video|\d{1,3}%|LTE|5G|Volte)/i.test(line)) continue;
    const cleaned = noise(line);
    if (cleaned.length < 3) continue;
    if (/^[\d\s\-_.:,;+*&%$#@!^()\'"]+$/.test(cleaned)) continue;
    
    if (/[a-z]/.test(cleaned)) {
      mixedCaseLines.push(cleaned);
    } else {
      allCapsLines.push(cleaned);
    }
  }

  mixedCaseLines.sort((a, b) => b.length - a.length);
  allCapsLines.sort((a, b) => b.length - a.length);

  const mixedQuery = mixedCaseLines.slice(0, 2).join(' ').trim();
  const watermark   = allCapsLines.find(l => l.split(/\s+/).length <= 2) || '';
  const primary     = (mixedQuery + (watermark ? ' ' + watermark : '')).trim();
  
  const secondary   = allCapsLines.slice(0, 3).join(' ').trim();

  return { primary, secondary };
}

// ── Screenshot OCR check ──────────────────────────────────────────────────────
// Score a search result video against raw OCR text
function parseDurationSeconds(durStr) {
  if (!durStr) return 0;
  const parts = durStr.split(':').map(Number).reverse();
  let secs = 0;
  if (parts[0]) secs += parts[0];
  if (parts[1]) secs += parts[1] * 60;
  if (parts[2]) secs += parts[2] * 3600;
  return secs;
}

function scoreVideoAgainstOcr(video, ocrText) {
  const textLower = ocrText.toLowerCase();
  let score = 0;

  // Channel name in OCR? (+20)
  const author = (video.channelTitle || '').toLowerCase();
  if (author && textLower.includes(author)) score += 20;

  // Exact duration visible in OCR? (+50 - Massive bonus)
  const dur = video.length?.simpleText || '';
  if (dur && textLower.includes(dur)) score += 50;

  // Duration proximity check (Penalty for mismatch)
  const ocrDurMatch = ocrText.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
  if (ocrDurMatch && dur) {
    const ocrSecs = parseDurationSeconds(ocrDurMatch[1]);
    const vidSecs = parseDurationSeconds(dur);
    const diff = Math.abs(ocrSecs - vidSecs);
    if (diff > 300) score -= 30; // -30 penalty if more than 5 minutes off
    else if (diff <= 300 && diff > 0) score += (10 - (diff / 30)); // up to +10 for being close
  }

  // Title word-overlap with OCR text (+0..10)
  const title = video.translatedTitle || video.title || '';
  if (title) {
    const titleWords = title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    let matched = 0;
    for (const w of titleWords) { if (textLower.includes(w)) matched++; }
    if (titleWords.length > 0) score += (matched / titleWords.length) * 10;
  }

  // Bonus: any individual title word >=5 chars found verbatim in OCR (+2 per word, max 6)
  const titleWords5 = (title).toLowerCase().split(/\s+/).filter(w => w.length >= 5);
  let bonus = 0;
  for (const w of titleWords5) { if (textLower.includes(w)) bonus += 2; if (bonus >= 6) break; }
  score += bonus;

  return score;
}

async function processScreenshotCore(filePath, fileExt, fileHash, isConfirmed) {
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
    const rawWords = text.replace(/[^\w\s']/g, ' ').split(/\s+/).filter(w => w.length >= 5).slice(0, 8).join(' ');
    
    let smartQuery = [primary, secondary].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().substring(0, 100);
    const queries = smartQuery.length > 5 ? [smartQuery] : [rawWords];
    
    const YTSearch = require('youtube-search-api');
    let bestVideo = null;
    let highestScore = 0;

    for (const q of queries) {
      try {
        let videos = [];
        // Directly search the query to save API limits (prevent 429 errors)
        const results = await YTSearch.GetListByKeyword(q, false, 30);
        videos = (results?.items || []).filter(i => i.type === 'video' || !i.type);
        
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

app.post('/api/check-screenshot', (req, res, next) => { console.log('Incoming check-screenshot req'); next(); }, upload.single('screenshot'), async (req, res) => { console.log('Received check-screenshot request');
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


// "? Report Success/Match
app.post('/api/report-match', (req, res) => {
  try {
    const { fileHash, videoId } = req.body;
    let matches = [];
    if (fs.existsSync('matches.json')) {
      matches = JSON.parse(fs.readFileSync('matches.json', 'utf8'));
    }
    matches.push({ fileHash, videoId, reportedAt: new Date().toISOString() });
    fs.writeFileSync('matches.json', JSON.stringify(matches, null, 2)); uploadToGDrive("matches.json");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

// ── Start ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  
// Visual ZIP Builder (DOCX + PDF + Storyboards)
app.post('/api/build-visual-zip', async (req, res) => {
  const { videoId, targetLang, frames } = req.body;
  
  if (!videoId || !frames || !Array.isArray(frames)) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  try {
    const history = getHistory();
    let cached = history[videoId];
    if (!cached) cached = await runTranscriptCheck(videoId);
    
    const title = cached.title || `Video_${videoId}`;
      const author = cached.author || 'Unknown';
      const safeTitle = title.replace(/[^a-zA-Z0-9 _\-]/g, '').replace(/\s+/g, '_').substring(0, 55);

    // 1. Fetch Transcripts
    let transcriptEntries = [];
    try {
      var langCode = (targetLang && targetLang !== 'original') ? targetLang : 'auto';
      transcriptEntries = await fetchTranscriptEntries(videoId, langCode);
    } catch(e) {}
    
    // Group transcripts by frame timestamps to embed
    // We will find the closest frame for every 30-60 second block, or exactly match it.
    
    const JSZip = require('jszip');
    const zip = new JSZip();
    
    const rootFolder = zip.folder(safeTitle);
    const sbFolder = rootFolder.folder('Storyboards');
    
    // 2. Put raw images in Storyboards folder
    const frameMap = {}; // fast lookup
    for (const f of frames) {
      sbFolder.file(`${f.time}.jpg`, f.b64, { base64: true });
      frameMap[f.time] = f.b64;
    }

    
    const langSuffix = langCode;
    const langLabel = langCode;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Standard formats
    rootFolder.file(`${safeTitle}_${langSuffix}.txt`, buildTxt(transcriptEntries));
    rootFolder.file(`${safeTitle}_${langSuffix}.srt`, buildSrt(transcriptEntries));
    rootFolder.file(`${safeTitle}_${langSuffix}.md`, buildMd(title, author, videoUrl, langLabel, transcriptEntries));
    rootFolder.file(`${safeTitle}_${langSuffix}.docx`, await buildDocx(title, author, videoUrl, langLabel, transcriptEntries, cached.chapters || []));

    // Metadata & AI chunks
    const metadata = {
        videoId, title, author, url: videoUrl,
        duration: cached.duration || '',
        thumbnail: cached.thumbnail || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
        exportDate: new Date().toISOString(),
        chapters: cached.chapters || []
    };
    rootFolder.file(`metadata.json`, JSON.stringify(metadata, null, 2));

    const aiChunksExp = {
        videoId, title, chapters: cached.chapters || [],
        chunks: transcriptEntries.map((e,i) => ({ start: getSeconds(e,i), text: e.text }))
    };
    rootFolder.file(`${safeTitle}_${langSuffix}_ai_chunks.json`, JSON.stringify(aiChunksExp, null, 2));


    // 3. Build Markdown (Visual)
    let mdContent = `# ${title}\n\n`;
    if (cached.chapters && cached.chapters.length > 0) {
      mdContent += `## Chapters\n`;
      cached.chapters.forEach(c => mdContent += `- ${c.time} - ${c.title}\n`);
      mdContent += '\n';
    }
    
    let currentFrameIdx = 0;
    for (let i = 0; i < transcriptEntries.length; i++) {
        const entry = transcriptEntries[i];
        const sec = getSeconds(entry, i);
        
        // Find if any frame matches this exact second window
        while (currentFrameIdx < frames.length) {
            const f = frames[currentFrameIdx];
            const fSecs = f.time.split('_').reduce((acc, time) => (60 * acc) + +time, 0);
            
            if (fSecs <= sec + 5 && fSecs >= sec - 15) { // If frame is within window
                mdContent += `\n\n![${f.time}](./Storyboards/${f.time}.jpg)\n\n`;
                currentFrameIdx++;
                break;
            } else if (fSecs < sec - 15) {
                currentFrameIdx++;
            } else {
                break; // Frame is too far in the future
            }
        }
        
        mdContent += `[${formatTimestamp(sec)}] ${entry.text}\n`;
    }
    rootFolder.file(`${safeTitle}_Visual.md`, mdContent);

    // 4. Build PDF (Visual)
    const PDFDocument = require('pdfkit');
    const pdfDoc = new PDFDocument({ autoFirstPage: true });
    const pdfBuffers = [];
    pdfDoc.on('data', chunk => pdfBuffers.push(chunk));
    
    pdfDoc.fontSize(18).text(title, { align: 'center' }).moveDown();
    if (cached.chapters && cached.chapters.length > 0) {
       pdfDoc.fontSize(14).text('Chapters').fontSize(10);
       cached.chapters.forEach(c => pdfDoc.text(`${c.time} - ${c.title}`));
       pdfDoc.moveDown();
    }
    
    currentFrameIdx = 0;
    pdfDoc.fontSize(10);
    for (let i = 0; i < transcriptEntries.length; i++) {
        const entry = transcriptEntries[i];
        const sec = getSeconds(entry, i);
        
        while (currentFrameIdx < frames.length) {
            const f = frames[currentFrameIdx];
            const fSecs = f.time.split('_').reduce((acc, time) => (60 * acc) + +time, 0);
            
            if (fSecs <= sec + 5 && fSecs >= sec - 15) { 
                pdfDoc.moveDown();
                try {
                    const imgBuffer = Buffer.from(f.b64, 'base64');
                    // Fit image to PDF width
                    pdfDoc.image(imgBuffer, { width: 450, align: 'center' });
                    pdfDoc.moveDown();
                } catch(e) { console.error('PDF image error', e); }
                currentFrameIdx++;
                break;
            } else if (fSecs < sec - 15) {
                currentFrameIdx++;
            } else {
                break;
            }
        }
        pdfDoc.text(`[${formatTimestamp(sec)}] ${entry.text}`);
    }
    
    pdfDoc.end();
    
    // 5. Build DOCX (Visual)
    const docx = require('docx');
    const { Document, Packer, Paragraph, TextRun, ImageRun } = docx;
    const docChildren = [];
    
    docChildren.push(new Paragraph({ children: [new TextRun({ text: title, bold: true, size: 36 })] }));
    
    currentFrameIdx = 0;
    for (let i = 0; i < transcriptEntries.length; i++) {
        const entry = transcriptEntries[i];
        const sec = getSeconds(entry, i);
        
        while (currentFrameIdx < frames.length) {
            const f = frames[currentFrameIdx];
            const fSecs = f.time.split('_').reduce((acc, time) => (60 * acc) + +time, 0);
            
            if (fSecs <= sec + 5 && fSecs >= sec - 15) { 
                try {
                    const imgBuffer = Buffer.from(f.b64, 'base64');
                    docChildren.push(new Paragraph({
                        children: [
                            new ImageRun({
                                data: imgBuffer,
                                transformation: { width: 500, height: 281 }, // 16:9 ratio approximation for standard page
                            })
                        ]
                    }));
                } catch(e) { console.error('DOCX image error', e); }
                currentFrameIdx++;
                break;
            } else if (fSecs < sec - 15) {
                currentFrameIdx++;
            } else {
                break;
            }
        }
        
        docChildren.push(new Paragraph({
            children: [
                new TextRun({ text: `[${formatTimestamp(sec)}] `, bold: true }),
                new TextRun({ text: entry.text })
            ]
        }));
    }
    
    const doc = new Document({ sections: [{ properties: {}, children: docChildren }] });
    const docxBuffer = await Packer.toBuffer(doc);
    rootFolder.file(`${safeTitle}_Visual.docx`, docxBuffer);
    
    // Wait for PDF to finish
    await new Promise(r => setTimeout(r, 500)); // give streams time
    const pdfResult = Buffer.concat(pdfBuffers);
    rootFolder.file(`${safeTitle}_Visual.pdf`, pdfResult);

    const content = await zip.generateAsync({ type: 'nodebuffer' });
    
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}_Visual_Export.zip"`);
    res.send(content);

  } catch (error) {
    console.error('Visual Zip Error:', error);
    res.status(500).json({ error: error.message });
  }
});
app.listen(PORT, () => {
    console.log(`YouTube Checker running at http://localhost:${PORT}`);
    const { exec } = require('child_process');
    const startCmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(`${startCmd} http://localhost:${PORT}`);
  });
}

module.exports = app;
