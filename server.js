const express = require('express');
const path    = require('path');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const NOTION_KEY = process.env.NOTION_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const BDD_ID     = process.env.NOTION_BDD_SOURCE_ID;

const KB_PAGES = [
  { id: '3665ebcd4f088101a391d4d9f1fe85d6', title: 'Règles générales' },
  { id: '3665ebcd4f08810187efe41854c1e027', title: 'Algorithme de recommandation' },
  { id: '3665ebcd4f088141a644c910c3c4a100', title: 'Argumentaires par situation' },
  { id: '3665ebcd4f0881b8b55cf6cc8f0d08f5', title: 'Objections fréquentes' },
  { id: '3665ebcd4f088196b2d3f59338b61ec4', title: 'Hiérarchie et prix des offres' },
];

// ── Notion helpers ────────────────────────────────────────────────────────

async function notionGet(path) {
  const r = await fetch(`https://api.notion.com/v1${path}`, {
    headers: { Authorization: `Bearer ${NOTION_KEY}`, 'Notion-Version': '2022-06-28' },
  });
  return r.json();
}

async function notionPost(path, body) {
  const r = await fetch(`https://api.notion.com/v1${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${NOTION_KEY}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

function blocksToText(blocks = []) {
  return blocks.map(b => {
    const type = b.type;
    const c = b[type];
    const rt = () => (c?.rich_text || []).map(t => t.plain_text).join('');
    if (['paragraph', 'quote', 'callout'].includes(type)) return rt();
    if (['heading_1', 'heading_2', 'heading_3'].includes(type)) return `\n### ${rt()}\n`;
    if (['bulleted_list_item', 'numbered_list_item'].includes(type)) return `• ${rt()}`;
    if (type === 'table_row') return c.cells.map(cell => cell.map(t => t.plain_text).join('')).join(' | ');
    if (type === 'divider') return '---';
    return '';
  }).filter(Boolean).join('\n');
}

async function fetchPageText(pageId) {
  const data = await notionGet(`/blocks/${pageId}/children?page_size=100`);
  return blocksToText(data.results || []);
}

async function fetchKB() {
  const sections = await Promise.all(
    KB_PAGES.map(async p => `=== ${p.title} ===\n${await fetchPageText(p.id)}`)
  );
  return sections.join('\n\n');
}

async function fetchSimilarCases(zone) {
  const data = await notionPost(`/databases/${BDD_ID}/query`, {
    filter: zone ? { property: 'Zone', select: { equals: zone } } : undefined,
    sorts: [{ property: 'Cas exemplaire', direction: 'descending' }],
    page_size: 6,
  });
  return (data.results || []).map(p => {
    const pr = p.properties;
    const txt = k => pr[k]?.rich_text?.[0]?.plain_text || '';
    const num = k => pr[k]?.number ?? '';
    const sel = k => pr[k]?.select?.name || '';
    return {
      account: pr["Nom de l'account"]?.title?.[0]?.plain_text || '',
      zone: sel('Zone'), offerActuel: sel('Offer type actuel'), offerPropose: sel('Offer type proposé'),
      healthScore: num('Health Score'), pageviews: sel('Pageviews Search Overview'),
      discountPropose: num('Discount proposé'), argument: txt('Argument principal'),
      retour: txt('Retour du client'), exemplaire: pr['Cas exemplaire']?.checkbox || false,
    };
  });
}

async function callGemini(prompt) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 1200 } }),
    }
  );
  const d = await r.json();
  return d.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── Routes ────────────────────────────────────────────────────────────────

const AM_MAPPING_PAGE_ID = '3675ebcd4f0881a9a64cf3d64615169f';

app.get('/am-mapping', async (req, res) => {
  const data = await notionGet(`/blocks/${AM_MAPPING_PAGE_ID}/children?page_size=100`);
  const mapping = {};
  for (const block of (data.results || [])) {
    if (block.type !== 'table_row') continue;
    const cells = block.table_row?.cells || [];
    const id   = cells[0]?.map(t => t.plain_text).join('').trim();
    const name = cells[1]?.map(t => t.plain_text).join('').trim();
    if (id && name && id !== 'ID Salesforce') mapping[id] = name;
  }
  res.json(mapping);
});

