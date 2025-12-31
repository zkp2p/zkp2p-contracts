module.exports = {
  skipFiles: ['interfaces', 'mocks', 'external', 'archive'],
  configureYulOptimizer: true,
  mocha: {
    timeout: 200000,
  },
};
