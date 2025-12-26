# P1-01: Ta bort hardkodad test-API-nyckel

**Prioritet:** 🔴 Kritisk  
**Kategori:** Säkerhet  
**Tidsuppskattning:** 30 min

## Problem

I `backend/src/database.js` (rad 62-65) skapas automatiskt en hardkodad test-API-nyckel (`test-api-key-123`) vid databasinitialisering. Detta är en allvarlig säkerhetsrisk i produktion.

```javascript
// database.js rad 62-65 - MÅSTE TAS BORT
db.run(`INSERT OR IGNORE INTO services (id, name, api_key) 
        VALUES ('default', 'default-service', 'test-api-key-123')`, () => {
  resolve();
});
```

## Åtgärd

1. **Ta bort** auto-insert av default service i `database.js`
2. **Skapa** ett separat setup-script för utvecklingsmiljö: `scripts/setup-dev.js`
3. **Uppdatera** dokumentation med instruktioner för att skapa API-nycklar

## Acceptanskriterier

- [ ] Ingen hardkodad API-nyckel i produktionskod
- [ ] Setup-script finns för utvecklingsmiljö
- [ ] Dokumentation uppdaterad
- [ ] Tester uppdaterade och passerar

## Filer att ändra

- `backend/src/database.js`
- `backend/scripts/setup-dev.js` (ny fil)
- `README.md` eller `QUICKSTART.md`
