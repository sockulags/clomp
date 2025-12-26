module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/**/__tests__/**',
    '!src/server.js' // Exclude server.js from coverage as it's hard to test
  ],
  coverageThreshold: {
    global: {
      branches: 40,
      functions: 25,
      lines: 35,
      statements: 35
    }
  }
};
