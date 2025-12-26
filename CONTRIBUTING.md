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

5. Set up development database:
   ```bash
   cd backend && npm run setup:dev
   ```

6. Start development:
   ```bash
   docker-compose up -d
   ```

## Development Workflow

### Branch Naming

Use descriptive branch names with prefixes:

- `feat/description` - New features
- `fix/description` - Bug fixes
- `docs/description` - Documentation updates
- `refactor/description` - Code refactoring
- `test/description` - Test additions/changes
- `chore/description` - Maintenance tasks

### Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

**Examples:**
```
feat(auth): add JWT token validation
fix(logs): handle empty batch requests
docs(readme): update installation steps
chore(deps): update helmet to v7
```

### Code Style

- **Backend**: ESLint configured (`npm run lint`)
- Run linting before committing: `npm run lint`
- Fix auto-fixable issues: `npm run lint:fix`

### Testing

- Write tests for new features
- Ensure all tests pass: `npm test`
- Check coverage: `npm test -- --coverage`

## Pull Request Process

1. **Create a branch** from `main`
   ```bash
   git checkout -b feat/my-feature
   ```

2. **Make your changes** with tests

3. **Run checks locally**:
   ```bash
   cd backend
   npm run lint
   npm test
   ```

4. **Commit your changes** following commit conventions

5. **Push** to your fork:
   ```bash
   git push origin feat/my-feature
   ```

6. **Open a Pull Request** with:
   - Clear title following commit conventions
   - Description of changes
   - Link to related issues (if any)
   - Screenshots (if UI changes)

### PR Checklist

Before submitting, ensure:

- [ ] Code follows project style guidelines
- [ ] Self-review completed
- [ ] Tests added/updated for changes
- [ ] All tests pass locally
- [ ] Lint passes without errors
- [ ] Documentation updated if needed
- [ ] No secrets or sensitive data committed

## Reporting Issues

### Bug Reports

Please include:
- Clear title and description
- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Node version, Docker version)
- Relevant logs or screenshots

### Feature Requests

Please include:
- Use case description
- Proposed solution
- Alternatives considered
- Any relevant examples

## Code of Conduct

Be respectful and inclusive. We follow the [Contributor Covenant](https://www.contributor-covenant.org/).

## Questions?

- Check existing issues and discussions first
- Open a new issue for questions not covered elsewhere

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
