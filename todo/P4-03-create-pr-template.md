# P4-03: Skapa PR-template

**Prioritet:** 🟢 Låg  
**Kategori:** Dokumentation  
**Tidsuppskattning:** 20 min

## Problem

Projektet saknar PR-template, vilket leder till inkonsekvent information i pull requests.

## Åtgärd

### 1. Skapa PR-template

Skapa `.github/PULL_REQUEST_TEMPLATE.md`:

```markdown
## Description

<!-- Beskriv vad denna PR gör och varför -->

## Type of Change

- [ ] 🐛 Bug fix (non-breaking change that fixes an issue)
- [ ] ✨ New feature (non-breaking change that adds functionality)
- [ ] 💥 Breaking change (fix or feature that would cause existing functionality to change)
- [ ] 📝 Documentation update
- [ ] 🔧 Configuration change
- [ ] ♻️ Refactoring (no functional changes)
- [ ] 🧪 Test update

## Related Issues

<!-- Länka relaterade issues: Fixes #123, Relates to #456 -->

## Changes Made

<!-- Lista de viktigaste ändringarna -->

- 
- 
- 

## Testing

<!-- Beskriv hur ändringarna har testats -->

- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] Manual testing performed

### Test Instructions

<!-- Steg för att verifiera ändringarna -->

1. 
2. 
3. 

## Screenshots

<!-- Om UI-ändringar, lägg till före/efter screenshots -->

## Checklist

- [ ] My code follows the project's style guidelines
- [ ] I have performed a self-review of my code
- [ ] I have commented my code where necessary
- [ ] I have updated the documentation
- [ ] My changes generate no new warnings
- [ ] I have added tests that prove my fix/feature works
- [ ] New and existing unit tests pass locally
- [ ] Any dependent changes have been merged

## Additional Notes

<!-- Övrig information som reviewer bör veta -->
```

### 2. Skapa Issue templates (bonus)

Skapa `.github/ISSUE_TEMPLATE/bug_report.md`:

```markdown
---
name: Bug Report
about: Report a bug to help us improve
title: '[BUG] '
labels: bug
assignees: ''
---

## Bug Description

<!-- En tydlig beskrivning av buggen -->

## Steps to Reproduce

1. 
2. 
3. 

## Expected Behavior

<!-- Vad förväntade du dig skulle hända? -->

## Actual Behavior

<!-- Vad hände istället? -->

## Environment

- OS: 
- Node version: 
- Docker version: 
- Browser (if applicable): 

## Screenshots

<!-- Om tillämpligt -->

## Additional Context

<!-- Övrig relevant information -->
```

Skapa `.github/ISSUE_TEMPLATE/feature_request.md`:

```markdown
---
name: Feature Request
about: Suggest an idea for this project
title: '[FEATURE] '
labels: enhancement
assignees: ''
---

## Problem Statement

<!-- Vilket problem löser denna feature? -->

## Proposed Solution

<!-- Beskriv din föreslagna lösning -->

## Alternatives Considered

<!-- Vilka alternativ har du övervägt? -->

## Additional Context

<!-- Övrig relevant information, mockups, etc. -->
```

## Acceptanskriterier

- [ ] PR-template skapad
- [ ] Issue templates skapade
- [ ] Templates testas genom att skapa ny PR/issue

## Filer att skapa

- `.github/PULL_REQUEST_TEMPLATE.md` (ny)
- `.github/ISSUE_TEMPLATE/bug_report.md` (ny)
- `.github/ISSUE_TEMPLATE/feature_request.md` (ny)
