const NOTION_KEY = process.env.NOTION_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const BDD_ID    = process.env.NOTION_BDD_SOURCE_ID;

const KB_PAGES = [
  { id: '3665ebcd4f088101a391d4d9f1fe85d6', title: 'Règles générales' },
  { id: '3665ebcd4f08810187efe41854c1e027', title: 'Algorithme de recommandation' },
  { id: '3665ebcd4f088141a644c910c3c4a100', title: 'Argumentaires par situation' },
  { id: '3665ebcd4f0881b8b55cf6cc8f0d08f5', title: 'Objections fréquentes' },
  { id: '3665ebcd4f088196b2d3f59338b61ec4', title: 'Hiérarchie et prix des offres' },
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── Notion helpers ──────────────────────────────────────────────────────────

async function notionGet(path) {
  const r = await fetch(`https://api.notion.com/v1${path}`, {
    headers: {
      Authorization: `Bearer ${NOTION_KEY}`,
      'Notion-Version': '2022-06-28',
    },
  });
  return r.json();
}

async function notionPost(path, body) {
  const r = await fetch(`https://api.notion.com/v1${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NOTION_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return r.json();
}

function blocksToText(blocks = []) {
  return blocks.map(b => {
    const type = b.type;
    const c = b[type];
    const rt = txt => (c?.rich_text || []).map(t => t.plain_text).join('');

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

// ── Fetch KB ────────────────────────────────────────────────────────────────

async function fetchKB() {
  const sections = await Promise.all(
    KB_PAGES.map(async p => {
      const text = await fetchPageText(p.id);
      return `=== ${p.title} ===\n${text}`;
    })
  );
  return sections.join('\n\n');
}

// ── Fetch similar past cases ────────────────────────────────────────────────

async function fetchSimilarCases(zone) {
  const data = await notionPost(`/databases/${BDD_ID}/query`, {
    filter: zone ? { property: 'Zone', select: { equals: zone } } : undefined,
    sorts: [{ property: 'Cas exemplaire', direction: 'descending' }],
    page_size: 6,
  });

  return (data.results || []).map(p => {
    const pr = p.properties;
    const txt = key => pr[key]?.rich_text?.[0]?.plain_text || '';
    const num = key => pr[key]?.number ?? '';
    const sel = key => pr[key]?.select?.name || '';
    return {
      account: pr["Nom de l'account"]?.title?.[0]?.plain_text || '',
      zone: sel('Zone'),
      offerActuel: sel('Offer type actuel'),
      offerPropose: sel('Offer type proposé'),
      healthScore: num('Health Score'),
      pageviews: sel('Pageviews Search Overview'),
      discountPropose: num('Discount proposé'),
      argument: txt('Argument principal'),
      retour: txt('Retour du client'),
      exemplaire: pr['Cas exemplaire']?.checkbox || false,
    };
  });
}

// ── Gemini call ─────────────────────────────────────────────────────────────

async function callGemini(prompt) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 1200 },
      }),
    }
  );
  const d = await r.json();
  return d.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const client = JSON.parse(event.body);

  const [kb, cases] = await Promise.all([
    fetchKB(),
    fetchSimilarCases(client.zone),
  ]);

  const casesText = cases.length
    ? cases.map(c =>
        `${c.exemplaire ? '⭐' : '-'} ${c.account} (${c.zone}) | HS: ${c.healthScore}% | Pageviews: ${c.pageviews} | ${c.offerActuel} → ${c.offerPropose} | -${c.discountPropose}% | Argument: ${c.argument}${c.retour ? ` | Retour client: ${c.retour}` : ''}`
      ).join('\n')
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

  let recommendation;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    recommendation = JSON.parse(match ? match[0] : raw);
  } catch {
    recommendation = { error: 'Parsing error', raw };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify(recommendation) };
};
