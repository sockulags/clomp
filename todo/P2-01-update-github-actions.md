# P2-01: Uppdatera GitHub Actions versioner

**Prioritet:** 🟠 Hög  
**Kategori:** CI/CD  
**Tidsuppskattning:** 30 min

## Problem

GitHub Actions workflow använder föråldrade action-versioner:
- `actions/checkout@v3` → bör vara `@v4`
- `actions/setup-node@v3` → bör vara `@v4`
- `codecov/codecov-action@v3` → bör vara `@v4`
- `docker/setup-buildx-action@v2` → bör vara `@v3`
- `docker/build-push-action@v4` → bör vara `@v5`

Node.js 18 går EOL april 2025 - bör uppgradera till Node 20.

## Åtgärd

Uppdatera `.github/workflows/ci.yml`:

```yaml
jobs:
  test-backend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: backend/package-lock.json

      # ... resten av stegen

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        if: always()
        with:
          file: ./backend/coverage/coverage-final.json

  docker-build:
    steps:
      - uses: actions/checkout@v4
      
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3
      
      - name: Build backend image
        uses: docker/build-push-action@v5
        # ...
```

## Acceptanskriterier

- [ ] Alla actions uppdaterade till senaste major version
- [ ] Node.js uppgraderat till v20
- [ ] CI pipeline passerar
- [ ] Dockerfiles uppdaterade med Node 20

## Filer att ändra

- `.github/workflows/ci.yml`
- `backend/Dockerfile`
- `web-ui/Dockerfile`
