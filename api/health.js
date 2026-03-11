// api/health.js
// Health check endpoint — used for uptime monitoring (UptimeRobot etc)

import { Redis } from '@upstash/redis';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const status = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    services: {
      api: 'ok',
      redis: 'unknown',
    },
  };

  // Check Redis connectivity
  try {
    const redis = new Redis({
      url:   process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    await redis.ping();
    status.services.redis = 'ok';
  } catch (e) {
    status.services.redis = 'unavailable';
    status.status = 'degraded';
  }

  const httpStatus = status.status === 'ok' ? 200 : 207;
  return res.status(httpStatus).json(status);
}
