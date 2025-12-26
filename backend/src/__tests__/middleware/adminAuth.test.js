const { authenticateAdmin } = require('../../middleware/adminAuth');

describe('Admin Authentication Middleware', () => {
  let req, res, next;
  const originalEnv = process.env;

  beforeEach(() => {
    req = {
      headers: {}
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };
    next = jest.fn();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  test('should return 401 when API key is missing', async () => {
    process.env.ADMIN_API_KEY = 'test-admin-key';
    
    await authenticateAdmin(req, res, next);
    
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Missing API key' });
    expect(next).not.toHaveBeenCalled();
  });

  test('should return 500 when ADMIN_API_KEY is not configured', async () => {
    delete process.env.ADMIN_API_KEY;
    req.headers['x-api-key'] = 'some-key';
    
    await authenticateAdmin(req, res, next);
    
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Server configuration error' });
    expect(next).not.toHaveBeenCalled();
  });

  test('should return 401 when API key is invalid', async () => {
    process.env.ADMIN_API_KEY = 'correct-admin-key';
    req.headers['x-api-key'] = 'wrong-admin-key';
    
    await authenticateAdmin(req, res, next);
    
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid admin API key' });
    expect(next).not.toHaveBeenCalled();
  });

  test('should return 401 when API key has different length', async () => {
    process.env.ADMIN_API_KEY = 'correct-admin-key';
    req.headers['x-api-key'] = 'short';
    
    await authenticateAdmin(req, res, next);
    
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid admin API key' });
    expect(next).not.toHaveBeenCalled();
  });

  test('should call next() when API key is correct', async () => {
    process.env.ADMIN_API_KEY = 'correct-admin-key';
    req.headers['x-api-key'] = 'correct-admin-key';
    
    await authenticateAdmin(req, res, next);
    
    expect(next).toHaveBeenCalled();
    expect(req.isAdmin).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('should handle empty API key', async () => {
    process.env.ADMIN_API_KEY = 'correct-admin-key';
    req.headers['x-api-key'] = '';
    
    await authenticateAdmin(req, res, next);
    
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
