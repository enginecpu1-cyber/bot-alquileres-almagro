// Bot de alquileres: monoambiente o 2 ambientes en Almagro (CABA), hasta $800.000 CON expensas.
// Fuentes: MercadoLibre Inmuebles (HTTP) + Zonaprop (Chromium headless). Avisa por Telegram con foto.
// Corre vía GitHub Actions (ver .github/workflows/buscar-alquileres.yml).
//
// Fuentes que NO andan (verificado 2026-11-24): Argenprop (captcha), Properati (401),
// Inmuebles24 y Remax (403). Si alguna se destraba, agregarla en FUENTES de main().

const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

// --- Config ---

const TOTAL_MAX_ARS = 800_000; // alquiler + expensas
const MAX_AMBIENTES = 2; // monoambiente (1) a 2 ambientes
const BARRIO = "almagro";

const EXPENSAS_MIN_CREIBLE = 10_000;
const ML_PAGES = 3; // 48 avisos por página
const ZP_PAGES = 3; // 30 avisos por página, ordenados por más recientes

const STATE_FILE = path.join(__dirname, "sent_ids.json");
const CHATS_FILE = path.join(__dirname, "chat_ids.json");
const EXPENSAS_FILE = path.join(__dirname, "expensas_cache.json");

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Estado en disco ---

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}
function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Cualquiera que le escriba al bot (aunque sea "hola") queda sumado a los destinatarios,
// además de TELEGRAM_CHAT_ID. El offset de Telegram evita releer mensajes viejos.
async function refreshChatIds() {
  const state = loadJson(CHATS_FILE, { chatIds: [], lastUpdateId: 0 });
  const chatIds = new Set(state.chatIds);
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${state.lastUpdateId + 1}`
    );
    if (!res.ok) {
      console.error(`[telegram] getUpdates HTTP ${res.status}`);
      return [...chatIds];
    }
    const data = await res.json();
    if (!data.ok) return [...chatIds];
    let maxUpdateId = state.lastUpdateId;
    for (const update of data.result) {
      maxUpdateId = Math.max(maxUpdateId, update.update_id);
      const chat = update.message?.chat;
      if (chat && chat.type === "private") chatIds.add(String(chat.id));
    }
    saveJson(CHATS_FILE, { chatIds: [...chatIds], lastUpdateId: maxUpdateId });
  } catch (err) {
    console.error(`[telegram] getUpdates error: ${err.message}`);
  }
  return [...chatIds];
}

// --- Utilidades ---

const toInt = (s) => {
  const d = String(s || "").replace(/[^\d]/g, "");
  return d ? parseInt(d, 10) : null;
};

function formatMoney(n) {
  return "$" + n.toLocaleString("es-AR");
}

// Clave para detectar el mismo aviso publicado en dos portales: calle + altura + alquiler.
function placeKey(address, price) {
  const a = (address || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/\bentre\b|\besquina\b|,|\./)[0]
    .replace(/\b(al|av|avenida|calle)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const m = a.match(/^(.+?)\s+(\d{2,5})\b/);
  return m ? `${m[1].trim()} ${m[2]}|${price}` : null;
}

// --- MercadoLibre ---

function buildMLUrl(desde) {
  const base = `https://inmuebles.mercadolibre.com.ar/departamentos/alquiler/1-a-2-ambientes/capital-federal/${BARRIO}/`;
  const filtro = `_PriceRange_0ARS-${TOTAL_MAX_ARS}ARS`;
  return desde ? `${base}_Desde_${desde}${filtro}_NoIndex_True` : `${base}${filtro}`;
}

const NUM_PALABRA = { un: 1, uno: 1, dos: 2, tres: 3, cuatro: 4 };
function ambientesFrom(title, fromCard) {
  if (fromCard) return parseInt(fromCard, 10);
  if (/monoambiente|mono\s?amb/i.test(title)) return 1;
  const m = title.match(/(\d|un|uno|dos|tres|cuatro)\s*(?:amb|ambientes?)/i);
  if (!m) return null;
  const k = m[1].toLowerCase();
  return /^\d$/.test(k) ? parseInt(k, 10) : NUM_PALABRA[k];
}

