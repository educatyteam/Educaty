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

/* ------------------------------ amoCRM ------------------------------ */
async function sendAmoCRM(env, name, phone, meta) {
  if (!env.AMOCRM_WEBHOOK_URL) {
    return { ok: false, error: "amocrm webhook not configured" };
  }
  // amoCRM «Входящие вебхуки» принимает x-www-form-urlencoded с полями
  // contact[name], contact[phone], lead[name], lead[tags] и т.д.
  // Если используете «Salesbot» или «webhook → digital pipeline», поля будут
  // прокинуты в Salesbot Variables.
  const form = new URLSearchParams();
  form.set("contact[name]", name);
  form.set("contact[phone]", phone);
  form.set("lead[name]", `Заявка: ${meta.form}`);
  form.set("lead[tags]", "ai-creator,landing");
  form.set("lead[note]",
    `Источник: ${meta.page}\nUTM: ${JSON.stringify(meta.utm)}\nUA: ${meta.ua}\nIP: ${meta.ip}`);

  const r = await fetch(env.AMOCRM_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, body: text.slice(0, 500) };
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
