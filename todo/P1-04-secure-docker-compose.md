# P1-04: Säkra docker-compose.yml

**Prioritet:** 🔴 Kritisk  
**Kategori:** Säkerhet  
**Tidsuppskattning:** 15 min

## Problem

Default-värdet för `ADMIN_API_KEY` i docker-compose.yml är `INSECURE-CHANGE-THIS-KEY`, vilket kan av misstag användas i produktion.

```yaml
# OSÄKERT - nuvarande
- ADMIN_API_KEY=${ADMIN_API_KEY:-INSECURE-CHANGE-THIS-KEY}
```

## Åtgärd

### 1. Kräv att ADMIN_API_KEY är satt

```yaml
# docker-compose.yml
services:
  backend:
    environment:
      - PORT=3000
      - DB_PATH=/app/data/logs.db
      # Kräv att ADMIN_API_KEY är satt - ingen default
      - ADMIN_API_KEY=${ADMIN_API_KEY:?ADMIN_API_KEY environment variable is required}
```

### 2. Skapa .env.production.example

```env
# .env.production.example
# Kopiera till .env och fyll i värden

# REQUIRED: Generate with: openssl rand -hex 32
ADMIN_API_KEY=

# Optional: Comma-separated list of allowed origins
ALLOWED_ORIGINS=https://your-domain.com

# Optional: Rate limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=100
```

### 3. Uppdatera .gitignore

```gitignore
# Secrets
.env
.env.production
.env.local
```

## Acceptanskriterier

- [ ] docker-compose.yml kräver ADMIN_API_KEY
- [ ] .env.production.example skapad
- [ ] .gitignore uppdaterad
- [ ] Dokumentation uppdaterad med setup-instruktioner

## Filer att ändra

- `docker-compose.yml`
- `.env.production.example` (ny fil)
- `.gitignore`
- `README.md` eller `QUICKSTART.md`