function parseMLCards(html) {
  const $ = cheerio.load(html);
  const out = [];
  $("li.ui-search-layout__item").each((_, el) => {
    const card = $(el);
    const titleEl = card.find("a.poly-component__title").first();
    const title = titleEl.text().trim();
    const link = (titleEl.attr("href") || "").split("#")[0].split("?")[0];
    if (!title || !link) return;
    const idMatch = link.match(/MLA-?(\d+)/);
    if (!idMatch) return;

    const priceAria =
      card.find(".poly-price__current .andes-money-amount").first().attr("aria-label") || "";
    const text = card.text().replace(/\s+/g, " ");
    const amb = text.match(/(\d)\s*ambs?\./);
    const m2 = text.match(/(\d+)\s*m²/);
    const imgEl = card.find(".poly-component__picture").first();
    const img = imgEl.attr("data-src") || imgEl.attr("src") || null;

    out.push({
      id: `MLA${idMatch[1]}`,
      src: "MercadoLibre",
      title,
      link,
      rent: toInt(priceAria),
      currency: /d[oó]lar/i.test(priceAria) ? "USD" : "ARS",
      ambientes: ambientesFrom(title, amb && amb[1]),
      m2: m2 ? m2[1] : null,
      address: card.find(".poly-component__location").first().text().trim(),
      image: img && !img.startsWith("data:") ? img : null,
      expensas: undefined, // se completa leyendo la ficha
    });
  });
  return out;
}

async function fetchML() {
  const all = [];
  for (let page = 0; page < ML_PAGES; page++) {
    const url = buildMLUrl(page === 0 ? null : 1 + page * 48);
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, "Accept-Language": "es-AR,es;q=0.9" } });
      if (!res.ok) {
        console.error(`[ml] página ${page + 1}: HTTP ${res.status}`);
        break;
      }
      const body = await res.text();
      const cards = parseMLCards(body);
      if (cards.length === 0 && /suspicious-traffic/.test(body)) {
        console.error("[ml] bloqueado: MercadoLibre devuelve 'tráfico sospechoso' a IPs de datacenter (GitHub Actions). Funciona desde una PC residencial.");
        break;
      }
      if (cards.length === 0) {
        console.error(`[ml] página ${page + 1}: 0 tarjetas (HTTP ${res.status}, ${body.length} bytes, título: "${(body.match(/<title>([^<]*)/) || [])[1] || "?"}")`);
      }
      all.push(...cards);
      if (cards.length < 48) break;
    } catch (err) {
      console.error(`[ml] página ${page + 1}: ${err.message}`);
      break;
    }
    await sleep(500);
  }
  return all;
}

// Las expensas no vienen en la tarjeta: hay que abrir la ficha. Primero el dato estructurado
// ("Expensas","text":"140.000 ARS"); si no está, se busca en la descripción ("Expensas ...: $ 237.000").
async function fetchMLExpensas(link) {
  try {
    const res = await fetch(link, { headers: { "User-Agent": USER_AGENT, "Accept-Language": "es-AR,es;q=0.9" } });
    if (!res.ok) return null;
    const html = await res.text();
    // Expensas por debajo de $10.000 en CABA son un dato roto (ej. "157" por "157.000"): se ignoran.
    const plausible = (n) => (n != null && n >= EXPENSAS_MIN_CREIBLE ? n : null);
    const s = html.match(/"id":"Expensas","text":"([\d.,]+)\s*ARS"/);
    const fromField = s ? plausible(toInt(s[1])) : null;
    if (fromField != null) return fromField;
    const d = html.match(/expensas[^$\d<]{0,30}\$\s*([\d.]+)/i);
    return d ? plausible(toInt(d[1])) : null;
  } catch {
    return null;
  }
}

// --- Zonaprop (Chromium headless) ---
// Un contexto nuevo por página: con el mismo contexto, Cloudflare devuelve 403 desde la 2ª carga.

function parseZonaCards(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('[data-qa="posting PROPERTY"]').each((_, el) => {
    const card = $(el);
    const id = card.attr("data-id");
    const to = (card.attr("data-to-posting") || "").split("?")[0];
    if (!id || !to) return;
    const txt = (s) => card.find(s).first().text().replace(/\s+/g, " ").trim();
    const priceText = txt('[data-qa="POSTING_CARD_PRICE"]');
    const feat = txt('[data-qa="POSTING_CARD_FEATURES"]');
    const amb = feat.match(/(\d)\s*amb/);
    const m2 = feat.match(/(\d+)\s*m²/);
    const expText = txt('[data-qa="expensas"]');
    const imgEl = card.find("img").first();
    const img = imgEl.attr("src") || imgEl.attr("data-src") || null;
    const loc = txt('[data-qa="POSTING_CARD_LOCATION"]');
    const addr = txt(".postingAddress, [class*=address]");

    out.push({
      id: `ZP${id}`,
      src: "Zonaprop",
      title: txt('[data-qa="POSTING_CARD_DESCRIPTION"]').slice(0, 90) || addr || "Departamento",
      link: `https://www.zonaprop.com.ar${to}`,
      rent: toInt(priceText),
      currency: /^\s*(usd|u\$s)/i.test(priceText) ? "USD" : "ARS",
      ambientes: amb ? parseInt(amb[1], 10) : null,
      m2: m2 ? m2[1] : null,
      address: [addr, loc].filter(Boolean).join(", "),
      image: img && !img.startsWith("data:") ? img : null,
      expensas: expText && toInt(expText) >= EXPENSAS_MIN_CREIBLE ? toInt(expText) : null, // null = no declara (o dato roto)
    });
  });
  return out;
}

