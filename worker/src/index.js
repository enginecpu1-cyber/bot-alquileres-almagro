// El schedule nativo de GitHub Actions no es confiable: este Cron Trigger de Cloudflare
// dispara el workflow por la API de GitHub cada 30 minutos.

const GITHUB_REPO = "enginecpu1-cyber/bot-alquileres-almagro";
const GITHUB_WORKFLOW = "buscar-alquileres.yml";

async function dispatchGitHubWorkflow(env, newChat) {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "bot-alquileres-almagro-cron",
      },
      body: JSON.stringify(newChat ? { ref: "master", inputs: { new_chat: String(newChat) } } : { ref: "master" }),
    }
  );
  if (!res.ok) console.error(`GitHub dispatch error ${res.status}: ${await res.text()}`);
}

const WELCOME =
  "¡Hola! Soy el bot de alquileres de Almagro 🏠\n\n" +
  "Te aviso por acá cada vez que aparece un monoambiente o 2 ambientes en Almagro, " +
  "hasta $800.000 con expensas (alquiler + expensas). Reviso cada 30 minutos.\n\n" +
  "Ya quedaste anotado: en un par de minutos te llegan los avisos nuevos.";

async function tgSend(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

// Webhook de Telegram: contesta al instante y dispara el workflow con el chat nuevo, que el
// scraper suma a chat_ids.json (con webhook activo getUpdates ya no sirve para registrar).
async function handleUpdate(env, update) {
  const msg = update.message;
  if (!msg || msg.chat.type !== "private") return;
  await tgSend(env, msg.chat.id, WELCOME);
  await dispatchGitHubWorkflow(env, msg.chat.id);
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("ok", { status: 200 });
    if (env.WEBHOOK_SECRET && request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
      return new Response("unauthorized", { status: 401 });
    }
    try {
      await handleUpdate(env, await request.json());
    } catch (err) {
      console.error(err);
    }
    return new Response("ok", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatchGitHubWorkflow(env));
  },
};
