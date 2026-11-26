import webpush from 'web-push';

const LATITUDE = 37.5665;
const LONGITUDE = 126.9780;
const TIMEZONE = 'Asia/Seoul';
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const SUB_INDEX_KEY = 'weather_push:endpoints';

function configureWebPush() {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    throw new Error('VAPID_PUBLIC_KEY 또는 VAPID_PRIVATE_KEY 환경 변수가 없습니다.');
  }
  webpush.setVapidDetails(
    VAPID_SUBJECT || 'mailto:admin@example.com',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

async function redisCommand(command) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    throw new Error(`Upstash Redis 요청 실패 (HTTP ${res.status})`);
  }
  const data = await res.json();
  return data.result;
}

function makeRecordKey(endpoint) {
  const encoded = Buffer.from(endpoint).toString('base64url');
  return `weather_push:sub:${encoded}`;
}

function getCurrentKstHm(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const map = {};
  parts.forEach((p) => {
    if (p.type !== 'literal') map[p.type] = p.value;
  });
  return `${map.hour}:${map.minute}`;
}

async function buildWeatherPushPayload(tone = 'polite') {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${LATITUDE}&longitude=${LONGITUDE}` +
    `&current=temperature_2m,precipitation,weather_code` +
    `&daily=temperature_2m_max,temperature_2m_min` +
    `&timezone=${encodeURIComponent(TIMEZONE)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`날씨 조회 실패 (HTTP ${res.status})`);
  }
  const data = await res.json();
  const temp = data?.current?.temperature_2m;
  const minT = data?.daily?.temperature_2m_min?.[0];
  const maxT = data?.daily?.temperature_2m_max?.[0];

  let guide = '가벼운 겉옷 챙기세요.';
  if (typeof temp === 'number') {
    if (temp < 5) guide = tone === 'direct' ? '두꺼운 패딩·방한용품 필수' : '두꺼운 패딩과 방한용품 챙기세요.';
    else if (temp < 15) guide = tone === 'direct' ? '자켓·코트 등 겉옷 필요' : '자켓이나 코트 등 겉옷 챙기세요.';
    else if (temp >= 23) guide = tone === 'direct' ? '시원한 복장·수분 보충' : '시원한 옷차림과 수분 보충 챙기세요.';
  }

  return JSON.stringify({
    title: '오늘의 날씨 비서',
    body: `서울 현재 ${temp ?? '-'}°C (최저 ${minT ?? '-'}° / 최고 ${maxT ?? '-'}°) · ${guide}`,
    url: './index.html',
  });
}

export default async (request) => {
  try {
    configureWebPush();

    const urlObj = new URL(request.url);
    const forceSend = urlObj.searchParams.get('force') === 'true';
    const currentHm = getCurrentKstHm();

    const endpoints = (await redisCommand(['SMEMBERS', SUB_INDEX_KEY])) || [];
    const results = [];

    for (const endpoint of endpoints) {
      const raw = await redisCommand(['GET', makeRecordKey(endpoint)]);
      if (!raw) continue;

      const record = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const settings = record.settings || {};
      const alarms = Array.isArray(settings.alarms) ? settings.alarms : [];
      const isMatched = forceSend || (settings.alertEnabled !== false && alarms.includes(currentHm));

      if (!isMatched) {
        results.push({ endpoint, status: 'skipped_time', currentHm, alarms });
        continue;
      }

      const payload = await buildWeatherPushPayload(settings.tone);

      try {
        await webpush.sendNotification(record.subscription, payload);
        results.push({ endpoint, status: 'sent', time: currentHm });
      } catch (err) {
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await redisCommand(['DEL', makeRecordKey(endpoint)]);
          await redisCommand(['SREM', SUB_INDEX_KEY, endpoint]);
          results.push({ endpoint, status: 'expired_removed' });
        } else {
          results.push({ endpoint, status: 'error', reason: err.message });
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, currentHm, forceSend, results }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || '푸시 발송 오류' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
