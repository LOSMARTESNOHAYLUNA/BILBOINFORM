// /api/stripe-webhook.js
// Webhook de Stripe → sincroniza compradores con Brevo
// Captura compras del Club Élite (gratuitas con código y de pago) y mete los
// contactos en la lista maestra de Brevo con sus atributos correspondientes.
//
// Variables de entorno necesarias (Vercel):
//   STRIPE_SECRET_KEY              sk_live_... (sk_test_... en modo test)
//   STRIPE_WEBHOOK_SECRET          whsec_... (se obtiene al crear el webhook en Stripe)
//   BREVO_API_KEY                  (ya existe)
//   BREVO_CLUB_ELITE_LIST_ID       ID numérico de la lista maestra "Club Élite — Asistentes"
//   BREVO_EVENT_KEY                Nombre del atributo booleano del evento actual
//                                  (ej: EVENTO_OCTUBRE_2026)
//   BREVO_EVENT_SLUG               Valor del atributo ULTIMO_EVENTO del evento actual
//                                  (ej: octubre_2026)

import Stripe from 'stripe';

// Vercel: necesitamos el body en bruto (Buffer) para verificar la firma de Stripe.
// Si Vercel parsea el JSON antes, la firma falla.
export const config = {
  api: { bodyParser: false },
};

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function normalizePhone(phone) {
  if (!phone) return '';
  const cleaned = phone.replace(/[\s\-\(\)]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('00')) return '+' + cleaned.slice(2);
  // Móvil/fijo español sin prefijo → añadimos +34
  if (/^[679]\d{8}$/.test(cleaned)) return '+34' + cleaned;
  return cleaned;
}

function splitName(fullName) {
  if (!fullName) return { FIRSTNAME: '', LASTNAME: '' };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { FIRSTNAME: parts[0], LASTNAME: '' };
  return {
    FIRSTNAME: parts[0],
    LASTNAME: parts.slice(1).join(' '),
  };
}

// PASO 1 — Crear o actualizar el contacto con sus atributos.
// Nota: NO pasamos listIds aquí porque Brevo ignora silenciosamente la
// asignación a listas cuando el contacto ya existe en otras listas.
// La asignación a la lista la hacemos aparte en el paso 2.
async function upsertBrevoContact({ email, attributes }) {
  const BREVO_API_KEY = process.env.BREVO_API_KEY;

  const payload = {
    email: email.toLowerCase().trim(),
    attributes,
    updateEnabled: true,
  };

  const response = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'api-key': BREVO_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const bodyText = await response.text();
  console.log(`[Brevo upsert] ${response.status} ${response.statusText || ''} — body: ${bodyText || '(empty)'}`);

  if (response.status === 204) {
    // Contacto existía y se actualizó
    return { ok: true, existed: true };
  }
  if (response.status === 201) {
    // Contacto nuevo creado
    return { ok: true, existed: false };
  }
  if (response.ok) {
    return { ok: true, existed: null };
  }

  // Error
  let parsedError;
  try {
    parsedError = JSON.parse(bodyText);
  } catch {
    parsedError = { raw: bodyText };
  }
  throw new Error(`Brevo upsert ${response.status}: ${JSON.stringify(parsedError)}`);
}

// PASO 2 — Añadir el contacto a la lista concreta.
// Endpoint específico que sí funciona con contactos existentes.
async function addContactToBrevoList({ email, listId }) {
  const BREVO_API_KEY = process.env.BREVO_API_KEY;

  const url = `https://api.brevo.com/v3/contacts/lists/${listId}/contacts/add`;
  const requestBody = { emails: [email.toLowerCase().trim()] };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'api-key': BREVO_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  const bodyText = await response.text();
  console.log(`[Brevo addToList ${listId}] ${response.status} — sent: ${JSON.stringify(requestBody)} — body: ${bodyText || '(empty)'}`);

  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = { raw: bodyText };
  }

  // Éxito directo (201): contacto añadido a la lista
  if (response.ok) {
    // Brevo devuelve { contacts: { success: [...], failure: [...] } }
    const success = Array.isArray(parsed?.contacts?.success) ? parsed.contacts.success : [];
    const failure = Array.isArray(parsed?.contacts?.failure) ? parsed.contacts.failure : [];
    if (failure.length > 0 && success.length === 0) {
      // Todos fallaron aunque el status es 2xx
      throw new Error(`Brevo addToList todos los emails fallaron: ${JSON.stringify(failure)}`);
    }
    return { ok: true, added: success.length > 0, failures: failure };
  }

  // 400 con mensaje explícito de "already in list"
  if (
    response.status === 400 &&
    typeof parsed?.message === 'string' &&
    parsed.message.toLowerCase().includes('already in list')
  ) {
    return { ok: true, alreadyInList: true };
  }

  // Cualquier otro error se lanza para que quede en el log
  throw new Error(`Brevo addToList ${response.status} — ${JSON.stringify(parsed)}`);
}

