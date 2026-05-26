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

// Notion page IDs des templates email par AM (nom résolu depuis amMapping)
const EMAIL_TEMPLATE_PAGES = {
  'Margaux Masraff':  '3685ebcd4f0881258d2df0bbd696041a',
  'Tom Dumas':        '3685ebcd4f0881f6931cd657870f3f17',
  'Steven Sandana':   '3685ebcd4f08817689d2cfbe6e88162b',
  'Aurore Mauguin':   '3685ebcd4f0881b297dfdbdf2cd102d5',
  'Jason Decotter':   '3685ebcd4f08817492e3eaf2dc501287',
};

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

// Parse les blocs Notion d'une page AM pour extraire tutoiement/vouvoiement
// selon le type de négo (heading_2) et la formule (heading_3)
function parseEmailTemplate(blocks, negType) {
  const norm = s => (s || '').toLowerCase().trim()
    .replace('up-sell', 'upsell').replace('down-sell', 'downsell');
  const aliases = {
    'renouvellement': 'renouvellement', 'incoming churn': 'incoming churn',
    'upsell': 'upsell', 'downsell': 'downsell', 'first contact': 'first contact',
  };
  const target = aliases[norm(negType)] || norm(negType) || 'renouvellement';

  let inSec = false, inTuto = false, inVou = false;
  const tuto = [], vou = [];

  for (const block of blocks) {
    const type = block.type;
    const c = block[type];
    const rt = () => (c?.rich_text || []).map(t => t.plain_text).join('');

    if (type === 'heading_2') {
      if (inSec) break; // section suivante = on arrête
      if ((aliases[norm(rt())] || norm(rt())) === target) { inSec = true; inTuto = false; inVou = false; }
      continue;
    }
    if (type === 'heading_3' && inSec) {
      const h = rt().toLowerCase();
      inTuto = h.includes('tuto');
      inVou  = h.includes('vouvoi') || (h.includes('vous') && !h.includes('tuto'));
      continue;
    }
    if (!inSec) continue;

    let line;
    if (['paragraph', 'quote', 'callout'].includes(type)) line = rt(); // '' = ligne vide volontaire
    else if (['bulleted_list_item', 'numbered_list_item'].includes(type)) line = `• ${rt()}`;
    else if (type === 'divider') line = '─'.repeat(45);
    else continue;

    if (inTuto) tuto.push(line);
    if (inVou)  vou.push(line);
  }

  const trim = lines => {
    let s = 0, e = lines.length - 1;
    while (s <= e && !lines[s]) s++;
    while (e >= s && !lines[e]) e--;
    return s > e ? null : lines.slice(s, e + 1).join('\n');
  };
  return { tutoiement: trim(tuto), vouvoiement: trim(vou) };
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
  const mapping = {};
  // Les table_row sont enfants du bloc table, pas directement de la page
  const pageBlocks = await notionGet(`/blocks/${AM_MAPPING_PAGE_ID}/children?page_size=100`);
  for (const block of (pageBlocks.results || [])) {
    if (block.type !== 'table') continue;
    const tableRows = await notionGet(`/blocks/${block.id}/children?page_size=100`);
    for (const row of (tableRows.results || [])) {
      if (row.type !== 'table_row') continue;
      const cells = row.table_row?.cells || [];
      const id   = cells[0]?.map(t => t.plain_text).join('').trim();
      const name = cells[1]?.map(t => t.plain_text).join('').trim();
      if (id && name && id !== 'ID Salesforce') mapping[id] = name;
    }
  }
  res.json(mapping);
});

app.get('/email-template', async (req, res) => {
  const { amName, negType } = req.query;
  const pageId = EMAIL_TEMPLATE_PAGES[amName]
    || EMAIL_TEMPLATE_PAGES[Object.keys(EMAIL_TEMPLATE_PAGES).find(k => k.toLowerCase() === (amName || '').toLowerCase())];
  if (!pageId) return res.json({ tutoiement: null, vouvoiement: null });
  try {
    const data = await notionGet(`/blocks/${pageId}/children?page_size=200`);
    res.json(parseEmailTemplate(data.results || [], negType));
  } catch (e) {
    res.json({ tutoiement: null, vouvoiement: null });
  }
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

app.post('/send-slack', async (req, res) => {
  const webhookUrl = process.env.ZAPIER_WEBHOOK_THREAD;
  if (!webhookUrl) return res.status(500).json({ error: 'ZAPIER_WEBHOOK_THREAD not configured' });
  const r = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req.body),
  });
  res.json({ success: r.ok });
});

