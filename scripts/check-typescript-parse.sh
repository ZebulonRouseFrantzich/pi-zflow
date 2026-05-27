#!/bin/sh
set -eu

# Parse-check every TypeScript file without enforcing type correctness.
# This catches syntax/template-literal errors that can break Pi extension loading
# while avoiding the repo's current cross-package type-check debt.
files=$(find packages -name "*.ts" -not -path "*/node_modules/*")

if [ -z "$files" ]; then
  echo "No TypeScript files found"
  exit 0
fi

# shellcheck disable=SC2086
npx tsc --noEmit --noCheck \
  --moduleResolution nodenext \
  --module nodenext \
  --target es2022 \
  --skipLibCheck \
  --allowImportingTsExtensions \
  --types node \
  --pretty false \
  $files
