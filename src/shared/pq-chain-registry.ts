// Policy-aware chain registry for non-EVM bridge/read integrations.
//
// This registry is intentionally separate from the EIP-1193 chain switcher.
// `src/background/networks.ts` owns active Monolythium/EVM-shaped networks;
// this file describes networks the wallet can reason about for bridge policy,
// read-only balance support, and institutional rails without implying native
// wallet signing support.

export type ChainFamily = "monolythium" | "near";
export type ChainEnvironment = "mainnet" | "testnet" | "devnet";
export type SignatureScheme = "ml-dsa-65" | "ed25519" | "secp256k1";
export type PqPosture = "native-pq" | "pq-attested" | "classical";
export type WalletMode = "native-signing" | "bridge-readonly" | "unsupported";
export type AddressFormat = "mono-hex" | "near-account-id";
export type MeshStatus = "native" | "operator-enabled" | "none";
export type BridgeRouteStatus = "planned" | "testnet" | "disabled";

export interface NativeCurrencyDescriptor {
  name: string;
  symbol: string;
  decimals: number;
}

export interface WalletCapabilities {
  readBalances: boolean;
  signTransactions: boolean;
  signMessages: boolean;
  connectDapps: boolean;
  bridgeRoutes: boolean;
}

export interface PolicyChainDescriptor {
  id: string;
  displayName: string;
  family: ChainFamily;
  environment: ChainEnvironment;
  rpcUrls: readonly string[];
  explorerUrls: readonly string[];
  nativeCurrency: NativeCurrencyDescriptor;
  addressFormat: AddressFormat;
  signatureSchemes: readonly SignatureScheme[];
  pqPosture: PqPosture;
  walletMode: WalletMode;
  capabilities: WalletCapabilities;
  mesh: {
    status: MeshStatus;
    blockchain: string;
    network: string;
  };
  warning?: string;
}

export interface BridgeAssetDescriptor {
  sourceAsset: string;
  wrappedAsset: string;
  destinationStandard: "nep141";
}

export interface BridgeRouteDescriptor {
  id: string;
  displayName: string;
  fromChainId: string;
  toChainId: string;
  environment: ChainEnvironment;
  status: BridgeRouteStatus;
  pqPosture: PqPosture;
  asset: BridgeAssetDescriptor;
  policyId: string;
  warning?: string;
}

export const POLICY_CHAINS: readonly PolicyChainDescriptor[] = [
  {
    id: "mono:testnet-69420",
    displayName: "Monolythium Testnet",
    family: "monolythium",
    environment: "testnet",
    rpcUrls: ["registry:monolythium/testnet-69420"],
    explorerUrls: [],
    nativeCurrency: { name: "Monolythium LYTH", symbol: "LYTH", decimals: 18 },
    addressFormat: "mono-hex",
    signatureSchemes: ["ml-dsa-65"],
    pqPosture: "native-pq",
    walletMode: "native-signing",
    capabilities: {
      readBalances: true,
      signTransactions: true,
      signMessages: true,
      connectDapps: true,
      bridgeRoutes: true,
    },
    mesh: {
      status: "native",
      blockchain: "Monolythium",
      network: "testnet",
    },
  },
  {
    id: "mono:mainnet-69422",
    displayName: "Monolythium Mainnet",
    family: "monolythium",
    environment: "mainnet",
    rpcUrls: ["registry:monolythium/mainnet-69422"],
    explorerUrls: [],
    nativeCurrency: { name: "Monolythium LYTH", symbol: "LYTH", decimals: 18 },
    addressFormat: "mono-hex",
    signatureSchemes: ["ml-dsa-65"],
    pqPosture: "native-pq",
    walletMode: "unsupported",
    capabilities: {
      readBalances: false,
      signTransactions: false,
      signMessages: false,
      connectDapps: false,
      bridgeRoutes: false,
    },
    mesh: {
      status: "native",
      blockchain: "Monolythium",
      network: "mainnet",
    },
    warning: "Reserved until mainnet launch.",
  },
  {
    id: "near:testnet",
    displayName: "NEAR Testnet",
    family: "near",
    environment: "testnet",
    rpcUrls: ["https://rpc.testnet.near.org"],
    explorerUrls: ["https://testnet.nearblocks.io"],
    nativeCurrency: { name: "NEAR", symbol: "NEAR", decimals: 24 },
    addressFormat: "near-account-id",
    signatureSchemes: ["ed25519", "secp256k1"],
    pqPosture: "pq-attested",
    walletMode: "bridge-readonly",
    capabilities: {
      readBalances: true,
      signTransactions: false,
      signMessages: false,
      connectDapps: false,
      bridgeRoutes: true,
    },
    mesh: {
      status: "operator-enabled",
      blockchain: "nearprotocol",
      network: "testnet",
    },
    warning:
      "Bridge route can carry PQ attestations, but native NEAR account keys are classical today.",
  },
  {
    id: "near:mainnet",
    displayName: "NEAR Mainnet",
    family: "near",
    environment: "mainnet",
    rpcUrls: ["https://rpc.mainnet.near.org"],
    explorerUrls: ["https://nearblocks.io"],
    nativeCurrency: { name: "NEAR", symbol: "NEAR", decimals: 24 },
    addressFormat: "near-account-id",
    signatureSchemes: ["ed25519", "secp256k1"],
    pqPosture: "classical",
    walletMode: "unsupported",
    capabilities: {
      readBalances: false,
      signTransactions: false,
      signMessages: false,
      connectDapps: false,
      bridgeRoutes: false,
    },
    mesh: {
      status: "operator-enabled",
      blockchain: "nearprotocol",
      network: "mainnet",
    },
    warning: "Disabled until contracts, route policy, and audits are complete.",
  },
];

export const BRIDGE_ROUTES: readonly BridgeRouteDescriptor[] = [
  {
    id: "mono-testnet-near-testnet-lyth-v1",
    displayName: "LYTH to NEAR Testnet",
    fromChainId: "mono:testnet-69420",
    toChainId: "near:testnet",
    environment: "testnet",
    status: "planned",
    pqPosture: "pq-attested",
    asset: {
      sourceAsset: "LYTH",
      wrappedAsset: "wLYTH.testnet",
      destinationStandard: "nep141",
    },
    policyId: "pq-bridge-policy:v1:testnet",
    warning:
      "Destination account control remains NEAR-native until NEAR supports a PQ account key path.",
  },
];

export function policyChainById(id: string): PolicyChainDescriptor | null {
  return POLICY_CHAINS.find((chain) => chain.id === id) ?? null;
}

export function bridgeRoutesForChain(id: string): readonly BridgeRouteDescriptor[] {
  return BRIDGE_ROUTES.filter(
    (route) => route.fromChainId === id || route.toChainId === id,
  );
}

