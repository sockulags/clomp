# P2-02: Lägg till säkerhetsskanning i CI

**Prioritet:** 🟠 Hög  
**Kategori:** CI/CD  
**Tidsuppskattning:** 1 timme

## Problem

CI-pipelinen saknar:
- Dependency vulnerability scanning (npm audit)
- Static Application Security Testing (SAST)
- Container image scanning
- Secret scanning

## Åtgärd

### 1. Lägg till security job i ci.yml

```yaml
  security-scan:
    name: Security Scan
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      # NPM Audit för backend
      - name: Run npm audit (backend)
        working-directory: ./backend
        run: npm audit --audit-level=high
        continue-on-error: true
      
      # NPM Audit för web-ui
      - name: Run npm audit (web-ui)
        working-directory: ./web-ui
        run: npm audit --audit-level=high
        continue-on-error: true

  codeql-analysis:
    name: CodeQL Analysis
    runs-on: ubuntu-latest
    permissions:
      security-events: write
    steps:
      - uses: actions/checkout@v4
      
      - name: Initialize CodeQL
        uses: github/codeql-action/init@v3
        with:
          languages: javascript
      
      - name: Perform CodeQL Analysis
        uses: github/codeql-action/analyze@v3

  container-scan:
    name: Container Security Scan
    runs-on: ubuntu-latest
    needs: [docker-build]
    steps:
      - uses: actions/checkout@v4
      
      - name: Run Trivy vulnerability scanner
        uses: aquasecurity/trivy-action@master
        with:
          scan-type: 'fs'
          scan-ref: '.'
          severity: 'CRITICAL,HIGH'
          exit-code: '1'
```

### 2. Lägg till Dependabot

Skapa `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/backend"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 10
    
  - package-ecosystem: "npm"
    directory: "/web-ui"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 10
    
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
```

## Acceptanskriterier

- [ ] npm audit körs i CI
- [ ] CodeQL analys aktiverad
- [ ] Trivy container scanning aktiverat
- [ ] Dependabot konfigurerad
- [ ] Pipeline passerar (eller failar på kända sårbarheter)

## Filer att skapa/ändra

- `.github/workflows/ci.yml`
- `.github/dependabot.yml` (ny fil)
