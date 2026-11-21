#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

echo "Building production static assets..."
npm run build

echo "Loading Cloudflare credentials..."
CREDS_FILE="/data/data/com.termux/files/home/micro-tools/.cloudflare_credentials.json"
export CLOUDFLARE_EMAIL=$(python3 -c "import json; print(json.load(open('$CREDS_FILE'))['email'])")
export CLOUDFLARE_API_KEY=$(python3 -c "import json; print(json.load(open('$CREDS_FILE'))['api_key'])")
export CLOUDFLARE_ACCOUNT_ID="d04ccc99aaf0e474e1fd1203d22ec1d6"

WRANGLER="/data/data/com.termux/files/home/pdfandimg/node_modules/.bin/wrangler"

echo "Deploying dist to Cloudflare Pages project 'viewmbox'..."
$WRANGLER pages deploy dist --project-name=viewmbox --branch=main

echo "Deployment finished successfully!"
