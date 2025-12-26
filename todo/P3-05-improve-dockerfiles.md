# P3-05: Förbättra Dockerfiles

**Prioritet:** 🟡 Medium  
**Kategori:** Säkerhet / Kvalitet  
**Tidsuppskattning:** 45 min

## Problem

Dockerfiles har flera säkerhets- och kvalitetsproblem:
1. Containers körs som root
2. Ingen health check i backend Dockerfile
3. Saknar .dockerignore optimering
4. Node.js 18 (nära EOL)

## Åtgärd

### 1. Uppdatera backend/Dockerfile

```dockerfile
FROM node:20-alpine AS base

# Skapa non-root användare
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

WORKDIR /app

# Kopiera package files först för bättre caching
COPY --chown=nodejs:nodejs package*.json ./

FROM base AS dependencies
RUN npm ci --only=production

FROM base AS build
RUN npm ci
COPY --chown=nodejs:nodejs . .
# Kör eventuella build-steg här

FROM base AS production
# Kopiera endast production dependencies
COPY --from=dependencies /app/node_modules ./node_modules
COPY --chown=nodejs:nodejs . .

# Byt till non-root användare
USER nodejs

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1

EXPOSE 3000

CMD ["node", "src/server.js"]
```

### 2. Uppdatera web-ui/Dockerfile

```dockerfile
FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginx:alpine AS production

# Skapa non-root användare för nginx
RUN adduser -D -H -u 1001 -s /sbin/nologin www-data

# Kopiera build-artefakter
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Sätt rätt permissions
RUN chown -R www-data:www-data /usr/share/nginx/html && \
    chown -R www-data:www-data /var/cache/nginx && \
    chown -R www-data:www-data /var/log/nginx && \
    touch /var/run/nginx.pid && \
    chown -R www-data:www-data /var/run/nginx.pid

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost:80/ || exit 1

USER www-data

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
```

### 3. Uppdatera .dockerignore filer

`backend/.dockerignore`:
```
node_modules
npm-debug.log
.git
.gitignore
.env
.env.*
coverage
data
*.md
.eslintrc*
jest.config.js
__tests__
```

`web-ui/.dockerignore`:
```
node_modules
npm-debug.log
.git
.gitignore
dist
coverage
*.md
test
vitest.config.js
```

## Acceptanskriterier

- [ ] Containers körs som non-root
- [ ] Health checks definierade
- [ ] Multi-stage builds för optimering
- [ ] Node 20 används
- [ ] .dockerignore optimerade
- [ ] Images bygger och startar korrekt

## Filer att ändra

- `backend/Dockerfile`
- `backend/.dockerignore`
- `web-ui/Dockerfile`
- `web-ui/.dockerignore`
