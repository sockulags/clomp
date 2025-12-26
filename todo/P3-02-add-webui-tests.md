# P3-02: Lägg till tester för Web-UI

**Prioritet:** 🟡 Medium  
**Kategori:** Kvalitet  
**Tidsuppskattning:** 2-3 timmar

## Problem

Web-UI saknar helt tester. Ingen testramverk är konfigurerat.

## Åtgärd

### 1. Installera testberoenden

```bash
cd web-ui
npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom @testing-library/user-event
```

### 2. Konfigurera Vitest

Skapa `web-ui/vitest.config.js`:

```javascript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['node_modules/', 'test/']
    }
  }
});
```

### 3. Skapa test setup

Skapa `web-ui/test/setup.js`:

```javascript
import '@testing-library/jest-dom';
```

### 4. Skapa tester

Skapa `web-ui/test/App.test.jsx`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import App from '../src/App';

vi.mock('axios');

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('renders header', () => {
    axios.get.mockResolvedValue({ data: { logs: [] } });
    render(<App />);
    expect(screen.getByText(/Loggplattform/i)).toBeInTheDocument();
  });

  it('displays logs from API', async () => {
    const mockLogs = [
      { id: '1', level: 'info', message: 'Test log', timestamp: new Date().toISOString() }
    ];
    axios.get.mockResolvedValue({ data: { logs: mockLogs } });
    
    render(<App />);
    
    await waitFor(() => {
      expect(screen.getByText('Test log')).toBeInTheDocument();
    });
  });

  it('shows error on invalid API key', async () => {
    axios.get.mockRejectedValue({ response: { status: 401 } });
    
    render(<App />);
    
    // Verifiera felhantering
  });
});
```

### 5. Lägg till npm scripts

```json
{
  "scripts": {
    "test": "vitest",
    "test:coverage": "vitest --coverage"
  }
}
```

### 6. Uppdatera CI

Lägg till web-ui test job i `.github/workflows/ci.yml`.

## Acceptanskriterier

- [ ] Vitest konfigurerat
- [ ] Minst 5 tester skrivna
- [ ] Coverage ≥ 70%
- [ ] CI inkluderar web-ui tester

## Filer att skapa/ändra

- `web-ui/package.json`
- `web-ui/vitest.config.js` (ny)
- `web-ui/test/setup.js` (ny)
- `web-ui/test/App.test.jsx` (ny)
- `.github/workflows/ci.yml`
