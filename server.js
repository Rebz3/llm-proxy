const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.raw({ type: '*/*', limit: '50mb' }));

app.all('/*', async (req, res) => {
  console.log(`\n[${new Date().toISOString()}] Входящий запрос: ${req.method} ${req.path}`);

  if (req.method === 'OPTIONS') {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-goog-api-client, x-goog-api-key');
    return res.status(200).end();
  }

  const authHeader = req.headers['authorization'];
  let clientPassword = '';
  if (authHeader && authHeader.startsWith('Bearer ')) {
    clientPassword = authHeader.substring(7).trim();
  }

  if (clientPassword !== process.env.PROXY_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized: Invalid Proxy Password' });
  }

  const pathSegments = req.path.split('/').filter(Boolean);
  if (pathSegments.length === 0) {
    return res.status(200).send('Unified Streaming Proxy is LIVE.');
  }

  const provider = pathSegments[0].toLowerCase();
  const remainingPath = '/' + pathSegments.slice(1).join('/');
  let targetBaseUrl = '';
  const fetchHeaders = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    const lowerKey = key.toLowerCase();
    const skipHeaders = [
      'host', 'connection', 'content-length', 'authorization', 
      'x-forwarded-for', 'x-real-ip', 'forwarded', 'accept-encoding'
    ];
    if (!skipHeaders.includes(lowerKey)) {
      fetchHeaders.set(key, value);
    }
  }

  if (provider === 'gemini') {
    targetBaseUrl = 'https://generativelanguage.googleapis.com';
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
    return res.status(404).json({ error: `Unknown provider: ${provider}` });
  }

  const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  const targetUrl = `${targetBaseUrl}${remainingPath}${queryString}`;
  const fetchOptions = { method: req.method, headers: fetchHeaders };

  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body && Buffer.isBuffer(req.body) && req.body.length > 0) {
    const bodyString = req.body.toString('utf8');
    fetchOptions.body = bodyString;
    fetchHeaders.set('Content-Length', Buffer.byteLength(bodyString, 'utf8').toString());
  }

  // 5. Выполнение запроса и умный стриминг (с лечением багов Google)
  try {
    const response = await fetch(targetUrl, fetchOptions);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.log(`⚠️ Ошибка от ${provider}:`, errorText);
      response.headers.forEach((v, k) => res.setHeader(k, v));
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(response.status).send(errorText);
    }

    response.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      const headersToSkip = ['content-encoding', 'content-length', 'transfer-encoding'];
      if (!headersToSkip.includes(lowerKey)) {
        res.setHeader(key, value);
      }
    });
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (fetchHeaders.get('accept') === 'text/event-stream') {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
    }
    res.status(response.status);

    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Декодируем входящие байты в текст
        buffer += decoder.decode(value, { stream: true });
        
        // SSE (Server-Sent Events) разделяются двумя переносами строк
        let parts = buffer.split('\n\n');
        buffer = parts.pop(); // Последний кусок может быть неполным, оставляем в буфере

        for (const part of parts) {
          if (part.startsWith('data: ')) {
            const dataStr = part.slice(6).trim();
            if (dataStr === '[DONE]') {
              res.write('data: [DONE]\n\n');
              continue;
            }

            try {
              let dataObj = JSON.parse(dataStr);
              
              // --- ИСПРАВЛЕНИЕ БАГА GOOGLE (ИНЪЕКЦИЯ INDEX) ---
              if (dataObj.choices && dataObj.choices[0] && dataObj.choices[0].delta && dataObj.choices[0].delta.tool_calls) {
                dataObj.choices[0].delta.tool_calls.forEach((tc, idx) => {
                  if (tc.index === undefined) {
                    tc.index = idx; // Жестко добавляем index
                  }
                });
              }
              // ------------------------------------------------

              // Отправляем вылеченный JSON обратно клиенту
              res.write(`data: ${JSON.stringify(dataObj)}\n\n`);
            } catch (e) {
              // Если это не JSON, отдаем как есть
              res.write(`${part}\n\n`);
            }
          } else {
            res.write(`${part}\n\n`);
          }
        }
      }
      
      // Сбрасываем остатки буфера, если они есть
      if (buffer.length > 0) res.write(buffer);
      res.end();
      
    } else {
      res.end();
    }

  } catch (err) {
    console.log(`❌ Ошибка:`, err.message);
    res.status(502).json({ error: 'Proxy error', details: err.message });
  }
});

app.listen(port, () => {
  console.log(`Smart Streaming Proxy listening on port ${port}`);
});
