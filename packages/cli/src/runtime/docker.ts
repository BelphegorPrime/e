import { ContainerRuntime } from '.';

export class DockerRuntime extends ContainerRuntime {
  readonly command = 'docker';
}
