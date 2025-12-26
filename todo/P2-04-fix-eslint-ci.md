# P2-04: Fixa ESLint i CI-pipeline

**Prioritet:** 🟠 Hög  
**Kategori:** CI/CD  
**Tidsuppskattning:** 20 min

## Problem

ESLint installeras globalt utan version i CI:

```yaml
# Nuvarande - PROBLEMATISK
- name: Install ESLint
  run: npm install -g eslint

- name: Run ESLint
  working-directory: ./backend
  run: eslint src/ --ext .js
```

Problem:
1. Global installation kan ge versionskonflikt
2. Ingen versionslåsning - kan plötsligt failas vid ESLint-uppdatering
3. Saknar caching

## Åtgärd

### Uppdatera ci.yml lint-job

```yaml
  lint-backend:
    name: Lint Backend
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: backend/package-lock.json
      
      - name: Install dependencies
        working-directory: ./backend
        run: npm ci
      
      - name: Run ESLint
        working-directory: ./backend
        run: npm run lint
```

### Förutsättningar

- P2-03 måste vara klar först (ESLint-konfiguration)
- ESLint måste vara i devDependencies

## Acceptanskriterier

- [ ] ESLint körs via `npm run lint` (inte global)
- [ ] Dependencies cachas i CI
- [ ] Lint-job använder samma Node-version som övriga jobs
- [ ] CI passerar

## Filer att ändra

- `.github/workflows/ci.yml`

## Beroenden

- Kräver: P2-03 (ESLint-konfiguration)
