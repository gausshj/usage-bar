// ============================================================================
// src/connectors/registry.ts
// Registry and factory for connector instances
// ============================================================================

import type {
  Connector,
  ProviderName,
  AnyConnectorConfig,
  NormalizedRecord,
  UsageBucket,
  CostBucket,
} from './types.js';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Global registry mapping provider name → Connector class.
 * Connector classes register themselves via registerConnector().
 */
class ConnectorRegistry {
  private map = new Map<ProviderName, new (config: AnyConnectorConfig) => Connector>();

  register(name: ProviderName, ctor: new (config: AnyConnectorConfig) => Connector): void {
    if (this.map.has(name)) {
      throw new Error(`Connector for provider "${name}" is already registered`);
    }
    this.map.set(name, ctor);
  }

  get(name: ProviderName): new (config: AnyConnectorConfig) => Connector {
    const ctor = this.map.get(name);
    if (!ctor) {
      const available = Array.from(this.map.keys()).join(', ');
      throw new Error(
        `No connector registered for provider "${name}". Available: ${available}`,
      );
    }
    return ctor;
  }

  has(name: ProviderName): boolean {
    return this.map.has(name);
  }

  registeredProviders(): ProviderName[] {
    return Array.from(this.map.keys()) as ProviderName[];
  }
}

/** Singleton registry instance. */
export const registry = new ConnectorRegistry();

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface ConnectorFactory {
  /**
   * Create a connector instance for the given provider and config.
   */
  create(provider: ProviderName, config: AnyConnectorConfig): Connector;

  /**
   * Fetch and normalize usage records from a specific provider.
   * Convenience shortcut for create().fetchUsage() + normalize.
   */
  fetchNormalized(
    provider: ProviderName,
    config: AnyConnectorConfig,
    startTime: number,
    endTime: number,
  ): Promise<NormalizedRecord[]>;

  /**
   * Fetch usage + cost buckets without normalizing.
   * Returns raw buckets for advanced use cases.
   */
  fetchBuckets(
    provider: ProviderName,
    config: AnyConnectorConfig,
    startTime: number,
    endTime: number,
  ): Promise<{ usage: UsageBucket[]; costs: CostBucket[] }>;

  /**
   * List all registered provider names.
   */
  availableProviders(): ProviderName[];

  /**
   * Check if a provider is registered.
   */
  isRegistered(name: ProviderName): boolean;
}

class ConnectorFactoryImpl implements ConnectorFactory {
  create(provider: ProviderName, config: AnyConnectorConfig): Connector {
    const ctor = registry.get(provider);
    return new ctor(config);
  }

  async fetchNormalized(
    provider: ProviderName,
    config: AnyConnectorConfig,
    startTime: number,
    endTime: number,
  ): Promise<NormalizedRecord[]> {
    const conn = this.create(provider, config);
    const [usage, costs] = await Promise.all([
      conn.fetchUsage(startTime, endTime),
      conn.fetchCosts(startTime, endTime),
    ]);
    return conn.normalizeUsageAndCosts(usage, costs);
  }

  async fetchBuckets(
    provider: ProviderName,
    config: AnyConnectorConfig,
    startTime: number,
    endTime: number,
  ): Promise<{ usage: UsageBucket[]; costs: CostBucket[] }> {
    const conn = this.create(provider, config);
    const [usage, costs] = await Promise.all([
      conn.fetchUsage(startTime, endTime),
      conn.fetchCosts(startTime, endTime),
    ]);
    return { usage, costs };
  }

  availableProviders(): ProviderName[] {
    return registry.registeredProviders();
  }

  isRegistered(name: ProviderName): boolean {
    return registry.has(name);
  }
}

/** Singleton factory instance. */
export const factory = new ConnectorFactoryImpl();

// ---------------------------------------------------------------------------
// Registration helpers
// ---------------------------------------------------------------------------

/**
 * Register a connector class under its provider name.
 * Called by each connector file on import.
 */
export function registerConnector(
  name: ProviderName,
  ctor: new (config: AnyConnectorConfig) => Connector,
): void {
  registry.register(name, ctor);
}
