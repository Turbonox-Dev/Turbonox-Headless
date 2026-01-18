// Feature flags backend logic removed — provide lightweight no-op stubs to avoid runtime errors
module.exports = {
  resolveFlag: () => false,
  getAllResolved: () => ({}),
  setLocalOverride: () => ({}),
  getLocalOverrides: () => ({}),
  setRemoteFlags: () => ({}),
  getRemoteFlags: () => ({}),
  envFlags: () => ({}),
  stableBucket: () => 1,
};
