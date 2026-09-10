import { ContainerRunner, type RunOptions, type SidecarSpec } from '../runtime/index.js';

/**
 * A recording {@link ContainerRunner} for transfer tests: every call is
 * captured so tests can assert the seam was used (and which volume operations
 * ran) without a live Docker daemon.
 */
export class RecordingRunner implements ContainerRunner {
  calls: string[] = [];
  volumesCreated: string[] = [];
  copied: Array<{ source: string; target: string; wipe?: boolean }> = [];
  volumeExistsResult = true;

  async run(_image: string, _opts: RunOptions, _commandArgs: string[]): Promise<number> {
    this.calls.push('run');
    return 0;
  }
  createNetwork(_name: string): void {
    this.calls.push('createNetwork');
  }
  removeNetwork(_name: string): void {
    this.calls.push('removeNetwork');
  }
  startSidecar(_spec: SidecarSpec): void {
    this.calls.push('startSidecar');
  }
  removeContainer(_name: string): void {
    this.calls.push('removeContainer');
  }
  probeTcp(_network: string, _host: string, _port: number): boolean {
    this.calls.push('probeTcp');
    return true;
  }
  probeHealthcheck(_container: string, _command: string[]): boolean {
    this.calls.push('probeHealthcheck');
    return true;
  }
  isRunning(_name: string): boolean {
    this.calls.push('isRunning');
    return true;
  }
  volumeExists(_volumeName: string): boolean {
    this.calls.push('volumeExists');
    return this.volumeExistsResult;
  }
  createVolume(volumeName: string): void {
    this.calls.push('createVolume');
    this.volumesCreated.push(volumeName);
  }
  copyVolumeToDir(volumeName: string, hostDir: string): void {
    this.calls.push('copyVolumeToDir');
    this.copied.push({ source: volumeName, target: hostDir });
  }
  copyDirToVolume(hostDir: string, volumeName: string, wipe?: boolean): void {
    this.calls.push('copyDirToVolume');
    this.copied.push({ source: hostDir, target: volumeName, wipe });
  }
}