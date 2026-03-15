const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// Читаем тело запроса как абсолютно "сырой" буфер, чтобы не потерять ни байта
app.use(express.raw({ type: '*/*', limit: '50mb' }));

app.all('/*', async (req, res) => {
  // 1. Обработка CORS
  if (req.method === 'OPTIONS') {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-goog-api-client, x-goog-api-key');
    return res.status(200).end();
  }

  // 2. Проверка твоего пароля
  const authHeader = req.headers['authorization'];
  let clientPassword = '';
  if (authHeader && authHeader.startsWith('Bearer ')) {
    clientPassword = authHeader.substring(7);
  }

  if (clientPassword !== process.env.PROXY_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized: Invalid Bearer Token' });
  }

  // 3. Разбираем URL
  const pathSegments = req.path.split('/').filter(Boolean);
  if (pathSegments.length === 0) {
    return res.status(200).send('Unified LLM Proxy is running on Render (US Region).');
  }

  const provider = pathSegments[0].toLowerCase();
  const remainingPath = '/' + pathSegments.slice(1).join('/');

  let targetBaseUrl = '';
  const fetchHeaders = new Headers();

  // Копируем заголовки клиента
  for (const [key, value] of Object.entries(req.headers)) {
    const lowerKey = key.toLowerCase();
    // Мы удаляем старый content-length, чтобы пересчитать его заново
    if (!['host', 'connection', 'content-length', 'authorization', 'x-forwarded-for', 'x-real-ip', 'forwarded'].includes(lowerKey)) {
      fetchHeaders.set(key, value);
    }
  }

  // 4. Маршрутизация и подстановка ключей
  if (provider === 'gemini') {
    targetBaseUrl = 'https://generativelanguage.googleapis.com';
    fetchHeaders.set('x-goog-api-key', process.env.GEMINI_API_KEY);
  } else if (provider === 'openai') {
    targetBaseUrl = 'https://api.openai.com';
    fetchHeaders.set('Authorization', `Bearer ${process.env.OPENAI_API_KEY}`);
  } else if (provider === 'groq') {
    targetBaseUrl = 'https://api.groq.com/openai';
    fetchHeaders.set('Authorization', `Bearer ${process.env.GROQ_API_KEY}`);
  } else {
    return res.status(404).json({ error: `Unknown provider: ${provider}` });
  }

  const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  const targetUrl = `${targetBaseUrl}${remainingPath}${queryString}`;

  const fetchOptions = {
    method: req.method,
    headers: fetchHeaders,
  };

  // 5. Жестко фиксируем тело запроса и его размер
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body && Buffer.isBuffer(req.body) && req.body.length > 0) {
    // Превращаем сырой буфер в строку
    const bodyString = req.body.toString('utf8');
    fetchOptions.body = bodyString;
    
    // ПРИНУДИТЕЛЬНО задаем Content-Length. Это спасет от разбивки на чанки!
    fetchHeaders.set('Content-Length', Buffer.byteLength(bodyString, 'utf8').toString());
  }

  // 6. Отправляем запрос провайдеру
  try {
    const response = await fetch(targetUrl, fetchOptions);
    
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(response.status);
    
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));

  } catch (err) {
    res.status(502).json({ error: 'Proxy error', details: err.message });
  }
});

app.listen(port, () => {
  console.log(`Proxy listening on port ${port}`);
});
