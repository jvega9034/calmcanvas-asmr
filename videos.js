// api/videos.js
// YouTube proxy API with Redis server-side caching
// - Keeps your YouTube API key secret (never exposed to browsers)
// - Serves cached results to ALL users from one shared cache
// - Rate limits requests per IP to prevent abuse
// - 50,000 users hitting the same query = 1 YouTube API call

import { Redis } from '@upstash/redis';

// ── Config ────────────────────────────────────────────────
const YT_BASE     = 'https://www.googleapis.com/youtube/v3';
const CACHE_TTL   = 60 * 60 * 2;   // 2 hours in seconds
const RATE_WINDOW = 60;             // 1 minute window
const RATE_LIMIT  = 30;            // max 30 requests per IP per minute

// ── Redis client (lazy init) ──────────────────────────────
let redis;
function getRedis() {
  if (!redis) {
    redis = new Redis({
      url:   process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return redis;
}

// ── Helpers ───────────────────────────────────────────────
function cacheKey(query, pageToken, maxResults) {
  const raw = `yt:${query}:${pageToken}:${maxResults}`;
  // Simple hash to keep keys short
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash << 5) - hash + raw.charCodeAt(i);
    hash |= 0;
  }
  return `cc:v1:${Math.abs(hash)}`;
}

function rateLimitKey(ip) {
  const minute = Math.floor(Date.now() / 1000 / RATE_WINDOW);
  return `cc:rl:${ip}:${minute}`;
}

function getClientIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

function parseDuration(iso) {
  if (!iso) return '';
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return '';
  const h = parseInt(m[1] || 0);
  const min = parseInt(m[2] || 0);
  const sec = parseInt(m[3] || 0);
  if (h) return `${h}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

function fmtNum(n) {
  n = parseInt(n) || 0;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(0) + 'K';
  return n.toString();
}

function setCorsHeaders(res, origin) {
  const allowed = [
    'https://calmcanvas.net',
    'https://www.calmcanvas.net',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
  ];
  if (allowed.includes(origin) || !origin) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

// ── Main handler ──────────────────────────────────────────
export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  setCorsHeaders(res, origin);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { q = 'ASMR relaxation', pageToken = '', maxResults = '12' } = req.query;

  // Validate inputs
  const max = Math.min(Math.max(parseInt(maxResults) || 12, 1), 24);
  const query = String(q).slice(0, 200);

  // ── Rate limiting ─────────────────────────────────────
  const ip = getClientIP(req);
  let rateLimited = false;

  try {
    const r = getRedis();
    const rlKey = rateLimitKey(ip);
    const count = await r.incr(rlKey);
    if (count === 1) await r.expire(rlKey, RATE_WINDOW);
    if (count > RATE_LIMIT) {
      rateLimited = true;
    }
  } catch (e) {
    // Redis unavailable — skip rate limiting, don't fail request
    console.warn('Rate limit check failed:', e.message);
  }

  if (rateLimited) {
    return res.status(429).json({
      error: 'Too many requests. Please slow down.',
      retryAfter: RATE_WINDOW,
    });
  }

  // ── Check Redis cache ─────────────────────────────────
  const ck = cacheKey(query, pageToken, max);
  let cached = null;

  try {
    const r = getRedis();
    cached = await r.get(ck);
  } catch (e) {
    console.warn('Cache read failed:', e.message);
  }

  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=1800');
    return res.status(200).json(cached);
  }

  // ── Fetch from YouTube API ────────────────────────────
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server configuration error.' });
  }

  try {
    // Search request
    const searchParams = new URLSearchParams({
      part: 'snippet',
      q: query,
      type: 'video',
      maxResults: max,
      order: 'relevance',
      key: apiKey,
      ...(pageToken ? { pageToken } : {}),
    });

    const searchRes = await fetch(`${YT_BASE}/search?${searchParams}`);
    const searchData = await searchRes.json();

    if (!searchRes.ok || searchData.error) {
      const msg = searchData.error?.message || 'YouTube API error';
      const code = searchData.error?.code || searchRes.status;
      // Pass quota errors through clearly
      if (code === 403 || msg.toLowerCase().includes('quota')) {
        return res.status(429).json({ error: 'quota_exceeded', message: msg });
      }
      return res.status(502).json({ error: msg });
    }

    const ids = searchData.items
      .map(i => i.id?.videoId)
      .filter(Boolean)
      .join(',');

    if (!ids) {
      const empty = { items: [], nextPageToken: '' };
      return res.status(200).json(empty);
    }

    // Details request (duration + stats)
    const detailsParams = new URLSearchParams({
      part: 'contentDetails,statistics',
      id: ids,
      key: apiKey,
    });

    const detailsRes = await fetch(`${YT_BASE}/videos?${detailsParams}`);
    const detailsData = await detailsRes.json();

    const detailsMap = {};
    (detailsData.items || []).forEach(v => { detailsMap[v.id] = v; });

    // Shape the response
    const items = searchData.items
      .filter(i => i.id?.videoId)
      .map(i => {
        const d = detailsMap[i.id.videoId] || {};
        return {
          id:          i.id.videoId,
          title:       i.snippet.title,
          channel:     i.snippet.channelTitle,
          thumb:       i.snippet.thumbnails?.medium?.url || i.snippet.thumbnails?.default?.url || '',
          publishedAt: i.snippet.publishedAt,
          description: i.snippet.description || '',
          duration:    parseDuration(d.contentDetails?.duration),
          views:       fmtNum(d.statistics?.viewCount),
          likes:       fmtNum(d.statistics?.likeCount),
        };
      });

    const result = {
      items,
      nextPageToken: searchData.nextPageToken || '',
      cached: false,
      cachedAt: new Date().toISOString(),
    };

    // ── Save to Redis cache ───────────────────────────
    try {
      const r = getRedis();
      await r.set(ck, result, { ex: CACHE_TTL });
    } catch (e) {
      console.warn('Cache write failed:', e.message);
    }

    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=1800');
    return res.status(200).json(result);

  } catch (e) {
    console.error('YouTube fetch error:', e);
    return res.status(502).json({ error: 'Failed to fetch videos. Please try again.' });
  }
}