// Sync completo del contacto: upsert de atributos + añadir a lista
async function syncContactToBrevo({
  email,
  name,
  phone,
  amountTotal,
  eventKey,
  eventLabel,
  promotionsConsent,
}) {
  const BREVO_CLUB_ELITE_LIST_ID = parseInt(
    process.env.BREVO_CLUB_ELITE_LIST_ID,
    10
  );

  console.log(`[Sync inicio] email=${email} listId=${BREVO_CLUB_ELITE_LIST_ID} eventKey=${eventKey} eventLabel=${eventLabel}`);

  const { FIRSTNAME, LASTNAME } = splitName(name);
  const SMS = normalizePhone(phone);
  const isClient = amountTotal === 0;
  const today = new Date().toISOString().split('T')[0];

  const attributes = {
    FIRSTNAME,
    LASTNAME,
    [eventKey]: true,                    // ej: EVENTO_OCTUBRE_2026 = true
    ES_CLIENTE_BILBOINFORM: isClient,
    IMPORTE_PAGADO: amountTotal / 100,   // de céntimos a euros
    ULTIMO_EVENTO: eventLabel,
    CONSENT_MARKETING: promotionsConsent,
    FECHA_ULTIMA_INSCRIPCION: today,
  };

  if (SMS) attributes.SMS = SMS;

  // Paso 1: crear/actualizar contacto con atributos
  const upsertResult = await upsertBrevoContact({ email, attributes });

  // Paso 2: asegurarnos de que está en la lista Club Élite
  const listResult = await addContactToBrevoList({
    email,
    listId: BREVO_CLUB_ELITE_LIST_ID,
  });

  return {
    ok: true,
    contactExisted: upsertResult.existed,
    addedToList: listResult.added || false,
    alreadyInList: listResult.alreadyInList || false,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  const BREVO_API_KEY = process.env.BREVO_API_KEY;
  const BREVO_CLUB_ELITE_LIST_ID = process.env.BREVO_CLUB_ELITE_LIST_ID;
  const BREVO_EVENT_KEY = process.env.BREVO_EVENT_KEY;
  const BREVO_EVENT_SLUG = process.env.BREVO_EVENT_SLUG;

  // Comprobamos que todas las variables de entorno están listas
  if (
    !STRIPE_SECRET_KEY ||
    !STRIPE_WEBHOOK_SECRET ||
    !BREVO_API_KEY ||
    !BREVO_CLUB_ELITE_LIST_ID ||
    !BREVO_EVENT_KEY ||
    !BREVO_EVENT_SLUG
  ) {
    console.error('Falta alguna variable de entorno requerida:', {
      hasStripeKey: !!STRIPE_SECRET_KEY,
      hasWebhookSecret: !!STRIPE_WEBHOOK_SECRET,
      hasBrevoKey: !!BREVO_API_KEY,
      hasBrevoListId: !!BREVO_CLUB_ELITE_LIST_ID,
      hasEventKey: !!BREVO_EVENT_KEY,
      hasEventSlug: !!BREVO_EVENT_SLUG,
    });
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  // Verificamos que el webhook viene de Stripe de verdad (firma)
  const signature = req.headers['stripe-signature'];
  if (!signature) {
    return res.status(400).json({ error: 'Missing stripe-signature header' });
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY);
  let event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  // Solo procesamos las compras finalizadas
  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true, ignored: event.type });
  }

  const session = event.data.object;

  // Datos del comprador
  const email = session.customer_details?.email || session.customer_email;
  const name = session.customer_details?.name || '';
  const phone = session.customer_details?.phone || '';
  const amountTotal = session.amount_total ?? 0; // céntimos
  const promotionsConsent = session.consent?.promotions === 'opt_in';

  if (!email) {
    console.error('Webhook sin email en session:', session.id);
    return res.status(200).json({ received: true, error: 'no_email' });
  }

  // El evento actual se define por variables de entorno en Vercel
  // (BREVO_EVENT_KEY y BREVO_EVENT_SLUG). Para el próximo evento solo hay
  // que cambiar las variables en Vercel y redesplegar; no toca código.
  try {
    const result = await syncContactToBrevo({
      email,
      name,
      phone,
      amountTotal,
      eventKey: BREVO_EVENT_KEY,
      eventLabel: BREVO_EVENT_SLUG,
      promotionsConsent,
    });
    console.log(
      `Sync OK: ${email} (${amountTotal === 0 ? 'cliente' : 'no cliente'}, consent: ${promotionsConsent}, evento: ${BREVO_EVENT_SLUG}, existed: ${result.contactExisted}, addedToList: ${result.addedToList}, alreadyInList: ${result.alreadyInList})`
    );
    return res.status(200).json({ received: true, synced: email, ...result });
  } catch (err) {
    console.error('Brevo sync failed for', email, '-', err.message);
    // Devolvemos 200 igualmente: Stripe reintentaría hasta 3 días si recibe 5xx,
    // y eso solo causaría más errores. El fallo queda en logs de Vercel.
    return res.status(200).json({ received: true, error: err.message });
  }
}
