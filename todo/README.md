# TODO - Säkerhet, Kvalitet & CI/CD Åtgärder

## Översikt

Denna mapp innehåller uppgifter från genomlysningen av projektet.

| Prioritet | Antal | Beskrivning |
|-----------|-------|-------------|
| 🔴 P1 | 4 | Kritiska säkerhetsåtgärder (Omedelbart) |
| 🟠 P2 | 4 | CI/CD-förbättringar (Inom 1 vecka) |
| 🟡 P3 | 6 | Kvalitetsförbättringar (Inom 2 veckor) |
| 🟢 P4 | 3 | Dokumentation (Inom 3 veckor) |

## Hantera uppgifter

### Markera uppgift som klar

Kör följande kommando för att markera en uppgift som klar:

```bash
./todo/complete.sh <uppgift-fil> "<kort sammanfattning>"
```

**Exempel:**
```bash
./todo/complete.sh P1-01-remove-hardcoded-api-key.md "Tog bort hardkodad test-API-nyckel från database.js"
```

### Lista aktiva uppgifter

```bash
ls todo/*.md | grep -v README
```

### Lista färdiga uppgifter

```bash
ls todo/done/
```

## Filer

### Prioritet 1 - Kritisk säkerhet 🔴
- `P1-01-remove-hardcoded-api-key.md`
- `P1-02-fix-admin-auth.md`
- `P1-03-add-helmet-body-limit.md`
- `P1-04-secure-docker-compose.md`

### Prioritet 2 - CI/CD 🟠
- `P2-01-update-github-actions.md`
- `P2-02-add-security-scanning.md`
- `P2-03-add-eslint-config.md`
- `P2-04-fix-eslint-ci.md`

### Prioritet 3 - Kvalitet 🟡
- `P3-01-increase-test-coverage.md`
- `P3-02-add-webui-tests.md`
- `P3-03-add-precommit-hooks.md`
- `P3-04-secure-nginx.md`
- `P3-05-improve-dockerfiles.md`
- `P3-06-add-structured-logging.md`

### Prioritet 4 - Dokumentation 🟢
- `P4-01-create-security-md.md`
- `P4-02-create-contributing-md.md`
- `P4-03-create-pr-template.md`
