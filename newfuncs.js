function cleanOcrText(t) {
  let l = t.split(/\r?\n/).map(x => x.trim()).filter(x => x.length > 0);
  const n = [/^\d{1,2}:\d{2}(?::\d{2})?$/, /\b\d+[KMkm]?\s*views?\b/i, /\b\d+\s*(?:second|minute|hour|day|week|month|year)s?\s+ago\b/i, /\b\d+[dwmhy]\b/i, /\b\d{1,3}(?:\.\d)?[KMkm]?\s*(?:subscribers?|subs?)\b/i, /\b(?:subscribe|subscribed|share|save|join|shop|thanks|clip|report|show more|show less|read more|\.{3})\b/i, /^\d+$/, /https?:\/\/\S+/i, /(?:youtube\.com|youtu\.be)/i, /\b\d{1,3}(?:\.\d)?[KMkm]?\s*videos?\b/i, /^ago$/i, /^views?$/i, /^(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)$/i];
  return l.filter(x => !n.some(p => p.test(x)));
}

function extractSearchQuery(l) {
  if (!l || !l.length) return null;
  const s = l.map(x => ({ x, score: x.length * 0.5 + x.split(/\s+/).filter(w => w.length > 1).length * 10 + (x.replace(/[^a-zA-Z]/g, '').length / Math.max(x.length, 1)) * 20 }));
  s.sort((a, b) => b.score - a.score);
  return s[0].x.substring(0, 120);
}

