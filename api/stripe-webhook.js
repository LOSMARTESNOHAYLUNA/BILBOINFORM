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

async function syncContactToBrevo({
  email,
  name,
  phone,
  amountTotal,
  eventKey,
  eventLabel,
  promotionsConsent,
}) {
  const BREVO_API_KEY = process.env.BREVO_API_KEY;
  const BREVO_CLUB_ELITE_LIST_ID = parseInt(process.env.BREVO_CLUB_ELITE_LIST_ID, 10);

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

  const payload = {
    email: email.toLowerCase().trim(),
    attributes,
    listIds: [BREVO_CLUB_ELITE_LIST_ID],
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

  if (!response.ok && response.status !== 204) {
    const errorBody = await response.text();
    let parsedError;
    try {
      parsedError = JSON.parse(errorBody);
    } catch {
      parsedError = errorBody;
    }
    // Edge case: si llega aquí con duplicate_parameter pese a updateEnabled,
    // lo tratamos como éxito (ya estaba registrado).
    if (parsedError?.code === 'duplicate_parameter') {
      console.log('Contacto ya existía, actualizado:', email);
      return { ok: true, updated: true };
    }
    throw new Error(`Brevo ${response.status}: ${JSON.stringify(parsedError)}`);
  }

  return { ok: true };
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
    await syncContactToBrevo({
      email,
      name,
      phone,
      amountTotal,
      eventKey: BREVO_EVENT_KEY,
      eventLabel: BREVO_EVENT_SLUG,
      promotionsConsent,
    });
    console.log(
      `Sync OK: ${email} (${amountTotal === 0 ? 'cliente' : 'no cliente'}, consent: ${promotionsConsent}, evento: ${BREVO_EVENT_SLUG})`
    );
    return res.status(200).json({ received: true, synced: email });
  } catch (err) {
    console.error('Brevo sync failed for', email, '-', err.message);
    // Devolvemos 200 igualmente: Stripe reintentaría hasta 3 días si recibe 5xx,
    // y eso solo causaría más errores. El fallo queda en logs de Vercel.
    return res.status(200).json({ received: true, error: err.message });
  }
}
