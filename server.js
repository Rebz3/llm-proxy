const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// Читаем тело запроса как "сырой" буфер для максимальной точности
app.use(express.raw({ type: '*/*', limit: '50mb' }));

app.all('/*', async (req, res) => {
  console.log(`\n[${new Date().toISOString()}] Входящий запрос: ${req.method} ${req.path}`);

  // 1. Обработка CORS (для работы из браузеров)
  if (req.method === 'OPTIONS') {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-goog-api-client, x-goog-api-key');
    return res.status(200).end();
  }

  // 2. Проверка безопасности (Твой пароль из Bearer Token)
  const authHeader = req.headers['authorization'];
  let clientPassword = '';
  if (authHeader && authHeader.startsWith('Bearer ')) {
    clientPassword = authHeader.substring(7);
  }

  if (clientPassword !== process.env.PROXY_PASSWORD) {
    console.log('❌ Ошибка: Неверный или отсутствующий пароль');
    return res.status(401).json({ error: 'Unauthorized: Invalid Bearer Token' });
  }

  // 3. Разбор пути (например: /gemini/v1beta/...)
  const pathSegments = req.path.split('/').filter(Boolean);
  if (pathSegments.length === 0) {
    return res.status(200).send('Unified LLM Proxy is LIVE.');
  }

  const provider = pathSegments[0].toLowerCase();
  const remainingPath = '/' + pathSegments.slice(1).join('/');

  let targetBaseUrl = '';
  const fetchHeaders = new Headers();

  // Копируем базовые заголовки (кроме служебных и авторизации)
  for (const [key, value] of Object.entries(req.headers)) {
    const lowerKey = key.toLowerCase();
    const skipHeaders = ['host', 'connection', 'content-length', 'authorization', 'x-forwarded-for', 'x-real-ip', 'forwarded'];
    if (!skipHeaders.includes(lowerKey)) {
      fetchHeaders.set(key, value);
    }
  }

  // 4. Логика подстановки API ключей
  if (provider === 'gemini') {
    targetBaseUrl = 'https://generativelanguage.googleapis.com';
    
    // ФИКС: Если запрос идет через OpenAI-совместимый путь, используем Bearer
    if (remainingPath.includes('/openai/')) {
      fetchHeaders.set('Authorization', `Bearer ${process.env.GEMINI_API_KEY}`);
    } else {
      fetchHeaders.set('x-goog-api-key', process.env.GEMINI_API_KEY);
    }
    
  } else if (provider === 'openai') {
    targetBaseUrl = 'https://api.openai.com';
    fetchHeaders.set('Authorization', `Bearer ${process.env.OPENAI_API_KEY}`);
  } else if (provider === 'groq') {
    targetBaseUrl = 'https://api.groq.com/openai';
    fetchHeaders.set('Authorization', `Bearer ${process.env.GROQ_API_KEY}`);
  } else {
    console.log(`❌ Ошибка: Неизвестный провайдер ${provider}`);
    return res.status(404).json({ error: `Unknown provider: ${provider}` });
  }

  const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  const targetUrl = `${targetBaseUrl}${remainingPath}${queryString}`;

  const fetchOptions = {
    method: req.method,
    headers: fetchHeaders,
  };

  // 5. Пересылка тела запроса
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body && Buffer.isBuffer(req.body) && req.body.length > 0) {
    const bodyString = req.body.toString('utf8');
    fetchOptions.body = bodyString;
    // Обновляем длину контента, так как мы могли его пересобрать
    fetchHeaders.set('Content-Length', Buffer.byteLength(bodyString, 'utf8').toString());
  }

  console.log(`➡️ Проксируем в ${provider}: ${targetUrl}`);

  // 6. Выполнение запроса и обработка ответа
  try {
    const response = await fetch(targetUrl, fetchOptions);
    console.log(`⬅️ Ответ от ${provider}: Статус ${response.status}`);
    
    const buffer = await response.arrayBuffer();

    if (!response.ok) {
      console.log(`⚠️ Текст ошибки от ${provider}:`, Buffer.from(buffer).toString('utf8'));
    }

    // ФИКС ZlibError: Удаляем заголовки, которые заставляют клиента думать, что данные сжаты
    response.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      const headersToSkip = ['content-encoding', 'content-length', 'transfer-encoding'];
      if (!headersToSkip.includes(lowerKey)) {
        res.setHeader(key, value);
      }
    });
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(response.status);
    res.send(Buffer.from(buffer));

  } catch (err) {
    console.log(`❌ Ошибка прокси:`, err.message);
    res.status(502).json({ error: 'Proxy error', details: err.message });
  }
});

app.listen(port, () => {
  console.log(`Proxy server is running on port ${port}`);
});