async function launchBrowser() {
  try {
    const { chromium } = require("playwright");
    return await chromium.launch({ headless: true });
  } catch (err) {
    console.error(`[browser] no disponible: ${err.message.slice(0, 120)}`);
    return null;
  }
}

async function fetchZonaprop(browser) {
  if (!browser) return [];
  const all = [];
  for (let page = 1; page <= ZP_PAGES; page++) {
    const suffix = page === 1 ? "" : `-pagina-${page}`;
    const url = `https://www.zonaprop.com.ar/departamentos-alquiler-${BARRIO}-menos-${TOTAL_MAX_ARS}-pesos-orden-publicado-descendente${suffix}.html`;
    let found = [];
    for (let intento = 1; intento <= 2 && found.length === 0; intento++) {
      const ctx = await browser.newContext({ locale: "es-AR", userAgent: USER_AGENT });
      const p = await ctx.newPage();
      try {
        await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        await p.waitForSelector('[data-qa="posting PROPERTY"]', { timeout: 20000 }).catch(() => {});
        found = parseZonaCards(await p.content());
      } catch (err) {
        console.error(`[zonaprop] página ${page}: ${err.message.slice(0, 90)}`);
      }
      await ctx.close();
      if (found.length === 0 && intento === 1) await sleep(6000);
    }
    if (found.length === 0) console.error(`[zonaprop] página ${page}: sin avisos (bloqueado o vacío)`);
    all.push(...found);
    if (found.length < 30) break;
    await sleep(3000);
  }
  return all;
}

// --- Filtros ---

const DESCARTE = /temporari[oa]|temporal|\bventa\b|compartid[oa]|habitaci[oó]n en|cochera en alquiler/i;

function passesBasics(l) {
  if (l.rent == null || l.currency !== "ARS") return false;
  if (l.rent > TOTAL_MAX_ARS) return false; // aunque no hubiera expensas, ya se pasa
  if (DESCARTE.test(l.title)) return false;
  if (l.ambientes != null && l.ambientes > MAX_AMBIENTES) return false;
  if (l.address && !/almagro/i.test(l.address)) return false;
  return true;
}

function totalOf(l) {
  return l.rent + (l.expensas || 0);
}

// --- Telegram ---

function formatCaption(l) {
  const tipo = l.ambientes === 1 ? "Monoambiente" : l.ambientes === 2 ? "2 ambientes" : "Mono/2 amb.";
  const lines = [`🏠 ${tipo} · ${l.m2 ? l.m2 + " m² · " : ""}Almagro`];
  lines.push(l.title);
  if (l.expensas != null) {
    lines.push(`💰 ${formatMoney(l.rent)} + ${formatMoney(l.expensas)} exp. = ${formatMoney(totalOf(l))}`);
  } else {
    lines.push(`💰 ${formatMoney(l.rent)} + expensas ⚠️ sin dato (confirmar que no pase de ${formatMoney(TOTAL_MAX_ARS)})`);
  }
  if (l.address) lines.push(`📍 ${l.address.split(",")[0]}`);
  lines.push(`${l.link}`);
  for (const alt of l.alt || []) lines.push(`También en ${alt}`);
  return lines.join("\n").slice(0, 1024);
}

async function tgPost(method, body) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok && method === "sendMessage") {
      console.error(`[telegram] ${method} ${res.status} (chat ${body.chat_id}): ${await res.text()}`);
    }
    return res.ok;
  } catch (err) {
    console.error(`[telegram] ${method} error: ${err.message}`);
    return false;
  }
}

async function sendListing(chatId, l) {
  const caption = formatCaption(l);
  if (l.image && (await tgPost("sendPhoto", { chat_id: chatId, photo: l.image, caption }))) return true;
  return tgPost("sendMessage", { chat_id: chatId, text: caption, disable_web_page_preview: false });
}

// --- Main ---

