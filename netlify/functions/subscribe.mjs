const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const SUB_INDEX_KEY = 'weather_push:endpoints';

async function redisCommand(command) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error('UPSTASH_REDIS_REST_URL 또는 UPSTASH_REDIS_REST_TOKEN 환경 변수가 없습니다.');
  }

  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Upstash Redis 요청 실패 (HTTP ${res.status}): ${errText}`);
  }

  return res.json();
}

function makeRecordKey(endpoint) {
  const encoded = Buffer.from(endpoint).toString('base64url');
  return `weather_push:sub:${encoded}`;
}

export default async (request) => {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json();
    const subscription = body?.subscription;
    const settings = body?.settings || {};

    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return new Response(JSON.stringify({ error: '유효하지 않은 푸시 구독 정보입니다.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const normalizedAlarms = Array.isArray(settings.alarms)
      ? settings.alarms.filter((t) => typeof t === 'string' && /^\d{2}:\d{2}$/.test(t))
      : [];

    const record = {
      endpoint: subscription.endpoint,
      subscription,
      settings: {
        alertEnabled: settings.alertEnabled !== false,
        alarms: normalizedAlarms,
        tone: settings.tone || 'polite',
      },
      updatedAt: new Date().toISOString(),
    };

    const key = makeRecordKey(subscription.endpoint);
    await redisCommand(['SET', key, JSON.stringify(record)]);
    await redisCommand(['SADD', SUB_INDEX_KEY, subscription.endpoint]);

    return new Response(
      JSON.stringify({
        ok: true,
        message: '구독 및 알람 시각이 저장되었습니다.',
        alarms: record.settings.alarms,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || '구독 저장 오류' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
