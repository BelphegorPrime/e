import { ContainerRuntime } from '.';

export class PodmanRuntime extends ContainerRuntime {
  readonly command = 'podman';
}