async function main() {
  const dryRun = process.env.DRY_RUN === "1";
  if (!dryRun && !TELEGRAM_TOKEN) throw new Error("Falta TELEGRAM_BOT_TOKEN en el entorno.");

  const sentIds = loadJson(STATE_FILE, {});
  const expCache = loadJson(EXPENSAS_FILE, {});

  const browser = await launchBrowser();
  let ml, zp;
  try {
    ml = await fetchML();
    zp = await fetchZonaprop(browser);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  console.log(`[fuentes] MercadoLibre: ${ml.length} avisos, Zonaprop: ${zp.length} avisos`);
  if (ml.length === 0 && zp.length === 0) {
    console.error("Ninguna fuente devolvió avisos: posible bloqueo. No se toca el estado.");
    return;
  }

  // 1. Filtro básico + solo lo que no se avisó antes.
  const raw = Array.from(new Map([...ml, ...zp].map((l) => [l.id, l])).values());
  const candidates = raw.filter(passesBasics);

  // 2. Expensas de MercadoLibre (ficha), con caché para no reabrir la misma ficha cada corrida.
  for (const l of candidates) {
    if (l.src !== "MercadoLibre" || sentIds[l.id]) continue;
    if (!(l.id in expCache)) {
      expCache[l.id] = await fetchMLExpensas(l.link);
      await sleep(400);
    }
    l.expensas = expCache[l.id];
  }

  // 3. Tope sobre alquiler + expensas.
  const ok = candidates.filter((l) => totalOf(l) <= TOTAL_MAX_ARS);

  // 4. Mismo lugar en dos portales: se avisa una sola vez, con el otro link como "También".
  const groups = new Map();
  const solos = [];
  for (const l of ok) {
    const key = placeKey(l.address, l.rent);
    l.placeKey = key;
    if (!key) {
      l.ids = [l.id];
      solos.push(l);
      continue;
    }
    const g = groups.get(key);
    if (!g) {
      l.ids = [l.id];
      l.alt = [];
      groups.set(key, l);
    } else {
      g.ids.push(l.id);
      g.alt.push(`${l.src}: ${l.link}`);
      if (g.expensas == null && l.expensas != null) g.expensas = l.expensas;
      if (!g.image && l.image) g.image = l.image;
    }
  }
  const vigentes = [...groups.values(), ...solos].sort((a, b) => totalOf(a) - totalOf(b));
  // Además del id, se recuerda el lugar: así un aviso enviado desde ML (PC) no se repite desde Zonaprop (nube).
  const sentPlace = (g) => g.placeKey && sentIds["lugar:" + g.placeKey];
  const fresh = vigentes.filter((g) => !g.ids.some((id) => sentIds[id]) && !sentPlace(g));

  console.log(`[filtro] ${raw.length} únicos → ${candidates.length} tras filtro básico → ${ok.length} ≤ ${formatMoney(TOTAL_MAX_ARS)} con expensas → ${fresh.length} nuevos`);

  if (dryRun) {
    for (const l of fresh) console.log(formatCaption(l) + `\n[img: ${l.image}]\n---`);
    return;
  }

  saveJson(EXPENSAS_FILE, expCache);
  const chatIds = new Set(await refreshChatIds());
  // Chat nuevo que avisó el Worker al recibir /start (solo dígitos: viene de un input de workflow).
  const newChat = (process.env.NEW_CHAT_ID || "").trim();
  let bienvenida = null; // chat recién sumado: recibe todo lo vigente, no solo lo nuevo
  if (/^\d+$/.test(newChat)) {
    bienvenida = newChat;
    chatIds.add(newChat);
    saveJson(CHATS_FILE, { ...loadJson(CHATS_FILE, { lastUpdateId: 0 }), chatIds: [...chatIds] });
  }
  if (TELEGRAM_CHAT_ID) chatIds.add(String(TELEGRAM_CHAT_ID));

  if (fresh.length === 0 && !bienvenida) {
    console.log("Sin alquileres nuevos que cumplan los criterios en esta corrida.");
    saveJson(STATE_FILE, sentIds);
    return;
  }

  const delivered = new Set();
  for (const chatId of chatIds) {
    const lista = chatId === bienvenida ? vigentes : fresh;
    if (lista.length === 0) continue;
    const headerOk = await tgPost("sendMessage", {
      chat_id: chatId,
      text: `🏠 ${lista.length} alquiler(es) ${chatId === bienvenida ? "vigente(s)" : "nuevo(s)"} en Almagro — mono o 2 amb., hasta ${formatMoney(TOTAL_MAX_ARS)} con expensas:`,
    });
    if (!headerOk) continue; // chat que no inició el bot o lo bloqueó: no se insiste con cada aviso
    for (const l of lista) {
      if (await sendListing(chatId, l) && fresh.includes(l)) delivered.add(l);
      await sleep(400);
    }
  }

  // Solo se marca como enviado lo que llegó a al menos un destinatario: si Telegram falla, se reintenta.
  const now = new Date().toISOString();
  for (const l of delivered) {
    for (const id of l.ids) sentIds[id] = now;
    if (l.placeKey) sentIds["lugar:" + l.placeKey] = now;
  }
  saveJson(STATE_FILE, sentIds);
  console.log(`Enviados ${delivered.size} de ${fresh.length} alquileres nuevos a ${chatIds.size} destinatario(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
