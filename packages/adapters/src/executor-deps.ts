import type {
  AgentContextStrategy,
  AgentHomeStore,
  AgentRuntime,
  ArtifactStore,
  AutoReviewProvider,
  BrowserProvider,
  ConnectorProvider,
  JobPublisher,
  ManagedConnectorProvider,
  MediaGenerationProvider,
  MemoryStore,
  NotificationProvider,
  SandboxProvider,
  SecretStore,
  WebProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import type { CloudAgentConnection } from "./cloud-agent-factory.js";
import type { McpStdioPolicy } from "./mcp-transport.js";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";
import type { CodexLiveCatalog } from "./pi-codex-catalog.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import type { RoleplayRuntime } from "./roleplay-runtime.js";
import type { TicketChangeNotifier } from "./ticket-changes.js";

export interface ExecutorDeps {
  /** Enable only after all API and worker processes have the dedicated roleplay runtime. */
  roleplayEnabled?: boolean;
  roleplayRuntime?: RoleplayRuntime;
  maxUploadSizeBytes?: number;
  contextStrategy?: AgentContextStrategy;
  prisma: PrismaClient;
  events: ThreadEvents;
  runtime: AgentRuntime;
  /** Optional native harnesses; the default runtime continues to serve Pi bots. */
  runtimes?: { codex?: AgentRuntime; claude?: AgentRuntime; acp?: AgentRuntime };
  sandbox: SandboxProvider;
  memory: MemoryStore;
  memoryProviders: MemoryProviderResolver;
  home: AgentHomeStore;
  artifacts?: ArtifactStore;
  connector?: ConnectorProvider;
  connectors?: {
    managed(id: string): ManagedConnectorProvider | undefined;
    managedProviders?(): ManagedConnectorProvider[];
  };
  secrets: string[];
  secretStore: SecretStore;
  billingEnabled?: boolean;
  deploymentModelKey?: string;
  /** The deployment default model can run; see resolveDeploymentModel. */
  deploymentModelConfigured?: boolean;
  dataDir?: string;
  notifications?: NotificationProvider;
  jobs: JobPublisher;
  /** Publishes board-change signals and wakes ticket owners; absent disables both. */
  onTicketChange?: TicketChangeNotifier;
  ticketBoardEnabled?: boolean;
  phoneCallsEnabled?: boolean;
  phoneCallCooldownMinutes?: number;
  phoneCallRingSeconds?: number;
  /** Messaging surface; absent means zero identity queries and no chat prompts. */
  messaging?: { hasIdentity(botId: string): Promise<boolean> };
  listConnectedPluginSlugs?: (userId: string) => Promise<string[]>;
  /** Builtin web_search / web_fetch. Defaults to keyless HTTP when omitted. */
  web?: WebProvider;
  mediaGeneration?: MediaGenerationProvider;
  /** Page browser (DOM refs) on the bot computer. Defaults to the sandbox live browser when supported. */
  browser?: BrowserProvider;
  secretHttp?: RemoteTransportDependencies;
  /** Allow RFC1918 / Docker-network MCP URLs when the operator enabled the escape. */
  mcpAllowPrivateEndpoint?: boolean;
  /** Which stdio MCP servers this deployment runs; absent runs none. */
  mcpStdio?: McpStdioPolicy;
  /** Remote cloud coding agents. Null/omit means tools stay uninjected. */
  cloudAgent?: CloudAgentConnection | null;
  /** Optional Auto Review verifier. When omitted, the factory selects from env (llm | jev | scripted). */
  autoReview?: AutoReviewProvider;
  /**
   * Live Codex model catalog; when present, a statically excluded Codex model
   * can still run for the OAuth account whose backend lists it.
   */
  codexCatalog?: CodexLiveCatalog;
  /** Aborted when createApp stop() begins so in-flight continueRun boot waits exit promptly. */
  shutdownSignal?: AbortSignal;
}
