# P3-01: Öka testtäckning

**Prioritet:** 🟡 Medium  
**Kategori:** Kvalitet  
**Tidsuppskattning:** 2-3 timmar

## Problem

Nuvarande coverage threshold är 50%, vilket är för lågt för en produktionsapplikation. Rekommenderat är minst 80%.

```javascript
// Nuvarande - för lågt
coverageThreshold: {
  global: {
    branches: 50,
    functions: 50,
    lines: 50,
    statements: 50
  }
}
```

## Åtgärd

### 1. Identifiera saknade tester

Kör coverage-rapport:
```bash
cd backend
npm test -- --coverage
```

### 2. Lägg till tester för:

- [ ] `services/archive.js` - archiveOldLogs, readArchivedLogs, cleanupOldArchives
- [ ] `services/scheduler.js` - startScheduler, runArchiveNow
- [ ] `routes/admin.js` - alla endpoints
- [ ] `routes/services.js` - alla endpoints
- [ ] `middleware/adminAuth.js` - alla scenarion
- [ ] `database.js` - edge cases

### 3. Uppdatera jest.config.js

```javascript
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/**/__tests__/**',
    '!src/server.js'
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80
    }
  },
  // Lägg till coverage reporters
  coverageReporters: ['text', 'lcov', 'html']
};
```

### 4. Skapa testfiler

```
backend/src/__tests__/
├── middleware/
│   ├── auth.test.js ✅
│   └── adminAuth.test.js (ny)
├── routes/
│   ├── logs.test.js ✅
│   ├── admin.test.js (ny)
│   └── services.test.js (ny)
├── services/
│   ├── archive.test.js (ny)
│   └── scheduler.test.js (ny)
└── server.test.js ✅
```

## Acceptanskriterier

- [ ] Coverage ≥ 80% för alla metrics
- [ ] Alla kritiska flöden har tester
- [ ] CI passerar med nya tröskelvärden

## Filer att skapa/ändra

- `backend/jest.config.js`
- `backend/src/__tests__/services/archive.test.js` (ny)
- `backend/src/__tests__/services/scheduler.test.js` (ny)
- `backend/src/__tests__/routes/admin.test.js` (ny)
- `backend/src/__tests__/routes/services.test.js` (ny)
- `backend/src/__tests__/middleware/adminAuth.test.js` (ny)
