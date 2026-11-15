import * as THREE from 'three';

export interface PartDef {
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
  shadow: boolean;
}

export class Instancer {
  readonly meshes: THREE.InstancedMesh[];
  private readonly base: Float32Array[];

  constructor(
    parts: PartDef[],
    readonly count: number,
    private readonly parent: THREE.Object3D,
  ) {
    this.base = parts.map(() => new Float32Array(count * 16));
    this.meshes = parts.map((p) => {
      const m = new THREE.InstancedMesh(p.geo, p.mat, count);
      m.castShadow = p.shadow;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      parent.add(m);
      return m;
    });
  }

  set(i: number, mats: THREE.Matrix4[]): void {
    for (let p = 0; p < this.meshes.length; p++) {
      const src = mats[p].elements;
      const dst = this.base[p];
      for (let k = 0; k < 16; k++) dst[i * 16 + k] = src[k];
    }
    this.show(i, true);
  }

  show(i: number, on: boolean): void {
    for (let p = 0; p < this.meshes.length; p++) {
      const dst = this.meshes[p].instanceMatrix.array as Float32Array;
      if (on) dst.set(this.base[p].subarray(i * 16, i * 16 + 16), i * 16);
      else dst.fill(0, i * 16, i * 16 + 16);
    }
  }

  flush(): void {
    for (const m of this.meshes) m.instanceMatrix.needsUpdate = true;
  }

  remove(): void {
    for (const m of this.meshes) this.parent.remove(m);
  }
}
