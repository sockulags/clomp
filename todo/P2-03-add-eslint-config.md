# P2-03: Lägg till ESLint-konfiguration

**Prioritet:** 🟠 Hög  
**Kategori:** CI/CD / Kvalitet  
**Tidsuppskattning:** 45 min

## Problem

Backend saknar ESLint-konfigurationsfil. CI-pipelinen kör ESLint men det finns ingen `.eslintrc` som definierar regler.

## Åtgärd

### 1. Installera ESLint lokalt

```bash
cd backend
npm install -D eslint
```

### 2. Skapa .eslintrc.js

```javascript
// backend/.eslintrc.js
module.exports = {
  env: {
    node: true,
    es2021: true,
    jest: true
  },
  extends: ['eslint:recommended'],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module'
  },
  rules: {
    // Errors
    'no-unused-vars': ['error', { 
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_'
    }],
    'no-undef': 'error',
    'no-console': ['warn', { 
      allow: ['warn', 'error', 'info'] 
    }],
    
    // Warnings
    'prefer-const': 'warn',
    'no-var': 'warn',
    
    // Style (off - låt Prettier hantera)
    'semi': 'off',
    'quotes': 'off',
    'indent': 'off'
  },
  ignorePatterns: [
    'node_modules/',
    'coverage/',
    'data/',
    '*.test.js'
  ]
};
```

### 3. Lägg till lint script i package.json

```json
{
  "scripts": {
    "lint": "eslint src/ --ext .js",
    "lint:fix": "eslint src/ --ext .js --fix"
  }
}
```

### 4. Skapa .eslintignore

```
node_modules/
coverage/
data/
```

## Acceptanskriterier

- [ ] ESLint konfiguration skapad
- [ ] `npm run lint` fungerar lokalt
- [ ] Inga lint-fel i kodbasen (eller dokumenterade undantag)
- [ ] CI lint job passerar

## Filer att skapa/ändra

- `backend/.eslintrc.js` (ny fil)
- `backend/.eslintignore` (ny fil)
- `backend/package.json`
