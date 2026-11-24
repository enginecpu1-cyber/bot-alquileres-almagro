#!/usr/bin/env bash
# Deploy: repo público en GitHub, secrets de Actions, Cloudflare Worker (cron cada 30 min), primera corrida.
# Uso (una vez, desde Git Bash en esta carpeta), con .env.deploy que define TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID.
set -euo pipefail
cd "$(dirname "$0")"
source .env.deploy
OWNER="${GH_OWNER:-enginecpu1-cyber}"
REPO="$OWNER/bot-alquileres-almagro"
PREV="$(gh api user --jq .login 2>/dev/null || echo '')"
gh auth switch --user "$OWNER"
if gh repo view "$REPO" >/dev/null 2>&1; then
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$REPO.git"
  git push -u origin master
else
  gh repo create "$REPO" --public --source . --remote origin --push \
    --description "Bot Telegram: monoambientes y 2 ambientes en alquiler en Almagro hasta \$800.000 con expensas"
fi
gh secret set TELEGRAM_BOT_TOKEN --repo "$REPO" --body "$TELEGRAM_BOT_TOKEN"
gh secret set TELEGRAM_CHAT_ID  --repo "$REPO" --body "$TELEGRAM_CHAT_ID"
( cd worker && npm install --silent --no-audit --no-fund && npx --yes wrangler deploy \
  && printf '%s' "$(gh auth token --user "$OWNER")" | npx --yes wrangler secret put GITHUB_DISPATCH_TOKEN )
gh workflow run buscar-alquileres.yml --repo "$REPO" --ref master
[ -n "$PREV" ] && [ "$PREV" != "$OWNER" ] && gh auth switch --user "$PREV" || true
echo "LISTO: https://github.com/$REPO/actions"
