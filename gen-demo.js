// Gera data/derived.json com dados FICTÍCIOS, usando o processBoard real (schema garantido).
const fs = require("fs");
const { processBoard } = require("./netlify/functions/trello-snapshot.js");

const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

const lists = [
  { id: "l1", name: "Backlog", closed: false, pos: 1 },
  { id: "l2", name: "To-Do", closed: false, pos: 2 },
  { id: "l3", name: "In Progress", closed: false, pos: 3 },
  { id: "l4", name: "Review", closed: false, pos: 4 },
  { id: "l5", name: "Blocked", closed: false, pos: 5 },
  { id: "l6", name: "Done", closed: false, pos: 6 },
];
const labels = [
  { id: "lb1", name: "1 Crítico", color: "red" },
  { id: "lb2", name: "2 Alta", color: "orange" },
  { id: "lb3", name: "3 Média", color: "yellow" },
  { id: "lb4", name: "frontend", color: "sky" },
  { id: "lb5", name: "backend", color: "purple" },
  { id: "lb6", name: "infra", color: "lime" },
];
const members = [
  { id: "m1", fullName: "Ana Souza", username: "ana" },
  { id: "m2", fullName: "Bruno Lima", username: "bruno" },
  { id: "m3", fullName: "Carla Dias", username: "carla" },
  { id: "m4", fullName: "Diego Alves", username: "diego" },
];

// [idShort, name, listId, [labelIds], [memberIds], daysAgo]
const raw = [
  [101, "[AUTH] Feat: login com OAuth (Google)", "l6", ["lb2"], ["m1"], 3],
  [102, "[API] Feat: busca com paginação e filtros", "l6", ["lb3"], ["m2"], 5],
  [103, "[UI] Feat: tema escuro + tokens de design", "l6", ["lb3", "lb4"], ["m3"], 6],
  [104, "[CORE] Chore: setup do projeto + CI", "l6", ["lb6"], ["m2"], 12],
  [105, "[DATA] Feat: dashboard de métricas", "l3", ["lb2", "lb4"], ["m1"], 2],
  [106, "[API] Fix: rate limit no webhook", "l3", ["lb1", "lb5"], ["m2"], 8],
  [107, "[UI] Feat: drag-and-drop nas colunas", "l3", ["lb3", "lb4"], ["m3"], 1],
  [108, "[BILLING] Feat: checkout com Stripe", "l4", ["lb2", "lb5"], ["m4"], 2],
  [109, "[AUTH] Fix: refresh token expirando cedo", "l4", ["lb2"], ["m1"], 3],
  [110, "[INFRA] Chore: pipeline de deploy", "l5", ["lb1", "lb6"], ["m2"], 9],
  [111, "[API] Feat: integração com GitHub (PRs/runs)", "l2", ["lb2", "lb5"], ["m4"], 1],
  [112, "[DATA] Feat: exportar relatório em CSV", "l2", ["lb3"], ["m3"], 1],
  [113, "[UI] Feat: modal de detalhe do card", "l2", ["lb3", "lb4"], ["m1"], 2],
  [114, "[DOCS] Docs: guia de setup", "l1", ["lb3"], ["m4"], 4],
  [115, "[CORE] Refactor: store de estado", "l1", ["lb3", "lb5"], ["m2"], 5],
  [116, "[BILLING] Feat: webhooks de assinatura", "l1", ["lb2", "lb5"], ["m4"], 6],
];

const cards = raw.map(([idShort, name, idList, idLabels, idMembers, d]) => ({
  id: "c" + idShort,
  idShort,
  name,
  desc: "",
  closed: false,
  idList,
  idLabels,
  idMembers,
  idChecklists: [],
  due: null,
  dueComplete: false,
  dateLastActivity: daysAgo(d),
  shortUrl: "#",
  cover: null,
  badges: {},
  attachments: [],
}));

const board = { id: "demo", name: "Demo Board", url: "#", lists, cards, labels, members, checklists: [] };
const derived = processBoard(board);

fs.mkdirSync("data", { recursive: true });
fs.writeFileSync("data/derived.json", JSON.stringify(derived, null, 2));
console.log(
  "derived.json:",
  "cards=" + derived.cards.length,
  "lists=" + derived.lists.length,
  "epics=" + derived.epics.length,
  "alerts=" + derived.alerts.length,
  "devs=" + Object.keys(derived.byDev).length
);
