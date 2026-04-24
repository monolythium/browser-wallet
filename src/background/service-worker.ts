// MV3 background service worker for Monolythium Wallet.
// TODO(monolythium-vision): wire EIP-1193 RPC handlers + keystore unlock here.
chrome.runtime.onInstalled.addListener(() => {
  console.log("Monolythium Wallet: service worker active");
});
