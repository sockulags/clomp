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

1. **Email us** with details about the vulnerability:
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

## Security Best Practices for Deployment

When deploying this application, follow these security guidelines:

### Required Configuration

1. **Always set `ADMIN_API_KEY`** to a strong, unique value
   ```bash
   # Generate a secure key
   openssl rand -hex 32
   ```

2. **Never use default API keys** in production

3. **Restrict `ALLOWED_ORIGINS`** to your specific domains
   ```env
   ALLOWED_ORIGINS=https://your-domain.com
   ```

### Recommended Configuration

4. **Use HTTPS** in production (configure reverse proxy or load balancer)

5. **Configure rate limiting** appropriate for your traffic
   ```env
   RATE_LIMIT_MAX=100
   RATE_LIMIT_WINDOW_MS=60000
   ```

6. **Keep dependencies updated**
   ```bash
   npm audit
   npm update
   ```

7. **Monitor logs** for suspicious activity

8. **Use container security**
   - Run containers as non-root (already configured in Dockerfile)
   - Use read-only file systems where possible
   - Limit container capabilities

### Known Security Considerations

- API keys are stored in plain text in the SQLite database
- SQLite database is not encrypted at rest
- Rate limiting should be tuned for your specific traffic patterns
- Log data may contain sensitive information - handle accordingly

## Security Features

This application includes:

- **Helmet.js** security headers
- **Rate limiting** on all endpoints
- **CORS** configuration
- **Input validation** on all API endpoints
- **Timing-safe** admin authentication
- **Request body size limits** (1MB)
- **Non-root** Docker containers
- **CSP headers** configured

## Dependency Security

We use:
- **Dependabot** for automated dependency updates
- **npm audit** in CI pipeline
- **CodeQL** for static analysis
- **Trivy** for container scanning
