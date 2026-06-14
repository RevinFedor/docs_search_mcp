#!/usr/bin/env bash
set -u

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
INDEX_FILE="$PROJECT_DIR/.semantic-index.json"
LOG_FILE="$PROJECT_DIR/scripts/ai/indexer.log"
RESULTS_DIR="$(mktemp -d /tmp/docs-indexer-results-XXXXXXXX)"

MAX_PARALLEL=5
USE_GEMINI=false
GEMINI_WRITE=false
FORCE_REINDEX=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -g|--gemini) USE_GEMINI=true; shift ;;
    --gemini-write) USE_GEMINI=true; GEMINI_WRITE=true; shift ;;
    --force|-f) FORCE_REINDEX=true; shift ;;
    --parallel) MAX_PARALLEL="$2"; shift 2 ;;
    [0-9]*) MAX_PARALLEL="$1"; shift ;;
    *) shift ;;
  esac
done

cleanup() {
  rm -rf "$RESULTS_DIR" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$(dirname "$LOG_FILE")"
echo "=== docs indexer started: $(date) ===" > "$LOG_FILE"

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required. Install with: brew install jq" >&2
  exit 1
fi

if [ "$USE_GEMINI" = true ] && [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "ERROR: GEMINI_API_KEY is required for Gemini indexing" >&2
  exit 1
fi

if [ "$USE_GEMINI" = false ] && ! command -v claude >/dev/null 2>&1; then
  echo "ERROR: claude CLI not found. Use --gemini-write or install Claude CLI." >&2
  exit 1
fi

SYSTEM_PROMPT='You are a semantic documentation indexer.
Create a compact JSON passport for one markdown file.

Output strict JSON only:
{
  "path": "docs/knowledge/fact-example.md",
  "type": "fact|fix|methodology|product|meta|other",
  "explicit": ["short topic names"],
  "implicit": ["concrete hidden concepts"],
  "symptoms": ["observable situation where an AI should read this file"],
  "related_components": ["optional code paths or subsystem names"]
}

Rules:
- All output strings must be in English.
- symptoms are the most important field.
- Write symptoms as user/developer-visible situations, not generic tags.
- Prefer concrete mechanism names over broad abstractions.
- Do not include secrets or long quotes from the source.'

export SYSTEM_PROMPT

FILES=()
while IFS= read -r -d '' file; do
  FILES+=("$file")
done < <(find "$PROJECT_DIR/docs" -type f -name '*.md' \
  ! -path '*/tmp/*' \
  ! -name '_intro.md' \
  -print0 2>/dev/null)

TOTAL=${#FILES[@]}
if [ "$TOTAL" -eq 0 ]; then
  echo "ERROR: no markdown files found under $PROJECT_DIR/docs" >&2
  exit 1
fi

echo "Project: $PROJECT_DIR"
echo "Files: $TOTAL"
echo "Parallel: $MAX_PARALLEL"

hash_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

process_file() {
  local file="$1"
  local idx="$2"
  local rel="${file#$PROJECT_DIR/}"
  local hash
  hash="$(hash_file "$file")"
  local out="$RESULTS_DIR/$idx.json"
  local content
  content="$(cat "$file" 2>/dev/null || true)"

  if [ -z "$content" ]; then
    echo "SKIP" > "$out"
    return
  fi

  local prompt
  prompt="$(printf 'Path: %s\nSHA256: %s\n\nContent:\n%s' "$rel" "$hash" "$content")"
  local raw=""

  if [ "$USE_GEMINI" = true ]; then
    local request
    request="$(mktemp /tmp/docs-indexer-request-XXXXXXXX)"
    jq -n \
      --arg system "$SYSTEM_PROMPT" \
      --arg user "$prompt" \
      '{
        contents: [{ role: "user", parts: [{ text: $user }] }],
        systemInstruction: { parts: [{ text: $system }] },
        generationConfig: { temperature: 0, responseMimeType: "application/json" }
      }' > "$request"

    raw="$(curl -sS -X POST \
      -H "Content-Type: application/json" \
      "https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL:-gemini-3.5-flash}:generateContent?key=${GEMINI_API_KEY}" \
      -d @"$request")"
    rm -f "$request"

    jq -r '.candidates[0].content.parts[]?.text // empty' <<<"$raw" > "$out.tmp" 2>>"$LOG_FILE" || true
  else
    printf '%s' "$prompt" | claude -p --model "${CLAUDE_MODEL:-haiku}" --system-prompt "$SYSTEM_PROMPT" --no-session-persistence > "$out.tmp" 2>>"$LOG_FILE" || true
  fi

  if ! jq -e . "$out.tmp" >/dev/null 2>&1; then
    echo "ERROR" > "$out"
    {
      echo "Failed to index $rel"
      echo "$raw"
      cat "$out.tmp" 2>/dev/null || true
    } >> "$LOG_FILE"
    rm -f "$out.tmp"
    return
  fi

  jq --arg path "$rel" --arg hash "$hash" '.path = $path | .hash = $hash' "$out.tmp" > "$out"
  rm -f "$out.tmp"
  echo "[done] $rel"
}

active=0
idx=0
for file in "${FILES[@]}"; do
  idx=$((idx + 1))
  process_file "$file" "$idx" &
  active=$((active + 1))
  if [ "$active" -ge "$MAX_PARALLEL" ]; then
    wait -n || true
    active=$((active - 1))
  fi
done
wait

errors=0
for result in "$RESULTS_DIR"/*.json; do
  [ -e "$result" ] || continue
  if grep -qx 'ERROR' "$result"; then
    errors=$((errors + 1))
  fi
done

if [ "$errors" -gt 0 ]; then
  echo "Completed with err: $errors. See $LOG_FILE" >&2
  exit 1
fi

jq -s '[.[] | select(type == "object")]' "$RESULTS_DIR"/*.json > "$INDEX_FILE.tmp"

if [ "$USE_GEMINI" = true ] && [ "$GEMINI_WRITE" = false ]; then
  echo "Dry run complete. Index preview:"
  cat "$INDEX_FILE.tmp"
  rm -f "$INDEX_FILE.tmp"
else
  mv "$INDEX_FILE.tmp" "$INDEX_FILE"
  echo "Wrote $INDEX_FILE"
fi

echo "Summary: files=$TOTAL err: $errors"