app.post('/recommend', async (req, res) => {
  const client = req.body;
  const [kb, cases] = await Promise.all([fetchKB(), fetchSimilarCases(client.zone)]);

  const casesText = cases.length
    ? cases.map(c => `${c.exemplaire ? '⭐' : '-'} ${c.account} (${c.zone}) | HS: ${c.healthScore}% | Pageviews: ${c.pageviews} | ${c.offerActuel} → ${c.offerPropose} | -${c.discountPropose}% | Argument: ${c.argument}${c.retour ? ` | Retour client: ${c.retour}` : ''}`).join('\n')
    : 'Aucun cas passé disponible pour cette zone.';

  const prompt = `Tu es un expert en négociation commerciale pour Joy, plateforme SaaS de gestion événementielle. Recommande la meilleure offre de renouvellement/négociation pour ce client.

KNOWLEDGE BASE (règles, algorithme, argumentaires, prix) :
${kb}

CAS CLIENTS PASSÉS SIMILAIRES (⭐ = cas exemplaire) :
${casesText}

PROFIL DU CLIENT :
- Compte : ${client.account}
- Zone : ${client.zone}
- Offre actuelle : ${client.currentOffer}
- ARR actuel : ${client.arr} €
- MRR actuel : ${client.mrr} €
- Discount actuel : ${client.currentDiscount}%
- Health Score : ${client.healthScore}%
- Pageviews Search : ${client.pageviews}
- Prochaine facturation : ${client.nextBilling}
- Engagement contrat : ${client.contractEngagement}

Génère une recommandation JSON avec ce format exact (rien d'autre autour) :
{
  "offreRecommandee": "Basic | Advanced | Expert | Enterprise 1 | Enterprise 2 | Enterprise 3",
  "discountSuggere": 0-60,
  "niveauValidation": "autonome | manager | interdit",
  "argumentPrincipal": "argument principal en 1-2 phrases percutantes",
  "why": "raisonnement détaillé en 3-4 phrases citant les signaux clés (HS, pageviews, cas similaires, règles KB)",
  "objectionsProbables": ["objection 1", "objection 2"],
  "alertes": []
}`;

  const raw = await callGemini(prompt);
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    res.json(JSON.parse(match ? match[0] : raw));
  } catch {
    res.json({ error: 'Parsing error', raw });
  }
});

app.post('/save-case', async (req, res) => {
  const d = req.body;
  const prop = {
    "Nom de l'account": { title: [{ text: { content: d.account || '' } }] },
    ...(d.zone             && { Zone:                               { select:    { name: d.zone } } }),
    ...(d.currentOffer     && { 'Offer type actuel':                { select:    { name: d.currentOffer } } }),
    ...(d.arr != null      && { 'ARR actuel':                       { number:    parseFloat(d.arr) } }),
    ...(d.mrr != null      && { 'MRR Actuel':                       { number:    parseFloat(d.mrr) } }),
    ...(d.currentDiscount != null && { 'Discount actuel':           { number:    parseFloat(d.currentDiscount) } }),
    ...(d.nextBilling      && { 'Next Billing date':                { date:      { start: d.nextBilling } } }),
    ...(d.contractEngagement && { 'Contract engagement':            { rich_text: [{ text: { content: d.contractEngagement } }] } }),
    ...(d.healthScore != null && { 'Health Score':                  { number:    parseFloat(d.healthScore) } }),
    ...(d.pageviews        && { 'Pageviews Search Overview':        { select:    { name: d.pageviews } } }),
    ...(d.renewalDate      && { 'Date de renouvellement effective': { date:      { start: d.renewalDate } } }),
    ...(d.proposedOffer    && { 'Offer type proposé':               { select:    { name: d.proposedOffer } } }),
    ...(d.proposedDiscount != null && { 'Discount proposé':         { number:    parseFloat(d.proposedDiscount) } }),
    ...(d.echeancier       && { Echéancier:                         { rich_text: [{ text: { content: d.echeancier } }] } }),
    ...(d.argument         && { 'Argument principal':               { rich_text: [{ text: { content: d.argument } }] } }),
    ...(d.retourClient     && { 'Retour du client':                 { rich_text: [{ text: { content: d.retourClient } }] } }),
    'Cas exemplaire': { checkbox: d.casExemplaire === true },
  };

  const r = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${NOTION_KEY}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent: { database_id: BDD_ID }, properties: prop }),
  });
  const result = await r.json();
  if (result.object === 'error') return res.status(500).json(result);
  res.json({ success: true, id: result.id });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
