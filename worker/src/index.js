// El schedule nativo de GitHub Actions no es confiable: este Cron Trigger de Cloudflare
// dispara el workflow por la API de GitHub cada 30 minutos.

const GITHUB_REPO = "enginecpu1-cyber/bot-alquileres-almagro";
const GITHUB_WORKFLOW = "buscar-alquileres.yml";

async function dispatchGitHubWorkflow(env) {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "bot-alquileres-almagro-cron",
      },
      body: JSON.stringify({ ref: "master" }),
    }
  );
  if (!res.ok) console.error(`GitHub dispatch error ${res.status}: ${await res.text()}`);
}

export default {
  async fetch() {
    return new Response("ok", { status: 200 });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatchGitHubWorkflow(env));
  },
};
