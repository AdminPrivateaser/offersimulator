const NOTION_KEY = process.env.NOTION_API_KEY;
const BDD_ID    = process.env.NOTION_BDD_SOURCE_ID;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const d = JSON.parse(event.body);

  const prop = {
    "Nom de l'account": { title: [{ text: { content: d.account || '' } }] },
    ...(d.zone            && { Zone:                          { select:     { name: d.zone } } }),
    ...(d.currentOffer    && { 'Offer type actuel':           { select:     { name: d.currentOffer } } }),
    ...(d.arr != null     && { 'ARR actuel':                  { number:     parseFloat(d.arr) } }),
    ...(d.mrr != null     && { 'MRR Actuel':                  { number:     parseFloat(d.mrr) } }),
    ...(d.currentDiscount != null && { 'Discount actuel':     { number:     parseFloat(d.currentDiscount) } }),
    ...(d.nextBilling     && { 'Next Billing date':           { date:       { start: d.nextBilling } } }),
    ...(d.contractEngagement && { 'Contract engagement':      { rich_text:  [{ text: { content: d.contractEngagement } }] } }),
    ...(d.healthScore != null && { 'Health Score':            { number:     parseFloat(d.healthScore) } }),
    ...(d.pageviews       && { 'Pageviews Search Overview':   { select:     { name: d.pageviews } } }),
    ...(d.renewalDate     && { 'Date de renouvellement effective': { date:  { start: d.renewalDate } } }),
    ...(d.proposedOffer   && { 'Offer type proposé':          { select:     { name: d.proposedOffer } } }),
    ...(d.proposedDiscount != null && { 'Discount proposé':   { number:     parseFloat(d.proposedDiscount) } }),
    ...(d.echeancier      && { Echéancier:                    { rich_text:  [{ text: { content: d.echeancier } }] } }),
    ...(d.argument        && { 'Argument principal':          { rich_text:  [{ text: { content: d.argument } }] } }),
    ...(d.retourClient    && { 'Retour du client':            { rich_text:  [{ text: { content: d.retourClient } }] } }),
    'Cas exemplaire': { checkbox: d.casExemplaire === true },
  };

  const r = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NOTION_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ parent: { database_id: BDD_ID }, properties: prop }),
  });

  const result = await r.json();

  if (result.object === 'error') {
    return { statusCode: 500, headers: CORS, body: JSON.stringify(result) };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, id: result.id }) };
};
