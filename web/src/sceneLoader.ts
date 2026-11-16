type World3d = typeof import('./world3d');

let scene: Promise<World3d> | null = null;

export function loadScene(): Promise<World3d> {
  scene ??= import('./world3d');
  return scene;
}
