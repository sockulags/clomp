# P3-04: Säkra nginx-konfiguration

**Prioritet:** 🟡 Medium  
**Kategori:** Säkerhet / Kvalitet  
**Tidsuppskattning:** 30 min

## Problem

Nginx-konfigurationen saknar säkerhetsheaders och best practices:
- Ingen X-Frame-Options
- Ingen Content-Security-Policy
- Ingen X-Content-Type-Options
- Ingen rate limiting
- Server version exponeras

## Nuvarande konfiguration

```nginx
server {
    listen 80;
    server_name localhost;
    root /usr/share/nginx/html;
    index index.html;
    # ... inga säkerhetsheaders
}
```

## Åtgärd

### Uppdatera web-ui/nginx.conf

```nginx
server {
    listen 80;
    server_name localhost;
    root /usr/share/nginx/html;
    index index.html;

    # Göm nginx version
    server_tokens off;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
    
    # Content Security Policy
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http://backend:3000;" always;

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

    # Cache static assets
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api {
        proxy_pass http://backend:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Timeout settings
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # Block access to hidden files
    location ~ /\. {
        deny all;
        return 404;
    }
}
```

## Acceptanskriterier

- [ ] Säkerhetsheaders tillagda
- [ ] Server version gömd
- [ ] Gzip aktiverat
- [ ] Cache headers för statiska filer
- [ ] Blockering av dolda filer

## Filer att ändra

- `web-ui/nginx.conf`

## Verifiering

```bash
# Starta containers
docker-compose up -d

# Kontrollera headers
curl -I http://localhost:8080

# Bör visa:
# X-Frame-Options: SAMEORIGIN
# X-Content-Type-Options: nosniff
# Content-Security-Policy: ...
```
