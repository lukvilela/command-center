// Netlify Function — proxy seguro pra escrita no Trello
// O token Trello fica no env do Netlify (TRELLO_KEY, TRELLO_TOKEN, TRELLO_BOARD_ID)
// Auth do client via header X-TCC-Secret (compara com env CC_DASH_SECRET)
//
// Endpoints suportados (POST /api/trello-write):
//   { action: 'createCard',  data: { idList, name, desc?, idMembers?, idLabels?, due? } }
//   { action: 'updateCard',  data: { id, name?, desc?, idList?, due? } }
//   { action: 'moveCard',    data: { id, idList } }
//   { action: 'comment',     data: { id, text } }
//   { action: 'archiveCard', data: { id } }
//   { action: 'addMember',   data: { id, idMember } }
//   { action: 'addLabel',    data: { id, idLabel } }

const https = require('https');

const TRELLO_KEY = process.env.TRELLO_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const TRELLO_BOARD_ID = process.env.TRELLO_BOARD_ID ;
const SHARED_SECRET = process.env.CC_DASH_SECRET; // setado pelo admin

function trelloRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(`https://api.trello.com/1${path}`);
    u.searchParams.set('key', TRELLO_KEY);
    u.searchParams.set('token', TRELLO_TOKEN);
    // GET: params na query
    if (body && method === 'GET') {
      for (const [k, v] of Object.entries(body)) {
        if (v !== undefined && v !== null) u.searchParams.set(k, v);
      }
    }
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = https.request(u, opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`Trello ${res.statusCode}: ${data.slice(0, 300)}`));
        try { resolve(data ? JSON.parse(data) : {}); }
        catch (e) { resolve(data); } // pode ser texto (DELETE retorna vazio às vezes)
      });
    });
    req.on('error', reject);
    if (body && method !== 'GET') {
      // Filtra undefined antes de serializar
      const clean = Object.fromEntries(Object.entries(body).filter(([_, v]) => v !== undefined));
      req.write(JSON.stringify(clean));
    }
    req.end();
  });
}

