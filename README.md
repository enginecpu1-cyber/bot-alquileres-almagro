# Bot de alquileres — Almagro

Avisa por Telegram monoambientes y 2 ambientes en alquiler en **Almagro (CABA)**, **hasta $800.000 con expensas** (alquiler + expensas).

- Fuentes: MercadoLibre Inmuebles (HTTP; las expensas se leen de la ficha) y Zonaprop (Chromium headless; expensas en la tarjeta, orden por más recientes).
- **MercadoLibre solo funciona desde una PC residencial.** Desde GitHub Actions (y Cloudflare) devuelve su página "tráfico sospechoso", sin avisos; en la nube el bot corre solo con Zonaprop. Para sumar ML hay que correr `node scraper.js` en una PC de casa.
- No andan (verificado 2026-11-24): Argenprop (captcha), Properati (401), Inmuebles24 y Remax (403).
- Un mismo aviso en dos portales se manda una sola vez (clave: calle + altura + alquiler), con el otro link como "También en".
- Si el aviso no declara expensas, se manda igual marcado "⚠️ sin dato". Expensas < $10.000 se ignoran (dato roto).
- Descarta USD, temporarios, ventas y compartidos. Quien le escriba al bot queda sumado a los destinatarios.
- Corre en GitHub Actions (repo público = minutos gratis) disparado cada 30 min por un Cloudflare Worker.
- Config en `scraper.js`: `TOTAL_MAX_ARS`, `MAX_AMBIENTES`, `BARRIO`. Prueba sin enviar: `DRY_RUN=1 node scraper.js`.