app.post('/create-front-draft', async (req, res) => {
  const FRONT_TOKEN   = process.env.FRONTAPP_KEY;
  const FRONT_CHANNEL = process.env.FRONTAPP_CHANNEL_ID;
  if (!FRONT_TOKEN) return res.status(500).json({ error: 'FRONTAPP_KEY not configured' });

  const { subject, body, amName: amNameReq } = req.body;

  const frontGet = path => fetch(`https://api2.frontapp.com${path}`, {
    headers: { Authorization: `Bearer ${FRONT_TOKEN}`, Accept: 'application/json' },
  }).then(r => r.json());

  try {
    const norm = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const TEST_EMAIL = process.env.FRONTAPP_TEST_EMAIL;

    // ── 1. Trouver l'AM + son channel perso ──────────────────────────────────
    const [td, cd] = await Promise.all([
      frontGet('/teammates?limit=100'),
      frontGet('/channels?limit=100'),
    ]);
    console.log('[Front] teammates API:', JSON.stringify(td).slice(0, 200));
    console.log('[Front] channels API:', JSON.stringify(cd).slice(0, 300));
    const teammates = td._results || [];
    const channels  = cd._results || [];
    console.log(`[Front] ${teammates.length} teammates, ${channels.length} channels — TEST_EMAIL=${TEST_EMAIL||'(none)'}`);

    let channelId = FRONT_CHANNEL;
    let authorId;

    // Si FRONTAPP_TEST_EMAIL est défini, on force ce channel (mode test)
    if (TEST_EMAIL && !channelId) {
      const ch = channels.find(c =>
        c.settings?.address?.toLowerCase() === TEST_EMAIL.toLowerCase()
      );
      if (ch) channelId = ch.id;
      const tm = teammates.find(t => t.email?.toLowerCase() === TEST_EMAIL.toLowerCase());
      if (tm) authorId = tm.id;
    } else if (amNameReq) {
      // Trouver le teammate par nom complet
      const tm = teammates.find(t =>
        norm(`${t.first_name} ${t.last_name}`) === norm(amNameReq) ||
        norm(t.username) === norm(amNameReq)
      );
      if (tm) {
        authorId = tm.id;
        if (!channelId && tm.email) {
          const ch = channels.find(c =>
            c.settings?.address?.toLowerCase() === tm.email.toLowerCase()
          );
          if (ch) channelId = ch.id;
        }
      }
    }

    // Fallback : premier channel email si rien trouvé
    if (!channelId) {
      const ch = channels.find(c => ['smtp', 'gmail', 'microsoft365'].includes(c.type))
               || channels.find(c => c.type !== 'custom')
               || channels[0];
      if (!ch) return res.status(500).json({ error: 'Aucun channel Front trouvé' });
      channelId = ch.id;
    }

    // ── 2. Créer le brouillon dans la boîte perso de l'AM ────────────────────
    const payload = {
      subject,
      body: body.replace(/\n/g, '<br>'),
      to: [],
      ...(authorId ? { author_id: authorId } : {}),
    };
    console.log(`[Front] channelId=${channelId} authorId=${authorId||'(none)'}`);
    console.log('[Front] draft payload:', JSON.stringify({ ...payload, body: payload.body.slice(0,80)+'…' }));
    const dr = await fetch(`https://api2.frontapp.com/channels/${channelId}/drafts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${FRONT_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const draft = await dr.json();
    console.log('[Front] draft response:', JSON.stringify(draft).slice(0, 400));
    if (!draft._links) return res.status(500).json({ error: 'Erreur API Front', details: draft });
    res.json({ url: draft._links.front || draft._links.self });
  } catch (e) {
    console.error('[Front] exception:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/front-debug', async (req, res) => {
  const FRONT_TOKEN = process.env.FRONTAPP_KEY;
  const TEST_EMAIL  = process.env.FRONTAPP_TEST_EMAIL;

  // Diagnostic sans révéler la valeur complète
  const allKeys = Object.keys(process.env).sort();
  const tokenInfo = {
    defined: !!FRONT_TOKEN,
    length: FRONT_TOKEN ? FRONT_TOKEN.length : 0,
    preview: FRONT_TOKEN ? FRONT_TOKEN.slice(0, 12) + '…' : '(vide)',
    testEmail: TEST_EMAIL || '(non défini)',
    keysContainingFront: allKeys.filter(k => k.toLowerCase().includes('front')),
    allCustomKeys: allKeys.filter(k => !k.startsWith('npm_') && !k.startsWith('NODE') && !k.startsWith('PATH') && !k.startsWith('HOME') && !k.startsWith('PWD') && !k.startsWith('RAILWAY')),
  };
  if (!FRONT_TOKEN) return res.json({ error: 'FRONTAPP_KEY non définie sur Railway', diagnostic: tokenInfo });
  const frontGet = path => fetch(`https://api2.frontapp.com${path}`, {
    headers: { Authorization: `Bearer ${FRONT_TOKEN}`, Accept: 'application/json' },
  }).then(r => r.json());
  try {
    const [td, cd] = await Promise.all([frontGet('/teammates?limit=100'), frontGet('/channels?limit=100')]);
    const channels  = (cd._results || []).map(c => ({ id: c.id, type: c.type, address: c.settings?.address }));
    const teammates = (td._results || []).map(t => ({ id: t.id, name: `${t.first_name} ${t.last_name}`, email: t.email }));
    const matchedChannel = TEST_EMAIL
      ? channels.find(c => c.address?.toLowerCase() === TEST_EMAIL.toLowerCase())
      : null;
    res.json({ ok: true, TEST_EMAIL, matchedChannel, channels, teammates });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