const handlers = {
  // ─── Cards ───
  async createCard(d) {
    if (!d.idList || !d.name) throw new Error('createCard requer idList + name');
    return trelloRequest('POST', '/cards', {
      idList: d.idList,
      name: d.name,
      desc: d.desc || '',
      idMembers: Array.isArray(d.idMembers) ? d.idMembers.join(',') : undefined,
      idLabels: Array.isArray(d.idLabels) ? d.idLabels.join(',') : undefined,
      due: d.due || undefined,
      pos: d.pos || 'top',
    });
  },
  async updateCard(d) {
    if (!d.id) throw new Error('updateCard requer id');
    const { id, ...rest } = d;
    return trelloRequest('PUT', `/cards/${id}`, rest);
  },
  async moveCard(d) {
    if (!d.id || !d.idList) throw new Error('moveCard requer id + idList');
    return trelloRequest('PUT', `/cards/${d.id}`, { idList: d.idList, pos: 'top' });
  },
  async setDue(d) {
    if (!d.id) throw new Error('setDue requer id');
    return trelloRequest('PUT', `/cards/${d.id}`, { due: d.due || null, dueComplete: !!d.dueComplete });
  },
  async archiveCard(d) {
    if (!d.id) throw new Error('archiveCard requer id');
    return trelloRequest('PUT', `/cards/${d.id}`, { closed: true });
  },
  async unarchiveCard(d) {
    if (!d.id) throw new Error('unarchiveCard requer id');
    return trelloRequest('PUT', `/cards/${d.id}`, { closed: false });
  },
  async deleteCard(d) {
    if (!d.id) throw new Error('deleteCard requer id');
    return trelloRequest('DELETE', `/cards/${d.id}`);
  },

  // ─── Comments ───
  async comment(d) {
    if (!d.id || !d.text) throw new Error('comment requer id + text');
    return trelloRequest('POST', `/cards/${d.id}/actions/comments`, { text: d.text });
  },
  async getComments(d) {
    if (!d.id) throw new Error('getComments requer id');
    return trelloRequest('GET', `/cards/${d.id}/actions`, { filter: 'commentCard', limit: 50 });
  },
  async deleteComment(d) {
    if (!d.cardId || !d.actionId) throw new Error('deleteComment requer cardId + actionId');
    return trelloRequest('DELETE', `/actions/${d.actionId}`);
  },

  // ─── Members ───
  async addMember(d) {
    if (!d.id || !d.idMember) throw new Error('addMember requer id + idMember');
    return trelloRequest('POST', `/cards/${d.id}/idMembers`, { value: d.idMember });
  },
  async removeMember(d) {
    if (!d.id || !d.idMember) throw new Error('removeMember requer id + idMember');
    return trelloRequest('DELETE', `/cards/${d.id}/idMembers/${d.idMember}`);
  },

  // ─── Labels ───
  async addLabel(d) {
    if (!d.id || !d.idLabel) throw new Error('addLabel requer id + idLabel');
    return trelloRequest('POST', `/cards/${d.id}/idLabels`, { value: d.idLabel });
  },
  async removeLabel(d) {
    if (!d.id || !d.idLabel) throw new Error('removeLabel requer id + idLabel');
    return trelloRequest('DELETE', `/cards/${d.id}/idLabels/${d.idLabel}`);
  },

  // ─── Checklists ───
  async getChecklists(d) {
    if (!d.id) throw new Error('getChecklists requer id (cardId)');
    return trelloRequest('GET', `/cards/${d.id}/checklists`);
  },
  async createChecklist(d) {
    if (!d.idCard || !d.name) throw new Error('createChecklist requer idCard + name');
    return trelloRequest('POST', `/checklists`, { idCard: d.idCard, name: d.name });
  },
  async deleteChecklist(d) {
    if (!d.id) throw new Error('deleteChecklist requer id');
    return trelloRequest('DELETE', `/checklists/${d.id}`);
  },
  async addCheckItem(d) {
    if (!d.idChecklist || !d.name) throw new Error('addCheckItem requer idChecklist + name');
    return trelloRequest('POST', `/checklists/${d.idChecklist}/checkItems`, { name: d.name, checked: false });
  },
  async toggleCheckItem(d) {
    if (!d.idCard || !d.idCheckItem) throw new Error('toggleCheckItem requer idCard + idCheckItem');
    return trelloRequest('PUT', `/cards/${d.idCard}/checkItem/${d.idCheckItem}`, { state: d.state || 'complete' });
  },
  async deleteCheckItem(d) {
    if (!d.idChecklist || !d.idCheckItem) throw new Error('deleteCheckItem requer idChecklist + idCheckItem');
    return trelloRequest('DELETE', `/checklists/${d.idChecklist}/checkItems/${d.idCheckItem}`);
  },

  // ─── Lists (colunas) ───
  async createList(d) {
    if (!d.name) throw new Error('createList requer name');
    return trelloRequest('POST', `/lists`, { name: d.name, idBoard: process.env.TRELLO_BOARD_ID , pos: d.pos || 'bottom' });
  },
  async renameList(d) {
    if (!d.id || !d.name) throw new Error('renameList requer id + name');
    return trelloRequest('PUT', `/lists/${d.id}`, { name: d.name });
  },
  async archiveList(d) {
    if (!d.id) throw new Error('archiveList requer id');
    return trelloRequest('PUT', `/lists/${d.id}/closed`, { value: true });
  },

  // ─── Labels do board ───
  async createBoardLabel(d) {
    if (!d.name && !d.color) throw new Error('createBoardLabel requer name ou color');
    return trelloRequest('POST', `/labels`, { name: d.name || '', color: d.color || 'sky', idBoard: process.env.TRELLO_BOARD_ID  });
  },

  // ─── Attachments ───
  async getAttachments(d) {
    if (!d.id) throw new Error('getAttachments requer id (cardId)');
    return trelloRequest('GET', `/cards/${d.id}/attachments`);
  },
  async addAttachment(d) {
    if (!d.idCard || !d.url) throw new Error('addAttachment requer idCard + url');
    return trelloRequest('POST', `/cards/${d.idCard}/attachments`, {
      url: d.url,
      name: d.name || undefined,
      setCover: d.setCover || false,
    });
  },
  async removeAttachment(d) {
    if (!d.idCard || !d.idAttachment) throw new Error('removeAttachment requer idCard + idAttachment');
    return trelloRequest('DELETE', `/cards/${d.idCard}/attachments/${d.idAttachment}`);
  },
  async setCover(d) {
    if (!d.idCard) throw new Error('setCover requer idCard');
    return trelloRequest('PUT', `/cards/${d.idCard}`, {
      cover: d.idAttachment
        ? JSON.stringify({ idAttachment: d.idAttachment, brightness: 'dark' })
        : JSON.stringify({ color: null, idAttachment: null }),
    });
  },
};

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-TCC-Secret',
      },
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // Auth
  const provided = event.headers['x-tcc-secret'] || event.headers['X-TCC-Secret'];
  if (!SHARED_SECRET) {
    return { statusCode: 500, body: 'Server: CC_DASH_SECRET não configurado' };
  }
  if (!provided || provided !== SHARED_SECRET) {
    return {
      statusCode: 401,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ erro: 'Sem autenticação. Header X-TCC-Secret inválido.' }),
    };
  }

  if (!TRELLO_KEY || !TRELLO_TOKEN) {
    return { statusCode: 500, body: 'Server: TRELLO_KEY/TOKEN não configurados' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: 'Body inválido' };
  }

  const { action, data } = body;
  const handler = handlers[action];
  if (!handler) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ erro: `Ação desconhecida: ${action}`, allowed: Object.keys(handlers) }),
    };
  }

  try {
    const result = await handler(data || {});
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ok: true, result }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, erro: e.message }),
    };
  }
};
