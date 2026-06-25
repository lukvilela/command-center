// Trello API client — substitui o JSON export
// Uso: const board = await fetchBoardFromAPI(key, token, boardId)
// Retorna objeto compatível com o export JSON do Trello

const https = require('https');

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

function buildUrl(path, params) {
  const u = new URL(`https://api.trello.com/1${path}`);
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.set(k, v);
  }
  return u.toString();
}

async function fetchBoardFromAPI(key, token, boardId) {
  const auth = { key, token };
  console.log(`📡 Trello API → board ${boardId}`);

  // 1. Board info
  const board = await get(buildUrl(`/boards/${boardId}`, {
    ...auth,
    fields: 'id,name,desc,url,shortLink,shortUrl,closed',
  }));

  // 2. Lists (incluindo arquivadas)
  const lists = await get(buildUrl(`/boards/${boardId}/lists`, {
    ...auth,
    filter: 'all',
    fields: 'id,name,closed,color,idBoard,pos,subscribed,softLimit,type',
  }));
  console.log(`   ${lists.length} lists`);

  // 3. Cards (incluindo arquivados) com checklists e attachments
  const cards = await get(buildUrl(`/boards/${boardId}/cards/all`, {
    ...auth,
    fields: 'id,idShort,name,desc,closed,idList,idLabels,idMembers,idChecklists,due,dueComplete,start,dateLastActivity,shortUrl,url,labels,attachments,pos,badges',
    attachments: 'true',
    attachment_fields: 'id,name,url,bytes,date',
  }));
  console.log(`   ${cards.length} cards`);

  // 4. Labels
  const labels = await get(buildUrl(`/boards/${boardId}/labels`, {
    ...auth,
    limit: 100,
    fields: 'id,name,color,idBoard',
  }));
  console.log(`   ${labels.length} labels`);

  // 5. Members
  const members = await get(buildUrl(`/boards/${boardId}/members`, {
    ...auth,
    fields: 'id,fullName,username,initials,avatarUrl',
  }));
  console.log(`   ${members.length} members`);

  // 6. Checklists
  const checklists = await get(buildUrl(`/boards/${boardId}/checklists`, {
    ...auth,
    fields: 'id,name,idCard,pos,checkItems',
    checkItem_fields: 'id,name,state,pos,idChecklist',
  }));
  console.log(`   ${checklists.length} checklists`);

  // 7. Actions (commentCard) — paginar até 1000 (limite Trello por request é 1000)
  let actions = [];
  let before = null;
  for (let i = 0; i < 5; i++) { // até 5000 actions max
    const params = {
      ...auth,
      filter: 'commentCard,createCard,updateCard,deleteCard,addMemberToCard,removeMemberFromCard',
      limit: 1000,
      fields: 'id,type,date,data,idMemberCreator',
      memberCreator_fields: 'id,fullName,username',
    };
    if (before) params.before = before;
    const batch = await get(buildUrl(`/boards/${boardId}/actions`, params));
    if (!batch.length) break;
    actions = actions.concat(batch);
    if (batch.length < 1000) break;
    before = batch[batch.length - 1].date;
  }
  console.log(`   ${actions.length} actions`);

  // Mount no formato compatível com export JSON
  return {
    id: board.id,
    name: board.name,
    desc: board.desc,
    url: board.url,
    shortUrl: board.shortUrl,
    shortLink: board.shortLink,
    closed: board.closed,
    lists,
    cards,
    labels,
    members,
    checklists,
    actions,
  };
}

module.exports = { fetchBoardFromAPI };
