/**
 * Educaty — lead forwarder
 * --------------------------------------------------------------------
 * Принимает POST {name, phone, form, page, ts, utm} от формы лендинга,
 * раскладывает заявку в Telegram-чат и в amoCRM.
 *
 * Развёртывается как Cloudflare Worker (бесплатно):
 *   1) Создать новый Worker на dash.cloudflare.com → Workers & Pages → Create
 *   2) Вставить этот код, нажать Deploy.
 *   3) В Settings → Variables добавить переменные:
 *        TELEGRAM_BOT_TOKEN  — токен бота из @BotFather (вида 123:ABC…)
 *        TELEGRAM_CHAT_ID    — id чата куда слать (например -1001942201905)
 *        AMOCRM_WEBHOOK_URL  — URL входящего вебхука amoCRM (опционально)
 *        ALLOWED_ORIGIN      — домен, откуда принимаем POST (напр. https://educaty.ru)
 *   4) URL воркера вставить в index.html → LEAD_ENDPOINT.
 *
 * То же самое работает на Vercel / Netlify Functions / Bun / Node — суть та же,
 * просто сменить заголовки/типы.
 */

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405, cors);
    }

    let lead;
    try { lead = await request.json(); }
    catch { return json({ ok: false, error: "Bad JSON" }, 400, cors); }

    // лёгкая валидация
    const name  = String(lead.name  || "").trim().slice(0, 120);
    const phone = String(lead.phone || "").trim().slice(0, 40);
    if (!name || !phone) {
      return json({ ok: false, error: "name and phone required" }, 400, cors);
    }

    const meta = {
      form: lead.form || "form",
      page: lead.page || "",
      ts:   lead.ts   || new Date().toISOString(),
      utm:  lead.utm  || {},
      ua:   request.headers.get("user-agent") || "",
      ip:   request.headers.get("cf-connecting-ip") || "",
    };

    // отправляем параллельно
    const results = await Promise.allSettled([
      sendTelegram(env, name, phone, meta),
      sendAmoCRM(env, name, phone, meta),
    ]);

    const tg   = results[0].status === "fulfilled" ? results[0].value : { ok:false, error:String(results[0].reason) };
    const amo  = results[1].status === "fulfilled" ? results[1].value : { ok:false, error:String(results[1].reason) };

    return json({ ok: true, telegram: tg, amocrm: amo }, 200, cors);
  },
};

/* ------------------------------ Telegram ------------------------------ */
async function sendTelegram(env, name, phone, meta) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return { ok: false, error: "telegram env not configured" };
  }
  const lines = [
    `<b>🎓 Заявка на мастер-класс</b>`,
    `<b>Имя:</b> ${escapeHtml(name)}`,
    `<b>Телефон:</b> ${escapeHtml(phone)}`,
    `<b>Форма:</b> ${escapeHtml(meta.form)}`,
    meta.page ? `<b>Страница:</b> ${escapeHtml(meta.page)}` : "",
    meta.utm && Object.keys(meta.utm).length
      ? `<b>UTM:</b> ${escapeHtml(JSON.stringify(meta.utm))}`
      : "",
    `<i>${escapeHtml(meta.ts)}</i>`,
  ].filter(Boolean).join("\n");

  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: lines,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body };
}

