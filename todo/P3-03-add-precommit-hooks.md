# P3-03: Lägg till pre-commit hooks

**Prioritet:** 🟡 Medium  
**Kategori:** Kvalitet  
**Tidsuppskattning:** 45 min

## Problem

Ingen automatisk kodkvalitetskontroll före commits. Utvecklare kan pusha kod som inte passerar lint eller tester.

## Åtgärd

### 1. Installera Husky och lint-staged (i root)

```bash
npm init -y  # Om package.json saknas i root
npm install -D husky lint-staged
npx husky init
```

### 2. Konfigurera lint-staged

Lägg till i `package.json` (root):

```json
{
  "devDependencies": {
    "husky": "^9.0.0",
    "lint-staged": "^15.0.0"
  },
  "lint-staged": {
    "backend/src/**/*.js": [
      "eslint --fix",
      "prettier --write"
    ],
    "web-ui/src/**/*.{js,jsx}": [
      "eslint --fix",
      "prettier --write"
    ]
  }
}
```

### 3. Skapa pre-commit hook

Skapa `.husky/pre-commit`:

```bash
#!/bin/sh
npx lint-staged
```

### 4. Skapa commit-msg hook (valfritt)

Skapa `.husky/commit-msg`:

```bash
#!/bin/sh
# Enkel validering av commit-meddelanden
if ! head -1 "$1" | grep -qE "^(feat|fix|docs|style|refactor|test|chore)(\(.+\))?: .{1,50}"; then
  echo "❌ Commit message måste följa Conventional Commits format:"
  echo "   <type>(<scope>): <description>"
  echo ""
  echo "   Typer: feat, fix, docs, style, refactor, test, chore"
  echo "   Exempel: feat(auth): add JWT validation"
  exit 1
fi
```

### 5. Installera Prettier (om det inte finns)

```bash
npm install -D prettier
```

Skapa `.prettierrc`:

```json
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "es5"
}
```

## Acceptanskriterier

- [ ] Husky installerat och konfigurerat
- [ ] lint-staged kör lint på staged files
- [ ] Pre-commit hook fungerar
- [ ] Dokumentation uppdaterad för nya utvecklare

## Filer att skapa/ändra

- `package.json` (root, ny eller uppdaterad)
- `.husky/pre-commit` (ny)
- `.husky/commit-msg` (ny, valfritt)
- `.prettierrc` (ny)
- `.prettierignore` (ny)
