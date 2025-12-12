// whatsapp/ia-cotizacion.js
import fs from 'fs';
import path from 'path';

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY ||
  process.env.OPENAI_API_KEY_NEW_CHEM ||
  '';

const OPENAI_COT_MODEL =
  process.env.OPENAI_COT_MODEL || 'gpt-4.1-mini';

const OPENAI_STT_MODEL =
  process.env.OPENAI_STT_MODEL || 'whisper-1'; 
const OPENAI_TTS_MODEL =
  process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
const OPENAI_TTS_VOICE =
  process.env.OPENAI_TTS_VOICE || 'alloy';
const OPENAI_TTS_FORMAT =
  process.env.OPENAI_TTS_FORMAT || 'mp3';

const KNOW_PATH = path.resolve('./knowledge/ia.json');

let KNOW_TEXT = '';
try {
  KNOW_TEXT = fs.readFileSync(KNOW_PATH, 'utf8');
  console.log('[COT-AI] Cargado conocimiento desde', KNOW_PATH);
} catch (e) {
  console.warn('[COT-AI] No se pudo cargar', KNOW_PATH, e.message);
}

export function startCotizacionAI(session, minutes = 60) {
  if (!session) return null;
  session.meta = session.meta || {};
  const until = Date.now() + minutes * 60 * 1000;
  session.meta.cotAIUntil = until;
  return until;
}

export function isCotizacionAIActive(session) {
  if (!session?.meta?.cotAIUntil) return false;
  return session.meta.cotAIUntil > Date.now();
}

export async function runCotizacionAI({ question, session }) {
  if (!OPENAI_API_KEY) {
    console.warn('[COT-AI] Falta OPENAI_API_KEY');
    return null;
  }
  if (!KNOW_TEXT) {
    console.warn('[COT-AI] JSON de conocimiento vacío/no encontrado');
    return null;
  }

  const nombre = session?.profileName || 'cliente';

  const systemContent = [
    'Eres el asistente de cotizaciones de *New Chem Agroquímicos* en Bolivia.',
    'Solo puedes responder usando la información del siguiente JSON de conocimiento de la empresa.',
    'Tu objetivo es resolver dudas sobre cotizaciones, productos, dosis, condiciones comerciales, mínimos de compra, formas de pago, entregas y garantías, y ayudar a cerrar la venta.',
    'Si la pregunta NO se puede responder con ese JSON, responde educadamente que solo estás entrenado para dudas sobre productos y cotizaciones de New Chem, y que un asesor humano puede ayudar en otros temas.',
    'Responde SIEMPRE en español neutro, en un máximo de 3–5 líneas, directo y claro.',
    'JSON de conocimiento (no lo muestres tal cual al cliente, solo úsalo como base):',
    KNOW_TEXT
  ].join('\n\n');

  const body = {
    model: OPENAI_COT_MODEL,
    temperature: 0.2,
    messages: [
      { role: 'system', content: systemContent },
      {
        role: 'user',
        content: `Nombre del cliente: ${nombre}\nPregunta del cliente: ${question}`
      }
    ]
  };

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      console.error(
        '[COT-AI] Error HTTP',
        resp.status,
        await resp.text().catch(() => '')
      );
      return null;
    }

    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch (e) {
    console.error('[COT-AI] Error llamando a OpenAI:', e);
    return null;
  }
}

export async function transcribeCotizacionAudio({
  audioBuffer,
  mimeType = 'audio/ogg',
  fileName = 'voz.ogg'
} = {}) {
  if (!OPENAI_API_KEY) {
    console.warn('[COT-AI] Falta OPENAI_API_KEY para STT');
    return null;
  }
  if (!audioBuffer) {
    console.warn('[COT-AI] transcribeCotizacionAudio sin audioBuffer');
    return null;
  }

  try {
    const form = new FormData();
    const blob = new Blob([audioBuffer], { type: mimeType });
    form.append('file', blob, fileName);
    form.append('model', OPENAI_STT_MODEL);
    form.append('language', 'es');
    form.append('response_format', 'json');

    const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: form
    });

    if (!resp.ok) {
      console.error(
        '[COT-AI] Error HTTP STT',
        resp.status,
        await resp.text().catch(() => '')
      );
      return null;
    }

    const data = await resp.json().catch(() => null);
    const text = data?.text?.trim();
    if (!text) {
      console.warn('[COT-AI] STT sin texto');
      return null;
    }
    return text;
  } catch (e) {
    console.error('[COT-AI] Error en STT:', e);
    return null;
  }
}

export async function synthesizeCotizacionAudio({
  text,
  voice = OPENAI_TTS_VOICE,
  format = OPENAI_TTS_FORMAT
} = {}) {
  if (!OPENAI_API_KEY) {
    console.warn('[COT-AI] Falta OPENAI_API_KEY para TTS');
    return null;
  }
  if (!text) return null;

  try {
    const body = {
      model: OPENAI_TTS_MODEL,
      input: text,
      voice,
      format
    };

    const resp = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      console.error(
        '[COT-AI] Error HTTP TTS',
        resp.status,
        await resp.text().catch(() => '')
      );
      return null;
    }

    const arr = await resp.arrayBuffer();
    return Buffer.from(arr);
  } catch (e) {
    console.error('[COT-AI] Error en TTS:', e);
    return null;
  }
}

export async function buildCotizacionAudioReply({
  audioBuffer,
  mimeType = 'audio/ogg',
  session
} = {}) {
  const questionText = await transcribeCotizacionAudio({
    audioBuffer,
    mimeType
  });

  if (!questionText) {
    return null;
  }

  const answerText = await runCotizacionAI({
    question: questionText,
    session
  });

  if (!answerText) {
    return {
      questionText,
      answerText: null,
      audioBuffer: null
    };
  }

  const ttsBuffer = await synthesizeCotizacionAudio({ text: answerText });

  return {
    questionText,
    answerText,
    audioBuffer: ttsBuffer || null
  };
}
