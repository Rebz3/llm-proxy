// Эта настройка — самое важное. Она заставляет скрипт выполняться только в США
export const config = {
  runtime: 'edge',
  regions: ['iad1'], // iad1 — это дата-центр в Вашингтоне (США)
};

export default async function handler(request) {
  // 1. Обработка CORS
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-goog-api-client, x-goog-api-key",
      },
    });
  }

  // 2. Проверка пароля (в Vercel используем process.env вместо env)
  const authHeader = request.headers.get("Authorization");
  let clientPassword = authHeader && authHeader.startsWith("Bearer ") 
    ? authHeader.substring(7) 
    : "";

  if (clientPassword !== process.env.PROXY_PASSWORD) {
    return new Response(JSON.stringify({ error: "Unauthorized: Invalid Bearer Token" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  // 3. Разбираем URL
  const url = new URL(request.url);
  
  // В Vercel запросы к API обычно идут по пути /api/[имя_файла]/..., поэтому чистим путь
  // Например, /api/proxy/gemini/v1beta/... превратится в ['gemini', 'v1beta', ...]
  const pathname = url.pathname.replace(/^\/api\/[^\/]+/, ''); 
  const pathSegments = pathname.split('/').filter(Boolean); 

  if (pathSegments.length === 0) {
    return new Response("Unified LLM Proxy is running in the US.", { status: 200 });
  }

  const provider = pathSegments[0].toLowerCase();
  const remainingPath = '/' + pathSegments.slice(1).join('/');

  let targetBaseUrl = "";
  const newHeaders = new Headers(request.headers);

  // Удаляем следы реального IP
  newHeaders.delete("Host");
  newHeaders.delete("x-forwarded-for");
  newHeaders.delete("x-real-ip");
  newHeaders.delete("forwarded");

  // 4. Маршрутизация и подстановка ключей
  if (provider === "gemini") {
    targetBaseUrl = "https://generativelanguage.googleapis.com";
    newHeaders.set("x-goog-api-key", process.env.GEMINI_API_KEY);
    newHeaders.delete("Authorization");

  } else if (provider === "openai") {
    targetBaseUrl = "https://api.openai.com";
    newHeaders.set("Authorization", `Bearer ${process.env.OPENAI_API_KEY}`);

  } else if (provider === "groq") {
    targetBaseUrl = "https://api.groq.com/openai";
    newHeaders.set("Authorization", `Bearer ${process.env.GROQ_API_KEY}`);

  } else {
    return new Response(JSON.stringify({ error: `Unknown provider: ${provider}` }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }

  // 5. Собираем итоговый URL и отправляем запрос
  const targetUrl = `${targetBaseUrl}${remainingPath}${url.search}`;
  
  const modifiedRequest = new Request(targetUrl, {
    method: request.method,
    headers: newHeaders,
    body: request.body,
    redirect: "follow",
  });

  try {
    const response = await fetch(modifiedRequest);
    const newResponse = new Response(response.body, response);
    newResponse.headers.set("Access-Control-Allow-Origin", "*");
    return newResponse;
  } catch (err) {
    return new Response(JSON.stringify({ error: "Proxy error", details: err.message }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}
