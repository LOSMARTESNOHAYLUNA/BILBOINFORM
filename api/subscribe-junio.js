// /api/subscribe-junio.js
// Maneja las reservas de plaza gratuita para el 2º Evento Club Élite (18 junio)
// Suscribe a Brevo (lista 7) con atributos específicos para segmentar el evento

export default async function handler(req, res) {
  // CORS básico
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { nombre, email, telefono, empresa } = req.body || {};

  // Validaciones básicas
  if (!nombre || !email || !telefono || !empresa) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'El email no es válido' });
  }

  const BREVO_API_KEY = process.env.BREVO_API_KEY;
  const BREVO_LIST_ID = parseInt(process.env.BREVO_LIST_ID || '7', 10);

  if (!BREVO_API_KEY) {
    console.error('Falta BREVO_API_KEY en variables de entorno');
    return res.status(500).json({ error: 'Error de configuración del servidor' });
  }

  // Separar nombre y apellido
  const partes = nombre.trim().split(/\s+/);
  const FIRSTNAME = partes[0] || '';
  const LASTNAME = partes.slice(1).join(' ') || '';

  // Limpiar teléfono para SMS (formato internacional)
  let smsLimpio = telefono.replace(/\s|-/g, '');
  if (!smsLimpio.startsWith('+')) {
    // Si empieza por 6, 7 o 9 (móviles españoles) y no tiene prefijo, añadir +34
    if (/^[679]\d{8}$/.test(smsLimpio)) {
      smsLimpio = '+34' + smsLimpio;
    }
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': BREVO_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        email: email.toLowerCase().trim(),
        attributes: {
          FIRSTNAME,
          LASTNAME,
          SMS: smsLimpio,
          EMPRESA: empresa.trim(),
          EVENTO: 'junio_2026',
          TIPO_ENTRADA: 'gratuita_cliente',
          FECHA_INSCRIPCION: new Date().toISOString().split('T')[0]
        },
        listIds: [BREVO_LIST_ID],
        updateEnabled: true
      })
    });

    const data = await response.json();

    if (!response.ok) {
      // Brevo devuelve 400 si el contacto ya existe sin updateEnabled,
      // o errores específicos. Logueamos pero devolvemos mensaje genérico.
      console.error('Brevo error:', response.status, data);

      // Si es duplicado pero con updateEnabled debería actualizar; si llega aquí
      // probablemente sea un atributo mal nombrado o validación
      if (data.code === 'duplicate_parameter') {
        // Tratarlo como éxito: ya estaba inscrito
        return res.status(200).json({ ok: true, mensaje: 'Plaza confirmada' });
      }

      return res.status(500).json({ error: 'No hemos podido completar la inscripción' });
    }

    return res.status(200).json({ ok: true, mensaje: 'Plaza confirmada' });

  } catch (err) {
    console.error('Error inesperado:', err);
    return res.status(500).json({ error: 'Error al procesar la solicitud' });
  }
}
