export default async () => {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  if (!publicKey) {
    return new Response(
      JSON.stringify({ error: 'VAPID_PUBLIC_KEY 환경 변수가 설정되지 않았습니다.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  return new Response(JSON.stringify({ publicKey }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
