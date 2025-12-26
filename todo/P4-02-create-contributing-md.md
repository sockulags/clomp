# P4-02: Skapa CONTRIBUTING.md

**Prioritet:** 🟢 Låg  
**Kategori:** Dokumentation  
**Tidsuppskattning:** 45 min

## Problem

Projektet saknar riktlinjer för bidragsgivare, vilket gör det svårare för nya utvecklare att bidra.

## Åtgärd

### Skapa CONTRIBUTING.md i root

```markdown
# Contributing to Loggplattform

Thank you for your interest in contributing! This document provides guidelines and instructions.

## Getting Started

### Prerequisites

- Node.js 20+
- Docker & Docker Compose
- Git

### Setup

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/loggplattform.git
   cd loggplattform
   ```

3. Install dependencies:
   ```bash
   cd backend && npm install
   cd ../web-ui && npm install
   ```

4. Copy environment file:
   ```bash
   cp .env.example .env
   ```

5. Start development:
   ```bash
   docker-compose up -d
   ```

## Development Workflow

### Branch Naming

- `feat/description` - New features
- `fix/description` - Bug fixes
- `docs/description` - Documentation
- `refactor/description` - Code refactoring
- `test/description` - Test additions/changes

### Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**Types:** feat, fix, docs, style, refactor, test, chore

**Examples:**
```
feat(auth): add JWT token validation
fix(logs): handle empty batch requests
docs(readme): update installation steps
```

### Code Style

- **Backend**: ESLint + Prettier
- **Frontend**: ESLint + Prettier
- Run `npm run lint` before committing

### Testing

- Write tests for new features
- Ensure all tests pass: `npm test`
- Maintain coverage above 80%

## Pull Request Process

1. **Create a branch** from `main`
2. **Make your changes** with tests
3. **Run checks**:
   ```bash
   npm run lint
   npm test
   ```
4. **Push** to your fork
5. **Open a PR** with:
   - Clear title following commit conventions
   - Description of changes
   - Link to related issues
   - Screenshots (if UI changes)

### PR Checklist

- [ ] Tests added/updated
- [ ] Documentation updated
- [ ] Lint passes
- [ ] All tests pass
- [ ] No secrets committed

## Reporting Issues

### Bug Reports

Include:
- Clear title and description
- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Node version, etc.)

### Feature Requests

Include:
- Use case description
- Proposed solution
- Alternatives considered

## Code of Conduct

Be respectful and inclusive. We follow the [Contributor Covenant](https://www.contributor-covenant.org/).

## Questions?

Open a [Discussion](https://github.com/ORG/loggplattform/discussions) for questions.
```

## Acceptanskriterier

- [ ] CONTRIBUTING.md skapad
- [ ] Länkar uppdaterade
- [ ] Länkad från README.md

## Filer att skapa/ändra

- `CONTRIBUTING.md` (ny)
- `README.md` (lägg till länk)
