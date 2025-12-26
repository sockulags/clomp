# P4-01: Skapa SECURITY.md

**Prioritet:** 🟢 Låg  
**Kategori:** Dokumentation  
**Tidsuppskattning:** 30 min

## Problem

Projektet saknar en SECURITY.md-fil som beskriver:
- Hur man rapporterar säkerhetsproblem
- Vilka versioner som stöds
- Säkerhetspolicy

## Åtgärd

### Skapa SECURITY.md i root

```markdown
# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability, please follow these steps:

### Do NOT

- Open a public GitHub issue
- Disclose the vulnerability publicly before it's fixed

### Do

1. **Email us** at security@example.com with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Any suggested fixes (optional)

2. **Expect a response** within 48 hours acknowledging receipt

3. **Work with us** to understand and resolve the issue

### What to Expect

- **Acknowledgment**: Within 48 hours
- **Initial Assessment**: Within 7 days
- **Resolution Timeline**: Depends on severity
  - Critical: 24-72 hours
  - High: 7 days
  - Medium: 30 days
  - Low: 90 days

### Recognition

We appreciate security researchers who help keep our project safe. With your permission, we will:
- Credit you in our release notes
- Add you to our Security Hall of Fame (if applicable)

## Security Best Practices

When deploying this application:

1. **Always set ADMIN_API_KEY** to a strong, unique value
2. **Never use default API keys** in production
3. **Use HTTPS** in production
4. **Restrict ALLOWED_ORIGINS** to your specific domains
5. **Keep dependencies updated** - run `npm audit` regularly
6. **Monitor logs** for suspicious activity

## Known Security Considerations

- API keys are stored in plain text in the database
- SQLite database is not encrypted at rest
- Rate limiting should be tuned for your traffic patterns
```

## Acceptanskriterier

- [ ] SECURITY.md skapad
- [ ] Kontaktinformation uppdaterad (ersätt example.com)
- [ ] Länkad från README.md

## Filer att skapa/ändra

- `SECURITY.md` (ny)
- `README.md` (lägg till länk)
