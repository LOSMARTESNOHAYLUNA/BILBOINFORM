export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Método no permitido' });
  }

  const { nombre, empresa, email, telefono, sector, presenta } = req.body;

  if (!nombre || !empresa || !email || !telefono) {
    return res.status(400).json({ message: 'Faltan campos obligatorios' });
  }

  const payload = {
    email,
    attributes: {
      NOMBRE:           nombre,
      EMPRESA:          empresa,
      SMS:              telefono,
      SECTOR:           sector    || '',
      PRESENTA_NEGOCIO: presenta  || ''
    },
    listIds: [parseInt(process.env.BREVO_LIST_ID) || 7],
    updateEnabled: true
  };

  try {
    const brevoRes = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': process.env.BREVO_API_KEY
      },
      body: JSON.stringify(payload)
    });

    if (brevoRes.ok || brevoRes.status === 201 || brevoRes.status === 204) {
      return res.status(200).json({ ok: true });
    }

    const error = await brevoRes.json().catch(() => ({}));
    console.error('Brevo error:', error);
    return res.status(500).json({ message: error.message || 'Error al registrar contacto' });

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
}
