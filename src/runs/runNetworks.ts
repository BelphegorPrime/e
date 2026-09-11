import type { ContainerRunner } from '../runtime/index.js';

/** Clean seam for network management in runs. */
export interface NetworkManager {
  /** Create a private Docker network for sidecars. */
  createNetwork(name: string): Promise<void>;
  /** Remove a network and all its containers. */
  removeNetwork(name: string): Promise<void>;
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
}

/** Production alias for DockerNetworkManager. */
export const ProductionNetworkManager = DockerNetworkManager;
