# P1-03: Lägg till Helmet och body size limit

**Prioritet:** 🔴 Kritisk  
**Kategori:** Säkerhet  
**Tidsuppskattning:** 30 min

## Problem

1. **Saknar Helmet** - Inga säkerhetsheaders skickas (X-Frame-Options, CSP, etc.)
2. **Ingen body size limit** - Möjliggör DoS-attacker via stora request bodies

## Åtgärd

### 1. Installera Helmet

```bash
cd backend
npm install helmet
```

### 2. Uppdatera server.js

```javascript
const helmet = require('helmet');

// Lägg till tidigt i middleware-kedjan
app.use(helmet());

// Begränsa request body size
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
```

### 3. Konfigurera Helmet för produktion

```javascript
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
    },
  },
  crossOriginEmbedderPolicy: false, // Om du behöver ladda resurser från andra domäner
}));
```

## Acceptanskriterier

- [ ] Helmet installerat och konfigurerat
- [ ] Request body begränsad till 1MB
- [ ] Säkerhetsheaders verifierade i response
- [ ] Tester passerar

## Filer att ändra

- `backend/package.json`
- `backend/src/server.js`

## Verifiering

```bash
# Kontrollera säkerhetsheaders
curl -I http://localhost:3000/health

# Bör innehålla:
# X-Content-Type-Options: nosniff
# X-Frame-Options: SAMEORIGIN
# X-XSS-Protection: 0
# Strict-Transport-Security: max-age=15552000; includeSubDomains
```
