import type { ContainerRunner } from './runtime/index.js';

/** Clean seam for network management in runs. */
export interface NetworkManager {
  /** Create a private Docker network for sidecars. */
  createNetwork(name: string): Promise<void>;
  /** Remove a network and all its containers. */
  removeNetwork(name: string): Promise<void>;
  /** Check if a network exists and is usable. */
  networkExists(name: string): Promise<boolean>;
}

/** In-memory network manager for testing and development. */
export class InMemoryNetworkManager implements NetworkManager {
  private networks = new Set<string>();

  async createNetwork(name: string): Promise<void> {
    this.networks.add(name);
  }

  async removeNetwork(name: string): Promise<void> {
    this.networks.delete(name);
  }

  async networkExists(name: string): Promise<boolean> {
    return this.networks.has(name);
  }
}

/** Docker runtime network manager for production. */
export class DockerNetworkManager implements NetworkManager {
  constructor(private readonly runner: ContainerRunner) {}

  async createNetwork(name: string): Promise<void> {
    await this.runner.createNetwork(name);
  }

  async removeNetwork(name: string): Promise<void> {
    await this.runner.removeNetwork(name);
  }

  async networkExists(name: string): Promise<boolean> {
    return await this.runner.networkExists(name);
  }
}

/** Determines which networks to join based on run configuration. */
export function selectNetworks(
  sharedNetns: boolean,
  hasSidecars: boolean
): string[] | undefined {
  if (sharedNetns) return undefined;
  return hasSidecars ? ['run-network'] : undefined;
}