/* ------------------------------ amoCRM (API v4) ------------------------------ */
// Создаёт связку «контакт + сделка» в amoCRM через REST API v4.
// Требует переменные:
//   AMOCRM_SUBDOMAIN          — например 'painty' (адрес https://painty.amocrm.ru)
//   AMOCRM_TOKEN              — долгоживущий токен из настроек интеграции
//   AMOCRM_PIPELINE_ID        — id воронки (число)
//   AMOCRM_STATUS_NAME        — необязательно, имя этапа (по умолчанию «Новый лид»)
//   AMOCRM_STATUS_ID          — необязательно, если знаете id этапа — подставит без поиска
//   AMOCRM_RESPONSIBLE_USER_ID — необязательно, id ответственного менеджера
async function sendAmoCRM(env, name, phone, meta) {
  if (!env.AMOCRM_SUBDOMAIN || !env.AMOCRM_TOKEN) {
    return { ok: false, error: "amocrm not configured" };
  }
  const base = `https://${env.AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4`;
  const headers = {
    "Authorization": `Bearer ${env.AMOCRM_TOKEN}`,
    "Content-Type":  "application/json",
  };
  const pipelineId = parseInt(env.AMOCRM_PIPELINE_ID || "0", 10) || null;

  // 1) status_id — берём явно, либо ищем по имени в воронке
  let statusId = parseInt(env.AMOCRM_STATUS_ID || "0", 10) || null;
  if (!statusId && pipelineId) {
    const wanted = (env.AMOCRM_STATUS_NAME || "Новый лид").toLowerCase();
    try {
      const r = await fetch(`${base}/leads/pipelines/${pipelineId}/statuses`, { headers });
      if (!r.ok) {
        const txt = await r.text();
        return { ok: false, error: `statuses lookup ${r.status}`, body: txt.slice(0, 200) };
      }
      const data = await r.json();
      const found = (data._embedded?.statuses || []).find(
        s => (s.name || "").toLowerCase() === wanted
      );
      if (!found) {
        return { ok: false, error: `status "${env.AMOCRM_STATUS_NAME || "Новый лид"}" not found in pipeline ${pipelineId}` };
      }
      statusId = found.id;
    } catch (e) {
      return { ok: false, error: `statuses lookup error: ${String(e)}` };
    }
  }

  // 2) Создаём связку сделка + контакт
  const lead = {
    name: name,
    _embedded: {
      tags: [{ name: "ai-creator" }, { name: "landing" }],
      contacts: [{
        name: name,
        custom_fields_values: [{
          field_code: "PHONE",
          values: [{ value: phone, enum_code: "MOB" }],
        }],
      }],
    },
  };
  if (pipelineId) lead.pipeline_id = pipelineId;
  if (statusId)   lead.status_id   = statusId;
  const responsibleId = parseInt(env.AMOCRM_RESPONSIBLE_USER_ID || "0", 10) || null;
  if (responsibleId) {
    lead.responsible_user_id = responsibleId;
    // также назначаем менеджера на контакт
    lead._embedded.contacts[0].responsible_user_id = responsibleId;
  }

  const r = await fetch(`${base}/leads/complex`, {
    method: "POST",
    headers,
    body: JSON.stringify([lead]),
  });
  const txt = await r.text();
  let parsed;
  try { parsed = JSON.parse(txt); } catch { parsed = txt.slice(0, 500); }
  if (!r.ok) {
    return { ok: false, status: r.status, body: parsed };
  }

  // 3) Прикладываем примечание с источником/UTM (best effort)
  const leadId = Array.isArray(parsed) ? parsed[0]?.id : null;
  if (leadId) {
    const noteText = [
      meta.page ? `Источник: ${meta.page}` : null,
      meta.utm && Object.keys(meta.utm).length ? `UTM: ${JSON.stringify(meta.utm)}` : null,
      meta.ua ? `UA: ${meta.ua}` : null,
      meta.ip ? `IP: ${meta.ip}` : null,
    ].filter(Boolean).join("\n");
    if (noteText) {
      // не ждём — если упадёт, заявку всё равно создали
      fetch(`${base}/leads/${leadId}/notes`, {
        method: "POST",
        headers,
        body: JSON.stringify([{ note_type: "common", params: { text: noteText } }]),
      }).catch(() => {});
    }
  }

  return { ok: true, status: r.status, leadId, body: parsed };
}

/* ------------------------------ helpers ------------------------------ */
function corsHeaders(env, request) {
  const allowed = (env.ALLOWED_ORIGIN || "*").split(",").map(s => s.trim());
  const origin = request.headers.get("origin") || "";
  const allow  = allowed.includes("*") || allowed.includes(origin) ? (allowed.includes("*") ? "*" : origin) : allowed[0];
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  };
}
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
