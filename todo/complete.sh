#!/bin/bash
#
# Script för att markera en TODO-uppgift som klar
# Användning: ./complete.sh <uppgift-fil> "<sammanfattning>"
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TODO_DIR="$SCRIPT_DIR"
DONE_DIR="$SCRIPT_DIR/done"

# Kontrollera argument
if [ $# -lt 2 ]; then
    echo "❌ Användning: $0 <uppgift-fil> \"<sammanfattning>\""
    echo ""
    echo "Exempel:"
    echo "  $0 P1-01-remove-hardcoded-api-key.md \"Tog bort hardkodad API-nyckel\""
    exit 1
fi

TASK_FILE="$1"
SUMMARY="$2"

# Hantera både relativ och absolut sökväg
if [[ "$TASK_FILE" == /* ]]; then
    TASK_PATH="$TASK_FILE"
else
    TASK_PATH="$TODO_DIR/$TASK_FILE"
fi

# Kontrollera att filen finns
if [ ! -f "$TASK_PATH" ]; then
    echo "❌ Filen '$TASK_FILE' hittades inte"
    echo ""
    echo "Tillgängliga uppgifter:"
    ls "$TODO_DIR"/*.md 2>/dev/null | grep -v README | xargs -n1 basename 2>/dev/null || echo "  (inga uppgifter)"
    exit 1
fi

# Extrahera filnamn
BASENAME=$(basename "$TASK_FILE")
TASK_NAME="${BASENAME%.md}"

# Skapa done-fil med sammanfattning
DONE_FILE="$DONE_DIR/$BASENAME"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M')

cat > "$DONE_FILE" << EOF
# ✅ $TASK_NAME

**Slutförd:** $TIMESTAMP

## Sammanfattning

$SUMMARY
EOF

# Ta bort original-filen
rm "$TASK_PATH"

echo "✅ Uppgift '$TASK_NAME' markerad som klar!"
echo "   → Sammanfattning sparad i: todo/done/$BASENAME"
