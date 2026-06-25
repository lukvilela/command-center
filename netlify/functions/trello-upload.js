// Netlify Function — upload de arquivo direto pro Trello (multipart/form-data)
// Recebe POST com body base64 do arquivo + idCard + name + mimeType
// Auth via X-TCC-Secret

const https = require('https');

const TRELLO_KEY = process.env.TRELLO_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const SHARED_SECRET = process.env.TCC_DASH_SECRET || process.env.CC_DASH_SECRET;

function uploadToTrello(idCard, fileBuffer, fileName, mimeType, setCover) {
  return new Promise((resolve, reject) => {
    const boundary = '----CCBoundary' + Date.now();
    const parts = [];

    // Field: name
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${fileName}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="setCover"\r\n\r\n${setCover ? 'true' : 'false'}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`));
    parts.push(fileBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const url = new URL(`https://api.trello.com/1/cards/${idCard}/attachments`);
    url.searchParams.set('key', TRELLO_KEY);
    url.searchParams.set('token', TRELLO_TOKEN);

    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`Trello ${res.statusCode}: ${data.slice(0, 300)}`));
        try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-TCC-Secret, X-File-Name, X-Card-Id, X-Mime-Type, X-Set-Cover',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };

  // Auth
  const provided = event.headers['x-tcc-secret'] || event.headers['X-TCC-Secret'] || event.headers['x-tcc-secret'];
  if (!SHARED_SECRET || provided !== SHARED_SECRET) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ erro: 'Sem autenticação' }) };
  }

  const idCard = event.headers['x-card-id'] || event.headers['X-Card-Id'];
  const fileName = event.headers['x-file-name'] || event.headers['X-File-Name'] || 'upload';
  const mimeType = event.headers['x-mime-type'] || event.headers['X-Mime-Type'] || 'application/octet-stream';
  const setCover = (event.headers['x-set-cover'] || '').toLowerCase() === 'true';

  if (!idCard) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ erro: 'X-Card-Id obrigatório' }) };
  }

  // Body é base64 (Netlify converte automatic se isBase64Encoded=true)
  const buffer = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : Buffer.from(event.body || '', 'binary');

  if (buffer.length === 0) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ erro: 'Arquivo vazio' }) };
  }
  if (buffer.length > 9 * 1024 * 1024) {
    return { statusCode: 413, headers: corsHeaders, body: JSON.stringify({ erro: 'Arquivo muito grande (max 9MB pra Netlify Function)' }) };
  }

  try {
    const result = await uploadToTrello(idCard, buffer, fileName, mimeType, setCover);
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, result }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, erro: e.message }),
    };
  }
};
